import { describe, expect, test } from "bun:test"
import { AhorroTokens } from "../../src/tool/ahorro-tokens"
import { ShellPrompt } from "../../src/tool/shell/prompt"
import { ToolSearch } from "../../src/tool/tool-search"

const limits = { maxLines: 2000, maxBytes: 51200 }

describe("LAZUNOX_AHORRO_TOKENS", () => {
  test("ausente o desconocida = ningún recorte", () => {
    expect(AhorroTokens.recortesActivos({}).size).toBe(0)
    expect(AhorroTokens.recortesActivos({ LAZUNOX_AHORRO_TOKENS: "xyz" }).size).toBe(0)
    expect(AhorroTokens.recortesActivos({ LAZUNOX_AHORRO_TOKENS: "off" }).size).toBe(0)
  })
  test("on = todos; lista = solo los nombrados", () => {
    expect(AhorroTokens.recortesActivos({ LAZUNOX_AHORRO_TOKENS: "on" }).size).toBe(AhorroTokens.RECORTES.length)
    const s = AhorroTokens.recortesActivos({ LAZUNOX_AHORRO_TOKENS: "bash, task,nada" })
    expect([...s].sort()).toEqual(["bash", "task"])
  })
  test("la búsqueda diferida pasa a auto solo con el recorte, y la variable explícita manda", () => {
    expect(ToolSearch.config({}).mode).toBe("off")
    expect(ToolSearch.config({ LAZUNOX_AHORRO_TOKENS: "busqueda" }).mode).toBe("auto")
    expect(ToolSearch.config({ LAZUNOX_AHORRO_TOKENS: "on", LAZUNOX_TOOL_SEARCH: "off" }).mode).toBe("off")
  })
})

describe("descripción compacta del shell", () => {
  const largo = ShellPrompt.render("bash", "linux", limits, 120000).description
  const corto = ShellPrompt.renderCompacto("bash", "linux", limits, 120000)
  test("es bastante más corta", () => {
    expect(corto.length).toBeLessThan(largo.length * 0.6)
  })
  test("conserva las reglas que importan", () => {
    for (const t of ["workdir", "120000ms", "2000 lines", "51200 bytes", "explicitly requested", "force-push", "skip hooks", "NEW commit", "Glob", "Grep", "Read"])
      expect(corto).toContain(t)
  })
  test("PowerShell y cmd conservan su guía de encadenado", () => {
    expect(ShellPrompt.renderCompacto("powershell", "win32", limits, 1000)).toContain("does not support it")
    expect(ShellPrompt.renderCompacto("pwsh", "win32", limits, 1000)).toContain("PowerShell (7+) shell notes")
    expect(ShellPrompt.renderCompacto("cmd", "win32", limits, 1000)).toContain("cmd.exe")
  })
  test("los parámetros compactos tienen los mismos campos", () => {
    expect(Object.keys(ShellPrompt.parameterSchema(true).fields)).toEqual(Object.keys(ShellPrompt.parameterSchema().fields))
  })
})
