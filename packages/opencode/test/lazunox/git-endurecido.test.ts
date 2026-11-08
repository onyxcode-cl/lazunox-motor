// Lazunox lazunox.15 (ronda 2): entorno de git endurecido del shell del agente (repositorio desnudo falso + core.fsmonitor).
import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { endurecer, activo } from "../../src/tool/git-endurecido"

const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv) => spawnSync("git", args, { cwd, env, encoding: "utf-8" })
const base = (): NodeJS.ProcessEnv => {
  const e = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } as NodeJS.ProcessEnv
  for (const k of Object.keys(e)) if (k.startsWith("GIT_CONFIG_KEY_") || k.startsWith("GIT_CONFIG_VALUE_") || k === "GIT_CONFIG_COUNT") delete e[k]
  return e
}

describe("git endurecido (puro)", () => {
  test("añade safe.bareRepository=explicit y core.fsmonitor=false, sin tocar core.hooksPath", () => {
    const e = endurecer({ PATH: "/bin" })
    expect(e.GIT_CONFIG_COUNT).toBe("2")
    expect(e.GIT_CONFIG_KEY_0).toBe("safe.bareRepository")
    expect(e.GIT_CONFIG_VALUE_0).toBe("explicit")
    expect(e.GIT_CONFIG_KEY_1).toBe("core.fsmonitor")
    expect(e.GIT_CONFIG_VALUE_1).toBe("false")
    expect(Object.values(e)).not.toContain("core.hooksPath")
    expect(e.PATH).toBe("/bin")
  })
  test("se suma a un GIT_CONFIG_COUNT que ya existía (no lo pisa)", () => {
    const e = endurecer({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "x" })
    expect(e.GIT_CONFIG_COUNT).toBe("3")
    expect(e.GIT_CONFIG_KEY_0).toBe("user.name")
    expect(e.GIT_CONFIG_KEY_1).toBe("safe.bareRepository")
    expect(e.GIT_CONFIG_KEY_2).toBe("core.fsmonitor")
    expect(endurecer({ GIT_CONFIG_COUNT: "basura" }).GIT_CONFIG_COUNT).toBe("2")
  })
  test("LAZUNOX_GIT_ENDURECIDO=0 lo apaga", () => {
    expect(activo({} as NodeJS.ProcessEnv)).toBe(true)
    const antes = process.env.LAZUNOX_GIT_ENDURECIDO
    process.env.LAZUNOX_GIT_ENDURECIDO = "0"
    try {
      expect(endurecer({ A: "1" })).toEqual({ A: "1" })
    } finally {
      if (antes === undefined) delete process.env.LAZUNOX_GIT_ENDURECIDO
      else process.env.LAZUNOX_GIT_ENDURECIDO = antes
    }
  })
})

