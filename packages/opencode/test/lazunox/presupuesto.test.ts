// Lazunox 3B (P25 + P11): presupuesto por sesión y continuación si la respuesta se corta. LLM falso con guion; procesador real.
import { describe, expect, test } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LLMEvent } from "@opencode-ai/llm"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { Cause, Effect, Exit, Fiber, Layer, Stream } from "effect"
import path from "path"
import type { Agent } from "../../src/agent/agent"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import * as Presupuesto from "../../src/session/presupuesto"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// ---------------------------------------------------------------- núcleo puro
describe("presupuesto (núcleo)", () => {
  test("sin metadata.presupuesto o sin límites no hay configuración", () => {
    expect(Presupuesto.leer(undefined)).toBeUndefined()
    expect(Presupuesto.leer({})).toBeUndefined()
    expect(Presupuesto.leer({ presupuesto: {} })).toBeUndefined()
    expect(Presupuesto.leer({ presupuesto: { tokens: -1, pasos: "x", minutos: 0 } })).toBeUndefined()
    expect(Presupuesto.leer({ presupuesto: [1] })).toBeUndefined()
  })
  test("valores válidos; continuar solo cuenta si es true", () => {
    const c = Presupuesto.leer({ presupuesto: { tokens: 100, pasos: 3, minutos: 1.5, continuar: true } })!
    expect([c.tokens, c.pasos, c.minutos, c.continuar]).toEqual([100, 3, 1.5, true])
    expect(Presupuesto.leer({ presupuesto: { continuar: "si" } })).toBeUndefined()
  })
  test("aviso al 80 % una sola vez por dimensión y agotado por >=", () => {
    const cfg = Presupuesto.leer({ presupuesto: { tokens: 100, pasos: 10 } })!
    const e = Presupuesto.estado("s-nucleo-1", cfg, 0)
    expect(Presupuesto.registrarPaso(e, cfg, 79, 0)).toEqual([])
    expect(Presupuesto.registrarPaso(e, cfg, 1, 0)).toEqual(["tokens"])
    expect(Presupuesto.registrarPaso(e, cfg, 5, 0)).toEqual([])
    expect(Presupuesto.agotada(e, cfg, 0)).toBeUndefined() // 85/100
    Presupuesto.registrarPaso(e, cfg, 15, 0)
    expect(Presupuesto.agotada(e, cfg, 0)).toBe("tokens")
    expect(Presupuesto.textoAgotado(e, cfg, "tokens", 0)).toContain("Presupuesto agotado")
  })
  test("minutos por tiempo transcurrido y aviso al 80 %", () => {
    const cfg = Presupuesto.leer({ presupuesto: { minutos: 10 } })!
    const e = Presupuesto.estado("s-nucleo-2", cfg, 1000)
    expect(Presupuesto.agotada(e, cfg, 1000 + 9 * 60_000)).toBeUndefined()
    expect(Presupuesto.registrarPaso(e, cfg, 0, 1000 + 8 * 60_000)).toEqual(["minutos"])
    expect(Presupuesto.agotada(e, cfg, 1000 + 10 * 60_000)).toBe("minutos")
  })
  test("cambiar la configuración (o la época) reinicia los contadores", () => {
    const a = Presupuesto.leer({ presupuesto: { pasos: 1 } })!
    const e1 = Presupuesto.estado("s-nucleo-3", a, 0)
    Presupuesto.registrarPaso(e1, a, 0, 0)
    expect(Presupuesto.agotada(e1, a, 0)).toBe("pasos")
    const b = Presupuesto.leer({ presupuesto: { pasos: 1, epoca: 2 } })!
    expect(Presupuesto.agotada(Presupuesto.estado("s-nucleo-3", b, 0), b, 0)).toBeUndefined()
  })
  test("los tokens del paso no cuentan la lectura de caché", () => {
    expect(Presupuesto.tokensDelPaso({ input: 10, output: 5, reasoning: 2, cache: { write: 3 } })).toBe(20)
  })
})

// ---------------------------------------------------------------- procesador real con LLM falso
type Guion = () => Stream.Stream<LLMEvent, unknown>
let guion: Guion[] = []
let llamadas: unknown[][] = []

const llmFalso = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: (input) => {
      llamadas.push(input.messages)
      const siguiente = guion.shift()
      return siguiente ? siguiente() : Stream.make(LLMEvent.stepStart({ index: 0 }), LLMEvent.stepFinish({ index: 0, reason: "stop" }))
    },
  }),
)

const resumenFalso = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const root = LayerNode.group([
  SessionProcessor.node,
  Session.node,
  SessionProjector.node,
  Provider.node,
  Database.node,
  EventV2Bridge.node,
  SessionStatus.node,
  CrossSpawnSpawner.node,
])
const it = testEffect(
  LayerNode.compile(root, [
    [SessionSummary.node, resumenFalso],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
    [LLM.node, llmFalso],
  ]),
)

