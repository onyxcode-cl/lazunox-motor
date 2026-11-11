// Lazunox (motor-18, B): piezas del git seguro del motor (sin lanzar git salvo donde se indica).
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import * as GitSeguro from "@opencode-ai/core/git-seguro"

const antes = { ...process.env }
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in antes)) delete process.env[k]
  Object.assign(process.env, antes)
  GitSeguro._reiniciarCache()
})

describe("git seguro", () => {
  test("entorno: sin GIT_* heredados (salvo autor/committer), sin config de sistema ni global, sin secretos del motor", () => {
    Object.assign(process.env, {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: "x",
      GIT_CONFIG_PARAMETERS: "'core.hooksPath'='x'",
      GIT_EXTERNAL_DIFF: "x",
      GIT_DIR: "/x",
      GIT_ATTR_SOURCE: "HEAD",
      GIT_AUTHOR_NAME: "Lazunox",
      GIT_CONFIG_GLOBAL: "/tmp/privada/gitconfig",
      LAZUNOX_CENTINELA: "x",
    })
    const e = GitSeguro.entorno({ GIT_INDEX_FILE: "/tmp/i" })
    expect(Object.values(e)).not.toContain("x") // el GIT_CONFIG_* heredado no sobrevive (se reemplaza por el propio)
    for (const k of ["GIT_CONFIG_PARAMETERS", "GIT_EXTERNAL_DIFF", "GIT_DIR", "GIT_ATTR_SOURCE", "LAZUNOX_CENTINELA"])
      expect(e[k]).toBeUndefined()
    expect(e).toMatchObject({
      GIT_AUTHOR_NAME: "Lazunox",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_INDEX_FILE: "/tmp/i",
    })
    expect(e.PATH).toBe(process.env.PATH!)
    expect(GitSeguro.entorno(undefined, { conGlobal: true }).GIT_CONFIG_GLOBAL).toBe("/tmp/privada/gitconfig")
  })
  test("G: segunda capa por entorno (GIT_CONFIG_COUNT) y config de sistema aislada; en red se conservan credenciales", () => {
    const e = GitSeguro.entorno()
    expect(e.GIT_CONFIG_SYSTEM).toBe("/dev/null")
    expect(e.GCM_INTERACTIVE).toBe("never")
    const pares = Array.from({ length: Number(e.GIT_CONFIG_COUNT) }, (_, i) => [e[`GIT_CONFIG_KEY_${i}`], e[`GIT_CONFIG_VALUE_${i}`]])
    expect(pares).toContainEqual(["core.hooksPath", "/dev/null"])
    expect(pares).toContainEqual(["core.fsmonitor", "false"])
    expect(pares).toContainEqual(["credential.helper", ""])
    const red = GitSeguro.entorno(undefined, { conGlobal: true })
    const paresRed = Array.from({ length: Number(red.GIT_CONFIG_COUNT) }, (_, i) => red[`GIT_CONFIG_KEY_${i}`])
    expect(paresRed).not.toContain("credential.helper")
    expect(paresRed).toContain("core.hooksPath")
  })
  test("opciones -c: ganchos, fsmonitor, atributos globales y diff externo; attr.tree solo en el repositorio propio", () => {
    process.env.GIT_CONFIG_GLOBAL = "/dev/null"
    const c = GitSeguro.config()
    for (const x of ["core.hooksPath=/dev/null", "core.fsmonitor=false", "core.attributesFile=/dev/null", "diff.external="]) expect(c).toContain(x)
    expect(c.some((x) => x.startsWith("attr.tree="))).toBe(false)
    expect(GitSeguro.config({ propio: true })).toContain(`attr.tree=${GitSeguro.ARBOL_VACIO}`)
  })
  test("blindar: --no-ext-diff --no-textconv después del subcomando de diff, sin duplicar", () => {
    expect(GitSeguro.blindar(["-c", "a=b", "--git-dir", "/g", "diff", "--name-only"])).toEqual([
      "-c", "a=b", "--git-dir", "/g", "diff", "--no-ext-diff", "--no-textconv", "--name-only",
    ])
    expect(GitSeguro.blindar(["diff", "--no-ext-diff", "x"])).toEqual(["diff", "--no-textconv", "--no-ext-diff", "x"])
    expect(GitSeguro.blindar(["show", "HEAD:a"])).toEqual(["show", "--no-ext-diff", "--no-textconv", "HEAD:a"])
    expect(GitSeguro.blindar(["status", "--porcelain"])).toEqual(["status", "--porcelain"])
    expect(GitSeguro.subcomando(["--no-optional-locks", "-C", "/x", "status"])).toBe("status")
  })
  test("anularFiltros: cada filtro de la config queda vacío (también con puntos en el nombre)", () => {
    expect(GitSeguro.anularFiltros("filter.lfs.clean\0filter.lfs.process\0filter.a.b.smudge\0")).toEqual([
      "-c", "filter.lfs.clean=", "-c", "filter.lfs.smudge=", "-c", "filter.lfs.process=", "-c", "filter.lfs.required=false",
      "-c", "filter.a.b.clean=", "-c", "filter.a.b.smudge=", "-c", "filter.a.b.process=", "-c", "filter.a.b.required=false",
    ])
    expect(GitSeguro.anularFiltros("")).toEqual([])
  })
  test("apagado (LAZUNOX_GIT_SEGURO=0): nada de lo anterior", () => {
    process.env.LAZUNOX_GIT_SEGURO = "0"
    expect(GitSeguro.config({ propio: true })).toEqual([])
    expect(GitSeguro.blindar(["diff"])).toEqual(["diff"])
    expect(GitSeguro.entorno().GIT_CONFIG_GLOBAL).toBe(process.env.GIT_CONFIG_GLOBAL as string)
  })
  test("sanearRepoPropio: impone la config canónica, quita info/attributes, commondir y un enlace en lugar de la config", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "lzx-m18-gs-"))
    const gitdir = path.join(d, "g")
    fs.mkdirSync(path.join(gitdir, "info"), { recursive: true })
    fs.writeFileSync(path.join(gitdir, "HEAD"), "ref: refs/heads/main\n")
    const fuera = path.join(d, "fuera.cfg")
    fs.writeFileSync(fuera, '[filter "x"]\n\tclean = algo\n')
    fs.symlinkSync(fuera, path.join(gitdir, "config"))
    fs.writeFileSync(path.join(gitdir, "info", "attributes"), "* filter=x\n")
    fs.writeFileSync(path.join(gitdir, "commondir"), "..\n")
    GitSeguro.sanearRepoPropio(gitdir, "linux")
    expect(fs.lstatSync(path.join(gitdir, "config")).isFile()).toBe(true)
    expect(fs.readFileSync(path.join(gitdir, "config"), "utf8")).toBe(GitSeguro.configPropia("linux", fs.existsSync(path.join(gitdir, "head"))))
    expect(fs.readFileSync(fuera, "utf8")).toContain("clean = algo") // el destino del enlace no se toca
    expect(fs.existsSync(path.join(gitdir, "info", "attributes"))).toBe(false)
    expect(fs.existsSync(path.join(gitdir, "commondir"))).toBe(false)
    fs.rmSync(d, { recursive: true, force: true })
  })
  test("excludesGlobal: lee core.excludesFile de la config global (con git real)", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "lzx-m18-gx-"))
    fs.writeFileSync(path.join(d, "gitconfig"), `[core]\n\texcludesFile = ${d}/ignorar\n`)
    process.env.GIT_CONFIG_GLOBAL = path.join(d, "gitconfig")
    GitSeguro._reiniciarCache()
    expect(GitSeguro.excludesGlobal()).toBe(`${d}/ignorar`)
    expect(GitSeguro.config()).toContain(`core.excludesFile=${d}/ignorar`)
    fs.rmSync(d, { recursive: true, force: true })
  })
})