describe("git endurecido (con git real)", () => {
  const hay = spawnSync("git", ["--version"]).status === 0
  const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lzx-git-")))
  // repositorio «desnudo» falso: sin carpeta .git, con core.fsmonitor que escribe una marca
  const falso = (dir: string) => {
    const marca = path.join(dir, "PWNED")
    fs.writeFileSync(path.join(dir, "HEAD"), "ref: refs/heads/main\n")
    fs.writeFileSync(
      path.join(dir, "config"),
      `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = .\n\tfsmonitor = "touch ${marca}; echo"\n`,
    )
    fs.mkdirSync(path.join(dir, "objects"))
    fs.mkdirSync(path.join(dir, "refs"))
    return marca
  }

  test.skipIf(!hay)("el exploit del informe ejecuta con el entorno normal y YA NO con el endurecido", () => {
    const a = tmp()
    const marcaA = falso(a)
    git(a, ["status"], base())
    // si esta versión de git ya no cae en el engaño por defecto, la prueba no demuestra nada: se anota pero no falla
    const caeSinEndurecer = fs.existsSync(marcaA)

    const b = tmp()
    const marcaB = falso(b)
    git(b, ["status"], endurecer(base()))
    expect(fs.existsSync(marcaB)).toBe(false)
    console.log(`[git-endurecido] sin endurecer ejecuta el comando: ${caeSinEndurecer}`)
    fs.rmSync(a, { recursive: true, force: true })
    fs.rmSync(b, { recursive: true, force: true })
  })

  // Escenario que `core.fsmonitor=false` por sí solo NO neutraliza: `diff.external` en un desnudo falso con `git diff`.
  // Si alguien quita `safe.bareRepository=explicit`, esta prueba se pone en rojo.
  test.skipIf(!hay)("desnudo falso con diff.external: ni con git diff se ejecuta; y fsmonitor=false SOLO no basta", () => {
    const falsoDiff = (dir: string) => {
      const marca = path.join(dir, "PWN_DIFF")
      fs.writeFileSync(path.join(dir, "HEAD"), "ref: refs/heads/main\n")
      fs.writeFileSync(path.join(dir, "config"), `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\n[diff]\n\texternal = touch ${marca}; echo\n`)
      fs.mkdirSync(path.join(dir, "objects"))
      fs.mkdirSync(path.join(dir, "refs"))
      fs.writeFileSync(path.join(dir, "a"), "a\n")
      fs.writeFileSync(path.join(dir, "b"), "b\n")
      return marca
    }
    const corre = (env: NodeJS.ProcessEnv) => {
      const d = tmp()
      const marca = falsoDiff(d)
      git(d, ["diff", "--no-index", "a", "b"], env)
      const ejecuto = fs.existsSync(marca)
      fs.rmSync(d, { recursive: true, force: true })
      return ejecuto
    }
    const soloFsmonitor = { ...base(), GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "false" }
    // git con safe.bareRepository (>= 2.38): sin él ejecuta y con fsmonitor=false solo también
    const vulnerable = corre(base())
    if (vulnerable) expect(corre(soloFsmonitor)).toBe(true)
    expect(corre(endurecer(base()))).toBe(false)
  })

  test.skipIf(!hay)("también dentro de un repositorio real (sub/ falso) y un fsmonitor del .git/config real", () => {
    const r = tmp()
    const env = endurecer(base())
    git(r, ["init", "-q", "-b", "main"], env)
    fs.mkdirSync(path.join(r, "sub"))
    const marca = falso(path.join(r, "sub"))
    git(path.join(r, "sub"), ["status"], env)
    expect(fs.existsSync(marca)).toBe(false)
    // fsmonitor en el config REAL del repo: tampoco corre
    const marca2 = path.join(r, "PWN2")
    git(r, ["config", "core.fsmonitor", `touch ${marca2}; echo`], base())
    git(r, ["status"], env)
    expect(fs.existsSync(marca2)).toBe(false)
    fs.rmSync(r, { recursive: true, force: true })
  })

  test.skipIf(!hay)("git status, add y commit normales siguen funcionando, y un hook legítimo sigue corriendo", () => {
    const r = tmp()
    const env = { ...endurecer(base()), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }
    expect(git(r, ["init", "-q", "-b", "main"], env).status).toBe(0)
    const marcaHook = path.join(r, "HOOK-CORRIO")
    fs.writeFileSync(path.join(r, ".git/hooks/pre-commit"), `#!/bin/sh\ntouch "${marcaHook}"\n`, { mode: 0o755 })
    fs.writeFileSync(path.join(r, "a.txt"), "hola\n")
    expect(git(r, ["status", "--short"], env).stdout).toContain("a.txt")
    expect(git(r, ["add", "a.txt"], env).status).toBe(0)
    const c = git(r, ["commit", "-q", "-m", "uno"], env)
    expect(c.status).toBe(0)
    expect(fs.existsSync(marcaHook)).toBe(true) // core.hooksPath intacto: los hooks del usuario siguen
    expect(git(r, ["log", "--oneline"], env).stdout).toContain("uno")
    fs.rmSync(r, { recursive: true, force: true })
  })
})
