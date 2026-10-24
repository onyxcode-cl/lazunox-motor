import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { activo, archivo, cargar, guardar, olvidar, persistible } from "../../src/permission/siempre-disco"
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
