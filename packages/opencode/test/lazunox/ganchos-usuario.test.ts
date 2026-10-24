import { describe, expect, test } from "bun:test"
import { aplica, ejecutar, leerConfig } from "../../src/plugin/lazunox-ganchos"

describe("ganchos de usuario", () => {
  test("leerConfig descarta lo inválido y acota tiempos y cantidad", () => {
    expect(leerConfig("no json")).toEqual({ PreToolUse: [], PostToolUse: [] })
    expect(leerConfig('{"hooks":7}')).toEqual({ PreToolUse: [], PostToolUse: [] })
    const c = leerConfig(
      JSON.stringify({
        hooks: {
          PreToolUse: [{ command: "a", timeout: 9999 }, { command: "" }, { nada: 1 }, { command: "b", timeout: -4, matcher: "bash" }, 5, null],
          PostToolUse: Array.from({ length: 50 }, () => ({ command: "x" })),
        },
      }),
    )
    expect(c.PreToolUse.map((g) => g.command)).toEqual(["a", "b"])
    expect(c.PreToolUse[0]!.timeout).toBe(60)
    expect(c.PreToolUse[1]!.timeout).toBe(1)
    expect(c.PostToolUse.length).toBe(20)
  })
  test("aplica: sin matcher o «*» todo; si no, regex anclada", () => {
    expect(aplica({ command: "x" }, "bash")).toBe(true)
    expect(aplica({ command: "x", matcher: "*" }, "edit")).toBe(true)
    expect(aplica({ command: "x", matcher: "bash|edit" }, "edit")).toBe(true)
    expect(aplica({ command: "x", matcher: "bash" }, "bashful")).toBe(false)
    expect(aplica({ command: "x", matcher: "(" }, "bash")).toBe(false)
  })
  test("ejecutar: recibe el JSON por stdin, devuelve el código y el stderr", async () => {
    const cmd = `"${process.execPath}" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.error('visto '+j.tool);process.exit(j.tool==='write'?2:0)})"`
    const bloquea = await ejecutar({ command: cmd }, { tool: "write" }, process.cwd())
    expect(bloquea.code).toBe(2)
    expect(bloquea.stderr).toContain("visto write")
    const deja = await ejecutar({ command: cmd }, { tool: "read" }, process.cwd())
    expect(deja.code).toBe(0)
  })
  test("ejecutar: pasarse del tiempo lo mata y no cuelga", async () => {
    const t0 = Date.now()
    const r = await ejecutar({ command: `"${process.execPath}" -e "setTimeout(()=>{},30000)"`, timeout: 1 }, {}, process.cwd())
    expect(r.timedOut).toBe(true)
    expect(Date.now() - t0).toBeLessThan(8000)
  })
})
