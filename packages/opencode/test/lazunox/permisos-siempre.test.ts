import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { activo, archivo, cargar, dir, guardar, leer, olvidar, persistible } from "../../src/permission/siempre-disco"
import { evaluate } from "../../src/permission"

const ON = { LAZUNOX_PERMISSION_PERSIST: "1" } as NodeJS.ProcessEnv
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lzx-perm-"))

describe("permisos «siempre» en disco", () => {
  test("apagado por defecto: no guarda ni carga", () => {
    const base = tmp()
    expect(activo({} as NodeJS.ProcessEnv)).toBe(false)
    guardar("/p", [{ permission: "bash", pattern: "git status *" }], base, {} as NodeJS.ProcessEnv)
    expect(fs.readdirSync(base)).toEqual([])
    expect(cargar("/p", base, {} as NodeJS.ProcessEnv)).toEqual([])
  })
  test("guarda y recarga por carpeta, sin duplicar", () => {
    const base = tmp()
    const r = { permission: "bash", pattern: "git status *" }
    guardar("/p", [r, r], base, ON)
    guardar("/p", [r], base, ON)
    expect(cargar("/p", base, ON)).toEqual([r])
    expect(cargar("/otra", base, ON)).toEqual([])
    expect((fs.statSync(archivo("/p", base)).mode & 0o777).toString(8)).toBe("600")
  })
  test("nunca guarda el comodín suelto, lo excluido ni patrones raros", () => {
    const base = tmp()
    for (const r of [
      { permission: "bash", pattern: "*" },
      { permission: "edit", pattern: " * " },
      { permission: "external_directory", pattern: "/etc/*" },
      { permission: "doom_loop", pattern: "x" },
      { permission: "bash", pattern: "a\nb" },
      { permission: "bash", pattern: "" },
      { permission: "bash", pattern: "x".repeat(501) },
    ])
      expect(persistible(r, ON)).toBe(false)
    // Un conector sí puede guardar «esta herramienta, cualquier argumento»; una herramienta propia no.
    expect(persistible({ permission: "context7_query-docs", pattern: "*" }, ON)).toBe(true)
    expect(persistible({ permission: "context7_query-docs", pattern: "*" }, { ...ON, LAZUNOX_PERMISSION_NO_PERSIST: "context7_query-docs" })).toBe(false)
    expect(persistible({ permission: "mcp_peligro", pattern: "x" }, { ...ON, LAZUNOX_PERMISSION_NO_PERSIST: "mcp_peligro" })).toBe(false)
    guardar("/p", [{ permission: "bash", pattern: "*" }], base, ON)
    expect(cargar("/p", base, ON)).toEqual([])
  })
  test("un archivo roto, ajeno o manipulado se ignora y las reglas no persistibles se descartan al cargar", () => {
    const base = tmp()
    fs.writeFileSync(archivo("/p", base), "{no es json")
    expect(cargar("/p", base, ON)).toEqual([])
    fs.writeFileSync(archivo("/p", base), JSON.stringify({ directory: "/q", rules: [{ permission: "bash", pattern: "ls" }] }))
    expect(cargar("/p", base, ON)).toEqual([])
    fs.writeFileSync(
      archivo("/p", base),
      JSON.stringify({ directory: "/p", rules: [{ permission: "bash", pattern: "*" }, { permission: "bash", pattern: "ls *" }, 7, null] }),
    )
    expect(cargar("/p", base, ON)).toEqual([{ permission: "bash", pattern: "ls *" }])
  })
  test("la exclusión admite «*» al final y la carpeta se puede fijar con una ruta absoluta", () => {
    const env = { ...ON, LAZUNOX_PERMISSION_NO_PERSIST: "computer_*,x_secreto" }
    expect(persistible({ permission: "computer_click", pattern: "*" }, env)).toBe(false)
    expect(persistible({ permission: "x_secreto", pattern: "a" }, env)).toBe(false)
    expect(persistible({ permission: "x_otro", pattern: "a" }, env)).toBe(true)
    expect(dir({ LAZUNOX_PERMISSION_DIR: "/tmp/permisos" } as NodeJS.ProcessEnv)).toBe("/tmp/permisos")
    expect(dir({ LAZUNOX_PERMISSION_DIR: "relativa" } as NodeJS.ProcessEnv)).not.toBe("relativa")
  })
  test("olvidar revoca todo", () => {
    const base = tmp()
    guardar("/p", [{ permission: "bash", pattern: "ls *" }], base, ON)
    olvidar("/p", base)
    expect(cargar("/p", base, ON)).toEqual([])
  })
})

describe("evaluate: orden de reglas", () => {
  test("el último que coincide gana (la base del arreglo de «deny» en ask)", () => {
    const deny = { permission: "bash", pattern: "rm *", action: "deny" as const }
    const allow = { permission: "bash", pattern: "rm *", action: "allow" as const }
    expect(evaluate("bash", "rm -rf x", [deny]).action).toBe("deny")
    expect(evaluate("bash", "rm -rf x", [deny], [allow]).action).toBe("allow")
  })
})

