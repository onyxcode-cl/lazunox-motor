import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { filesystem } from "@opencode-ai/core/effect/app-node-platform"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Config } from "@/config/config"
import { Truncate } from "@/tool/truncate"
import { McpInvocar } from "../../src/mcp/invocar"
import { SessionCompaction, ajustarConversacion, NIVELES_RECORTE_SALIDAS } from "../../src/session/compaction"
import { Session as SessionNs } from "@/session/session"
import { Token } from "@/util/token"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { assistantMsg, cfg, itCompaction, llm, reply, userMsg, wide, withCompaction } from "./compactacion-util"
import fs from "fs/promises"

// 1B (P03 + P04): topes por herramienta y por MCP en tokens, y poda de salidas viejas encendida por defecto.

const it = testEffect(LayerNode.compile(LayerNode.group([Truncate.node, FSUtil.node, filesystem])))
const itCfg = (c: ConfigV1.Info) =>
  testEffect(
    LayerNode.compile(LayerNode.group([Truncate.node, FSUtil.node, filesystem, Config.node]), [
      [Config.node, TestConfig.layer({ get: () => Effect.succeed(c) })],
    ]),
  )

const conEntorno = async <T>(vars: Record<string, string | undefined>, fn: () => Promise<T>) => {
  const antes: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(vars)) {
    antes[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(antes)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

describe("P04: topes por herramienta (Truncate)", () => {
  it.live("limits(): bash 30 000, webfetch 50 KB, el resto el global de 50 KB", () =>
    Effect.gen(function* () {
      const svc = yield* Truncate.Service
      expect((yield* svc.limits("bash")).maxBytes).toBe(30_000)
      expect((yield* svc.limits("webfetch")).maxBytes).toBe(50 * 1024)
      expect((yield* svc.limits("read")).maxBytes).toBe(Truncate.MAX_BYTES)
      expect((yield* svc.limits()).maxBytes).toBe(Truncate.MAX_BYTES)
    }),
  )

  it.live("output({tool:'bash'}) corta a 30 000 bytes y guarda el completo en Truncate.DIR", () =>
    Effect.gen(function* () {
      const svc = yield* Truncate.Service
      const texto = Array.from({ length: 1500 }, (_, i) => `linea ${i} ${"x".repeat(40)}`).join("\n") // ~75 KB
      const r = yield* svc.output(texto, { tool: "bash" })
      expect(r.truncated).toBe(true)
      if (!r.truncated) return
      expect(Buffer.byteLength(r.content.split("\n\n...")[0]!, "utf-8")).toBeLessThanOrEqual(30_000)
      expect(r.outputPath.startsWith(Truncate.DIR)).toBe(true)
      expect(yield* Effect.promise(() => fs.readFile(r.outputPath, "utf-8"))).toBe(texto)
      // Con otra herramienta (tope global de 50 KB) la misma salida se corta más tarde.
      const otra = yield* svc.output(texto, { tool: "read" })
      expect(otra.truncated && otra.content.length).toBeGreaterThan(r.content.length)
    }),
  )

  it.live("LAZUNOX_TOPES_HERRAMIENTA=0 apaga los topes propios", () =>
    Effect.gen(function* () {
      const svc = yield* Truncate.Service
      const l = yield* Effect.promise(() =>
        conEntorno({ LAZUNOX_TOPES_HERRAMIENTA: "0" }, () => Effect.runPromise(svc.limits("bash"))),
      )
      expect(l.maxBytes).toBe(Truncate.MAX_BYTES)
    }),
  )

  const conf = itCfg({ tool_output: { max_bytes: 12_345 } })
  conf.live("un tope de la configuración (tool_output) gana al de la herramienta", () =>
    Effect.gen(function* () {
      expect((yield* (yield* Truncate.Service).limits("bash")).maxBytes).toBe(12_345)
    }),
  )

  it.live("una sola línea enorme ya no deja la vista previa vacía", () =>
    Effect.gen(function* () {
      const svc = yield* Truncate.Service
      const r = yield* svc.output("ñ".repeat(60_000), { tool: "bash" })
      expect(r.truncated).toBe(true)
      if (!r.truncated) return
      const previa = r.content.split("\n\n...")[0]!
      expect(previa.length).toBeGreaterThan(1000)
      expect(Buffer.byteLength(previa, "utf-8")).toBeLessThanOrEqual(30_000)
      expect(previa).not.toContain("�")
    }),
  )
})

describe("P04: tope de 25k tokens por resultado MCP", () => {
  test("topeTokensMcp / opcionesMcp: valor por defecto y variables", () => {
    expect(Truncate.topeTokensMcp({})).toBe(25_000)
    expect(Truncate.topeTokensMcp({ LAZUNOX_MCP_TOPE_TOKENS: "10000" })).toBe(10_000)
    expect(Truncate.topeTokensMcp({ MAX_MCP_OUTPUT_TOKENS: "8000" })).toBe(8_000)
    expect(Truncate.topeTokensMcp({ LAZUNOX_MCP_TOPE_TOKENS: "basura" })).toBe(25_000)
    expect(Truncate.topeTokensMcp({ LAZUNOX_MCP_TOPE_TOKENS: "5" })).toBe(25_000)
  })

  const montar = (texto: string, truncate: Truncate.Interface) => {
    const client = { callTool: async () => ({ content: [{ type: "text", text: texto }] }) }
    const entry = { def: { name: "grande", description: "d", inputSchema: { type: "object", properties: {} } }, client, timeout: 1000 } as any
    return McpInvocar.run({
      key: "x_grande",
      entry,
      args: {},
      opts: { toolCallId: "call-1", abortSignal: new AbortController().signal, messages: [] },
      ctx: { sessionID: "ses_1" as any, ask: () => Effect.void },
      messageID: "msg_1",
      plugin: { trigger: ((_n: string, _i: any, o: any) => Effect.succeed(o)) as any },
      truncate,
      agent: { name: "build", mode: "primary", options: {}, permission: [] } as any,
      processor: { completeToolCall: () => Effect.void },
    })
  }

  it.live("200 KB en una línea → ≤ 25k tokens, con ruta del archivo completo", () =>
    Effect.gen(function* () {
      const svc = yield* Truncate.Service
      const texto = JSON.stringify({ filas: Array.from({ length: 8000 }, (_, i) => ({ i, v: "abcdefghij" })) }) // una línea
      expect(texto.length).toBeGreaterThan(200_000)
      expect(texto.includes("\n")).toBe(false)
      const out = yield* montar(texto, svc)
      expect(Token.estimate(out.output)).toBeLessThanOrEqual(25_000)
      expect(out.output.length).toBeGreaterThan(50_000) // no se queda vacío
      expect(out.metadata.truncated).toBe(true)
      const ruta = out.metadata.outputPath as string
      expect(ruta.startsWith(Truncate.DIR)).toBe(true)
      expect(out.output).toContain(ruta)
      expect(yield* Effect.promise(() => fs.readFile(ruta, "utf-8"))).toBe(texto)
    }),
  )

  it.live("200 KB en muchas líneas (más de 2000) → también ≤ 25k tokens", () =>
    Effect.gen(function* () {
      const svc = yield* Truncate.Service
      const texto = Array.from({ length: 5000 }, (_, i) => `fila ${i} ${"y".repeat(35)}`).join("\n")
      const out = yield* montar(texto, svc)
      expect(Token.estimate(out.output)).toBeLessThanOrEqual(25_000)
      expect(out.output.split("\n").length).toBeGreaterThan(2000) // más de 2000 líneas caben si entran en los 25k tokens
      expect(out.metadata.truncated).toBe(true)
    }),
  )

  it.live("un resultado pequeño pasa intacto", () =>
    Effect.gen(function* () {
      const svc = yield* Truncate.Service
      const out = yield* montar("hola", svc)
      expect(out.output).toBe("hola")
      expect(out.metadata.truncated).toBe(false)
    }),
  )

  it.live("LAZUNOX_MCP_TOPE_TOKENS baja el tope", () =>
    Effect.gen(function* () {
      const svc = yield* Truncate.Service
      const texto = "z".repeat(60_000)
      const out = yield* Effect.promise(() =>
        conEntorno({ LAZUNOX_MCP_TOPE_TOKENS: "4000" }, () => Effect.runPromise(montar(texto, svc))),
      )
      expect(Token.estimate(out.output)).toBeLessThanOrEqual(4_000)
      expect(out.metadata.truncated).toBe(true)
    }),
  )
})

// --- P03: recorte de la petición de resumen ---

const herramienta = (tool: string, output: string) =>
  ({
    info: { role: "assistant" },
    parts: [{ type: "tool", tool, state: { status: "completed", input: { a: 1 }, output, attachments: [], time: { compacted: undefined } } }],
  }) as any
const armar = (c: string) => `PROMPT\n${c}`

describe("P03: ajustarConversacion", () => {
  const mensajes = Array.from({ length: 6 }, (_, i) => herramienta("bash", `M${i}-` + "q".repeat(5000)))

  test("si cabe, no toca nada (nivel 0)", () => {
    const r = ajustarConversacion({ messages: mensajes, presupuesto: 1_000_000, armar })
    expect(r).toMatchObject({ nivel: 0, descartados: 0 })
    expect(r.conversation).toContain("[truncated]")
  })

  test("sin presupuesto conocido (0) tampoco recorta", () => {
    expect(ajustarConversacion({ messages: mensajes, presupuesto: 0, armar }).nivel).toBe(0)
  })

  test("no cabe con 2000 por salida → recorta a 500", () => {
    const base = ajustarConversacion({ messages: mensajes, presupuesto: 1_000_000, armar }).conversation
    const r = ajustarConversacion({ messages: mensajes, presupuesto: Token.estimate(armar(base)) - 10, armar })
    expect(r.nivel).toBe(1)
    expect(r.descartados).toBe(0)
    expect(Token.estimate(armar(r.conversation))).toBeLessThan(Token.estimate(armar(base)))
  })

  test("aún más justo → salidas reducidas a una marca (nivel 2); los mensajes siguen", () => {
    const r = ajustarConversacion({ messages: mensajes, presupuesto: 600, armar })
    expect(r.nivel).toBe(NIVELES_RECORTE_SALIDAS.length - 1)
    expect(r.conversation).toContain("trimmed to fit")
    expect(r.conversation).not.toContain("qqqq")
    expect(Token.estimate(armar(r.conversation))).toBeLessThanOrEqual(600)
    expect(r.descartados).toBe(0)
  })

  test("si ni así cabe, descarta los más viejos y conserva siempre el último", () => {
    const r = ajustarConversacion({ messages: mensajes, presupuesto: 120, armar })
    expect(r.descartados).toBeGreaterThan(0)
    expect(r.descartados).toBeLessThanOrEqual(mensajes.length - 1)
    expect(r.conversation).toContain("bash")
  })
})

describe("P03: poda de salidas viejas encendida por defecto", () => {
  const grande = "x".repeat(200_000)
  const sesion = (tool: string) =>
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const u1 = yield* userMsg(session.id, "primero")
      yield* assistantMsg(session.id, u1.id, { text: "a1", tools: [{ tool, input: {}, output: grande }] })
      const u2 = yield* userMsg(session.id, "segundo")
      yield* assistantMsg(session.id, u2.id, { text: "a2", tools: [{ tool: "bash", input: {}, output: grande }] })
      yield* userMsg(session.id, "tercero")
      return session
    })
  const estado = (sessionID: any) =>
    Effect.gen(function* () {
      const msgs = yield* (yield* SessionNs.Service).messages({ sessionID })
      return msgs.flatMap((m) => m.parts).flatMap((p) => (p.type === "tool" && p.state.status === "completed" ? [!!p.state.time.compacted] : []))
    })

  itCompaction.instance("sin configurar compaction: poda la salida vieja y respeta la del último turno", () =>
    Effect.gen(function* () {
      const session = yield* sesion("bash")
      yield* SessionCompaction.use.prune({ sessionID: session.id })
      expect(yield* estado(session.id)).toEqual([true, false])
    }).pipe(withCompaction({ llm: llm().llmLayer, config: cfg(undefined) })),
  )

  itCompaction.instance("compaction.prune:false la apaga", () =>
    Effect.gen(function* () {
      const session = yield* sesion("bash")
      yield* SessionCompaction.use.prune({ sessionID: session.id })
      expect(yield* estado(session.id)).toEqual([false, false])
    }).pipe(withCompaction({ llm: llm().llmLayer, config: cfg({ prune: false }) })),
  )

  itCompaction.instance("nunca poda la herramienta skill", () =>
    Effect.gen(function* () {
      const session = yield* sesion("skill")
      yield* SessionCompaction.use.prune({ sessionID: session.id })
      expect(yield* estado(session.id)).toEqual([false, false])
    }).pipe(withCompaction({ llm: llm().llmLayer, config: cfg(undefined) })),
  )
})