const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
const cfgProveedor = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 1000000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: "http://localhost:1/v1" },
    },
  },
}
const agente = (): Agent.Info => ({
  name: "build",
  mode: "primary",
  options: {},
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
})

const paso = (opts: { reason: "stop" | "tool-calls" | "length"; texto?: string; tokens?: number; herramienta?: boolean }): Guion =>
  () =>
    Stream.fromIterable([
      LLMEvent.stepStart({ index: 0 }),
      ...(opts.texto
        ? [
            LLMEvent.textStart({ id: "t" }),
            LLMEvent.textDelta({ id: "t", text: opts.texto }),
            LLMEvent.textEnd({ id: "t" }),
          ]
        : []),
      ...(opts.herramienta
        ? [
            LLMEvent.toolInputStart({ id: "c1", name: "lookup" }),
            LLMEvent.toolInputEnd({ id: "c1", name: "lookup" }),
            LLMEvent.toolCall({ id: "c1", name: "lookup", input: {}, providerExecuted: true }),
            LLMEvent.toolResult({
              id: "c1",
              name: "lookup",
              result: { type: "json", value: { output: "ok", title: "t", metadata: {} } },
              providerExecuted: true,
            }),
          ]
        : []),
      LLMEvent.stepFinish({
        index: 0,
        reason: opts.reason,
        usage: opts.tokens ? { inputTokens: opts.tokens, outputTokens: 0, totalTokens: opts.tokens } : undefined,
      }),
      LLMEvent.finish({ reason: opts.reason }),
    ])

const preparar = Effect.fn("test.preparar")(function* (dir: string, presupuesto?: Record<string, unknown>) {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  const chat = yield* session.create({})
  if (presupuesto) yield* session.setMetadata({ sessionID: chat.id, metadata: { presupuesto } })
  const parent = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({ id: PartID.ascending(), messageID: parent.id, sessionID: chat.id, type: "text", text: "hola" })
  const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
  const turno = Effect.fn("test.turno")(function* () {
    const msg: SessionV1.Assistant = {
      id: MessageID.ascending(),
      role: "assistant",
      sessionID: chat.id,
      mode: "build",
      agent: "build",
      path: { cwd: dir, root: path.resolve(dir) },
      cost: 0,
      tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      parentID: parent.id,
      time: { created: Date.now() },
    }
    yield* session.updateMessage(msg)
    const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
    const entrada = {
      user: {
        id: parent.id,
        sessionID: chat.id,
        role: "user",
        time: parent.time,
        agent: parent.agent,
        model: { providerID: ref.providerID, modelID: ref.modelID },
      } satisfies SessionV1.User,
      sessionID: chat.id,
      model: mdl,
      agent: agente(),
      system: [],
      messages: [{ role: "user" as const, content: "hola" }],
      tools: {},
    } satisfies LLM.StreamInput
    const resultado = yield* handle.process(entrada)
    const parts = yield* MessageV2.parts(msg.id)
    const final = (yield* session.messages({ sessionID: chat.id })).find((m) => m.info.id === msg.id)!.info as SessionV1.Assistant
    return { resultado, parts, msg: final, handle, entrada }
  })
  return { chat, turno, session }
})

const textos = (parts: Effect.Success<ReturnType<typeof MessageV2.parts>>) => parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text)
const reiniciar = () => {
  guion = []
  llamadas = []
}