// Lazunox (motor-18, C): patrones que equivalen a «todo», nombres con comodines y lectura sin enlaces.
describe("permisos «siempre»: endurecimiento (motor-18)", () => {
  test("rechaza patrones de solo comodines y espacios; el `*` exacto solo para la herramienta de un conector", () => {
    for (const pattern of ["*", "**", "?*", "*?", "* *", " ** ", "?", "*\t*"])
      expect([pattern, persistible({ permission: "bash", pattern }, ON)]).toEqual([pattern, false])
    for (const pattern of ["**", "?*", "* *"])
      expect([pattern, persistible({ permission: "context7_query-docs", pattern }, ON)]).toEqual([pattern, false])
    expect(persistible({ permission: "context7_query-docs", pattern: "*" }, ON)).toBe(true)
    // Algo que no es herramienta propia ni de conector (sin «servidor_herramienta») tampoco guarda «*».
    expect(persistible({ permission: "cuaderno", pattern: "*" }, ON)).toBe(false)
    // Lo estrecho sigue valiendo.
    expect(persistible({ permission: "bash", pattern: "git status *" }, ON)).toBe(true)
    expect(persistible({ permission: "read", pattern: "/p/*.md" }, ON)).toBe(true)
  })
  test("rechaza nombres de permiso con comodines o espacios", () => {
    for (const permission of ["*", "bas?", "b*", "context7_*", "bash ", "a b"])
      expect([permission, persistible({ permission, pattern: "ls" }, ON)]).toEqual([permission, false])
  })
  test("al cargar, lo plantado amplio se descarta y lo estrecho queda", () => {
    const base = tmp()
    fs.writeFileSync(
      archivo("/p", base),
      JSON.stringify({
        directory: "/p",
        rules: [
          { permission: "bash", pattern: "?*" },
          { permission: "*", pattern: "*" },
          { permission: "bas?", pattern: "ls" },
          { permission: "bash", pattern: "* *" },
          { permission: "bash", pattern: "ls *" },
        ],
      }),
    )
    expect(cargar("/p", base, ON)).toEqual([{ permission: "bash", pattern: "ls *" }])
    expect(leer("/p", base, ON).ignoradas).toBe(4)
  })
  test("no sigue enlaces: un <huella>.json que apunta a otro archivo no se carga", () => {
    if (process.platform === "win32") return
    const base = tmp()
    const fuera = path.join(tmp(), "plantado.json")
    fs.writeFileSync(fuera, JSON.stringify({ directory: "/p", rules: [{ permission: "bash", pattern: "rm *" }] }))
    fs.symlinkSync(fuera, archivo("/p", base))
    expect(cargar("/p", base, ON)).toEqual([])
    expect(leer("/p", base, ON).estado).toBe("ausente")
  })
  test("solo archivos regulares: una carpeta o un FIFO con ese nombre no se lee (ni se queda esperando)", () => {
    const base = tmp()
    fs.mkdirSync(archivo("/p", base))
    expect(cargar("/p", base, ON)).toEqual([])
    if (process.platform === "win32") return
    const base2 = tmp()
    const r = Bun.spawnSync({ cmd: ["mkfifo", archivo("/p", base2)] })
    if (r.exitCode !== 0) return
    expect(cargar("/p", base2, ON)).toEqual([])
  })
  test("LAZUNOX_PERMISSION_PERSIST=0 (o ausente): ni carga ni guarda aunque el archivo exista", () => {
    const base = tmp()
    guardar("/p", [{ permission: "bash", pattern: "ls *" }], base, ON)
    expect(cargar("/p", base, ON)).toEqual([{ permission: "bash", pattern: "ls *" }])
    const OFF = { LAZUNOX_PERMISSION_PERSIST: "0" } as NodeJS.ProcessEnv
    expect(activo(OFF)).toBe(false)
    expect(cargar("/p", base, OFF)).toEqual([])
    guardar("/p", [{ permission: "bash", pattern: "pwd" }], base, OFF)
    expect(cargar("/p", base, ON)).toEqual([{ permission: "bash", pattern: "ls *" }])
  })
})


describe("permisos de bash: lanzadores y composición", () => {
  const unsafe = [
    "bash -c *", "sh -c *", "zsh -c *", "bash -lc *", "env *", "xargs *", "sudo *", "eval *", "exec *",
    "nohup *", "time *", "python *", "python3 *", "node *", "bun *", "deno *", "ruby *", "perl *", "php *",
    "osascript *", "git", "npm", "npx", "pnpm", "yarn", "docker *", "kubectl *", "ssh *", "git *",
    " '/usr/bin/bash'   '-c' *", "b''ash -c *", "ls | cat", "ls > salida", "echo $(id)", "echo `id`", "ls; id",
  ]
  test("rechaza cada prefijo genérico y sintaxis compuesta, conserva órdenes concretas", () => {
    for (const pattern of unsafe) expect([pattern, persistible({ permission: "bash", pattern }, ON)]).toEqual([pattern, false])
    for (const pattern of ["git status *", "npm test", "ls *.txt"])
      expect([pattern, persistible({ permission: "bash", pattern }, ON)]).toEqual([pattern, true])
  })
  test("ni guarda ni carga patrones inseguros ya plantados", () => {
    const base = tmp()
    const rules = unsafe.map((pattern) => ({ permission: "bash", pattern }))
    guardar("/p", rules, base, ON)
    expect(cargar("/p", base, ON)).toEqual([])
    fs.writeFileSync(archivo("/p", base), JSON.stringify({ directory: "/p", rules: [...rules, { permission: "bash", pattern: "git status *" }] }))
    expect(cargar("/p", base, ON)).toEqual([{ permission: "bash", pattern: "git status *" }])
  })
})