describe("P03: la petición de resumen se recorta cuando no cabe", () => {
  itCompaction.instance("modelo pequeño con muchas salidas grandes: el resumen se pide recortado y sale bien", () => {
    const stub = llm()
    stub.push(reply("RESUMEN-OK"))
    return Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      for (let i = 1; i <= 10; i++) {
        const u = yield* userMsg(session.id, `PEDIDO-${i}`)
        yield* assistantMsg(session.id, u.id, {
          text: `R-${i}`,
          tokens: i === 10 ? 5000 : 100,
          tools: [1, 2, 3].map((j) => ({ tool: "bash", input: { c: `${i}-${j}` }, output: `SALIDA-${i}-${j} ` + "w".repeat(9000) })),
        })
      }
      const modelo = { providerID: "test" as never, modelID: "test-model" as never }
      yield* SessionCompaction.use.create({ sessionID: session.id, agent: "build", model: modelo, auto: false })
      const msgs = yield* ssn.messages({ sessionID: session.id })
      const res = yield* SessionCompaction.use.process({ parentID: msgs.at(-1)!.info.id, messages: msgs, sessionID: session.id, auto: false })
      expect(res).toBe("continue")
      const pedido = JSON.stringify(stub.peticiones[0])
      // Contexto 8000, salida 2000 → usable 6000 tokens; con 85 % la petición cabe en ≈ 5100 tokens.
      expect(Token.estimate(pedido)).toBeLessThanOrEqual(6000)
      expect(pedido).not.toContain("w".repeat(2000))
    }).pipe(withCompaction({ llm: stub.llmLayer, provider: wide(8000, 2000) }))
  })
})