describe("presupuesto (procesador)", () => {
  it.live("sin presupuesto no cambia nada: un paso, ninguna parte extra, ni con finish length", () => {
    reiniciar()
    return provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const { turno } = yield* preparar(dir)
        guion = [paso({ reason: "tool-calls", texto: "a", herramienta: true, tokens: 5000 })]
        const r = yield* turno()
        expect(r.resultado).toBe("continue")
        expect(textos(r.parts)).toEqual(["a"])
        guion = [paso({ reason: "length", texto: "corto" })]
        const r2 = yield* turno()
        expect(llamadas.length).toBe(2) // ninguna llamada extra por «length»
        expect(r2.msg.finish).toBe("length")
        expect(textos(r2.parts)).toEqual(["corto"])
      }),
      { config: cfgProveedor },
    )
  })

  it.live("pasos: corta al llegar al límite con «presupuesto agotado», sin partes perdidas ni herramientas colgadas", () => {
    reiniciar()
    return provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const { turno } = yield* preparar(dir, { pasos: 2 })
        guion = [paso({ reason: "tool-calls", texto: "uno", herramienta: true }), paso({ reason: "tool-calls", texto: "dos", herramienta: true })]
        const a = yield* turno()
        expect(a.resultado).toBe("continue")
        const b = yield* turno()
        expect(b.resultado).toBe("stop")
        const t = textos(b.parts)
        expect(t[0]).toBe("dos") // lo hecho se conserva
        expect(t[1]).toContain("Presupuesto agotado")
        expect(b.parts.some((p) => p.type === "tool" && p.state.status === "completed")).toBe(true)
        expect(b.parts.some((p) => p.type === "tool" && ["running", "pending"].includes(p.state.status))).toBe(false)
        expect(b.msg.finish).toBe("stop")
        expect(b.msg.time.completed).toBeDefined()
        // ya agotado: ni siquiera se llama al modelo
        const antes = llamadas.length
        const c = yield* turno()
        expect(c.resultado).toBe("stop")
        expect(llamadas.length).toBe(antes)
        expect(textos(c.parts).join("")).toContain("Presupuesto agotado")
        expect(Presupuesto.estaAgotado(c.msg.sessionID, { presupuesto: { pasos: 2 } })).toBe("pasos")
      }),
      { config: cfgProveedor },
    )
  })

  it.live("tokens: aviso al 80 % (marcado en metadata) y corte al superar", () => {
    reiniciar()
    return provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const { turno } = yield* preparar(dir, { tokens: 100 })
        guion = [paso({ reason: "tool-calls", texto: "x", tokens: 85 }), paso({ reason: "tool-calls", texto: "y", tokens: 30 })]
        const a = yield* turno()
        expect(a.resultado).toBe("continue")
        const aviso = a.parts.find((p) => p.type === "text" && p.metadata?.lazunox_presupuesto === "aviso") as { text: string } | undefined
        expect(aviso?.text).toContain("80 %")
        const b = yield* turno()
        expect(b.resultado).toBe("stop")
        expect(b.parts.some((p) => p.type === "text" && p.metadata?.lazunox_presupuesto === "agotado")).toBe(true)
        expect(b.parts.some((p) => p.type === "text" && p.metadata?.lazunox_presupuesto === "aviso")).toBe(false) // el aviso sale una vez
      }),
      { config: cfgProveedor },
    )
  })

  it.live("un paso final (stop) nunca se corta aunque pase el límite", () => {
    reiniciar()
    return provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const { turno } = yield* preparar(dir, { tokens: 10 })
        guion = [paso({ reason: "stop", texto: "listo", tokens: 500 })]
        const a = yield* turno()
        expect(a.resultado).toBe("continue")
        expect(textos(a.parts)).toEqual(["listo"])
      }),
      { config: cfgProveedor },
    )
  })

  it.live("continuar: reintenta si finish=length con mensaje fijo, máx. 2", () => {
    reiniciar()
    return provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const { turno } = yield* preparar(dir, { continuar: true })
        guion = [paso({ reason: "length", texto: "abc" }), paso({ reason: "length", texto: "def" }), paso({ reason: "stop", texto: "ghi" })]
        const a = yield* turno()
        expect(llamadas.length).toBe(3)
        expect(textos(a.parts)).toEqual(["abc", "def", "ghi"])
        expect(a.msg.finish).toBe("stop")
        const segunda = llamadas[1] as { role: string; content: string }[]
        expect(segunda.slice(-2)).toEqual([
          { role: "assistant", content: "abc" },
          { role: "user", content: Presupuesto.MENSAJE_CONTINUACION },
        ])
        // nunca más de 2 reintentos: 4 respuestas cortadas -> 3 llamadas
        llamadas = []
        guion = [1, 2, 3, 4].map((n) => paso({ reason: "length", texto: `p${n}` }))
        const b = yield* turno()
        expect(llamadas.length).toBe(3)
        expect(b.msg.finish).toBe("length")
        expect(b.resultado).toBe("continue")
      }),
      { config: cfgProveedor },
    )
  })

  it.live("continuar respeta el presupuesto: el corte gana al reintento", () => {
    reiniciar()
    return provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const { turno } = yield* preparar(dir, { continuar: true, pasos: 1 })
        guion = [paso({ reason: "length", texto: "abc" }), paso({ reason: "stop", texto: "no debe llegar" })]
        const a = yield* turno()
        expect(a.resultado).toBe("stop")
        expect(llamadas.length).toBe(1)
        expect(textos(a.parts)[1]).toContain("Presupuesto agotado")
      }),
      { config: cfgProveedor },
    )
  })

  it.live("cancelar durante la corrida con presupuesto activo interrumpe limpio (sin partes colgadas)", () => {
    reiniciar()
    return provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const { turno } = yield* preparar(dir, { pasos: 5, continuar: true })
        guion = [() => Stream.concat(Stream.make(LLMEvent.stepStart({ index: 0 }), LLMEvent.textStart({ id: "t" }), LLMEvent.textDelta({ id: "t", text: "a medias" })), Stream.never)]
        const fiber = yield* Effect.forkChild(turno())
        yield* Effect.sleep("100 millis")
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      }),
      { config: cfgProveedor },
    )
  })
})
