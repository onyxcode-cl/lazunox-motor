import { describe, expect, setSystemTime, test, afterEach } from "bun:test"
import { ProviderTransform } from "../../src/provider/transform"
import { SystemPrompt } from "../../src/session/system"
import { LLMRequestPrep } from "../../src/session/llm/request"

// Lazunox P02: el prefijo de la petición debe ser idéntico byte a byte entre pasos consecutivos.

afterEach(() => setSystemTime())

const anthropic = {
  id: "claude-sonnet-4",
  providerID: "anthropic",
  api: { id: "claude-sonnet-4", url: "https://api.anthropic.com", npm: "@ai-sdk/anthropic" },
  name: "Claude",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: true },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 200_000, output: 8192 },
  status: "active",
  options: {},
  headers: {},
} as any

const parts = {
  env: ["ENV hoy"],
  instructions: ["INSTR-1", "INSTR-2"],
  mcp: "MCP",
  skills: "SKILLS",
}

describe("orden del sistema", () => {
  test("instrucciones, MCP, skills y entorno al final", () => {
    expect(SystemPrompt.assemble(parts)).toEqual(["INSTR-1", "INSTR-2", "MCP", "SKILLS", "ENV hoy"])
  })
  test("sin MCP ni skills", () => {
    expect(SystemPrompt.assemble({ env: ["E"], instructions: ["I"] })).toEqual(["I", "E"])
  })
  test("no cambia el contenido, solo el orden", () => {
    const a = SystemPrompt.assemble(parts)
    expect([...a].sort()).toEqual(["ENV hoy", "INSTR-1", "INSTR-2", "MCP", "SKILLS"])
  })
})

describe("fecha estable", () => {
  test("dos horas del mismo día dan los mismos bytes", () => {
    setSystemTime(new Date(2026, 9, 25, 8, 0, 1))
    const a = SystemPrompt.stableDate()
    setSystemTime(new Date(2026, 9, 25, 23, 59, 59))
    const b = SystemPrompt.stableDate()
    expect(a).toBe(b)
    expect(a).not.toMatch(/\d\d:\d\d/)
    expect(a).toBe("Sun Oct 25 2026")
  })
  test("dos pasos seguidos arman el mismo sistema", () => {
    setSystemTime(new Date(2026, 9, 25, 10, 0, 0))
    const paso1 = SystemPrompt.assemble({ ...parts, env: [`Today's date: ${SystemPrompt.stableDate()}`] }).join("\n")
    setSystemTime(new Date(2026, 9, 25, 10, 0, 7))
    const paso2 = SystemPrompt.assemble({ ...parts, env: [`Today's date: ${SystemPrompt.stableDate()}`] }).join("\n")
    expect(paso2).toBe(paso1)
  })
})

describe("herramientas deterministas", () => {
  test("el orden de inserción no cambia la serialización (también MCP)", () => {
    const t = (n: string) => ({ description: n, inputSchema: { type: "object" } })
    const a = LLMRequestPrep.ordenarHerramientas({ zeta: t("z"), mcp_b_tool: t("b"), read: t("r"), mcp_a_tool: t("a"), Bash: t("B") })
    const b = LLMRequestPrep.ordenarHerramientas({ Bash: t("B"), mcp_a_tool: t("a"), read: t("r"), zeta: t("z"), mcp_b_tool: t("b") })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(Object.keys(a)).toEqual(["Bash", "mcp_a_tool", "mcp_b_tool", "read", "zeta"])
  })
})

describe("marcas de caché", () => {
  const strip = (m: any) => JSON.stringify({ ...m, providerOptions: undefined })
  const historia = (n: number) => [
    { role: "system", content: "SISTEMA" },
    ...Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` })),
  ]

  test("el prefijo (sin marcas) es idéntico entre el paso N y el N+2", () => {
    const p1 = ProviderTransform.message(historia(4) as any[], anthropic, {}) as any[]
    const p2 = ProviderTransform.message(historia(6) as any[], anthropic, {}) as any[]
    // todo salvo los 2 últimos mensajes del paso 1 coincide byte a byte
    expect(p2.slice(0, p1.length).map(strip)).toEqual(p1.map(strip))
  })

  test("marca el primer y el último bloque de sistema y los dos últimos mensajes", () => {
    const msgs = [
      { role: "system", content: "A" },
      { role: "system", content: "B" },
      { role: "system", content: "C" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
    ]
    const r = ProviderTransform.message(msgs as any[], anthropic, {}) as any[]
    const marked = r.map((m) => m.providerOptions?.anthropic?.cacheControl !== undefined)
    expect(marked).toEqual([true, false, true, false, true, true])
  })

  test("un proveedor sin marcas explícitas no las recibe", () => {
    const openai = { ...anthropic, providerID: "openai", api: { id: "gpt-5", url: "x", npm: "@ai-sdk/openai" }, id: "gpt-5" }
    const r = ProviderTransform.message(historia(3) as any[], openai, {}) as any[]
    expect(r.every((m) => m.providerOptions?.anthropic === undefined)).toBe(true)
  })
})
