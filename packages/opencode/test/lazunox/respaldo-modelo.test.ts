// Lazunox 6.10 (H13): respaldo de modelo gratuito. Núcleo puro + resolutor con proveedores reales de prueba + procesador real
// con un LLM falso que falla por modelo. `PROBE_ONLY=respaldo` (ver LAZUNOX.md) repite lo esencial contra el motor real.
import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { APICallError } from "ai"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { LLMEvent } from "@opencode-ai/llm"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { Effect, Fiber, Layer, Stream } from "effect"
import path from "path"
import type { Agent } from "../../src/agent/agent"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import * as Respaldo from "../../src/session/respaldo"
import { SessionRetry } from "../../src/session/retry"
import { MessageID, PartID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { provideTmpdirInstance } from "../fixture/fixture"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const modelo = (id: string, cost: { input: number; output: number }) => ({
  id,
  name: id,
  attachment: false,
  reasoning: false,
  temperature: false,
  tool_call: true,
  release_date: "2025-01-01",
  limit: { context: 1000000, output: 10000 },
  cost,
  options: {},
})
const proveedor = (id: string, models: Record<string, ReturnType<typeof modelo>>) => ({
  name: id,
  id,
  env: [],
  npm: "@ai-sdk/openai-compatible",
  models,
  options: { apiKey: "test-key", baseURL: "http://localhost:1/v1" },
})
const cfgProveedores = {
  provider: {
    test: proveedor("test", {
      "test-model": modelo("test-model", { input: 0, output: 0 }),
      "free-b": modelo("free-b", { input: 0, output: 0 }),
      "free-c": modelo("free-c", { input: 0, output: 0 }),
      pago: modelo("pago", { input: 1, output: 2 }),
    }),
    otro: proveedor("otro", { "otro-free": modelo("otro-free", { input: 0, output: 0 }), "otro-pago": modelo("otro-pago", { input: 3, output: 3 }) }),
  },
}
const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
const mr = (p: string, i: string) => ({ providerID: ProviderV2.ID.make(p), id: ModelV2.ID.make(i) })
const global = (respaldo: NonNullable<ConfigV1.Info["respaldo"]> | undefined): ConfigV1.Info => (respaldo ? { respaldo } : {})

// ---------------------------------------------------------------- errores falsos
const cuotaAgotada = () =>
  new APICallError({
    message: "Free usage exceeded, subscribe to Go",
    url: "http://localhost:1/v1",
    requestBodyValues: {},
    statusCode: 429,
    responseBody: '{"type":"error","error":{"type":"FreeUsageLimitError","message":"Free usage exceeded"}}',
    responseHeaders: { "retry-after": "36000" },
    isRetryable: true,
  })
const caida = () =>
  new APICallError({
    message: "Service Unavailable",
    url: "http://localhost:1/v1",
    requestBodyValues: {},
    statusCode: 503,
    responseBody: "{}",
    responseHeaders: { "retry-after-ms": "1" },
    isRetryable: true,
  })
const noAutorizado = () =>
  new APICallError({
    message: "Unauthorized",
    url: "http://localhost:1/v1",
    requestBodyValues: {},
    statusCode: 401,
    responseBody: "{}",
    isRetryable: false,
  })
const apiErr = (e: APICallError) => MessageV2.fromError(e, { providerID: ProviderV2.ID.make("test") })

afterEach(() => {
  delete process.env.LAZUNOX_RESPALDO
  Respaldo.olvidar()
})

// ---------------------------------------------------------------- núcleo puro
describe("respaldo (núcleo)", () => {
  test("apagado por defecto: sin respaldo global no hay lista", () => {
    expect(Respaldo.leer(undefined)).toBeUndefined()
    expect(Respaldo.leer({})).toBeUndefined()
    expect(Respaldo.leer(global({ modelos: [] }))).toBeUndefined()
    expect(Respaldo.leer(global({ otro_proveedor: true }))).toBeUndefined()
  })
  test("hasta 3 modelos, sin repetidos ni entradas mal formadas; el consentimiento solo cuenta con true", () => {
    const a = Respaldo.leer(global({ modelos: ["a/m1", "a/m1", "sin-barra", "/x", "a/", "b/m/2", "c/m3", "d/m4"] }))!
    expect(a.modelos).toEqual([
      { providerID: "a", modelID: "m1" },
      { providerID: "b", modelID: "m/2" },
      { providerID: "c", modelID: "m3" },
    ])
    expect(a.otroProveedor).toBe(false)
    expect(Respaldo.leer(global({ modelos: ["a/m"], otro_proveedor: true }))!.otroProveedor).toBe(true)
  })
  test("motivo: cuota agotada, sobrecarga/5xx y lo que no aplica (autenticación, contexto)", () => {
    expect(Respaldo.motivoDe(apiErr(cuotaAgotada()), "test")).toBe("cuota")
    expect(Respaldo.motivoDe(apiErr(caida()), "test")).toBe("sobrecarga")
    expect(Respaldo.motivoDe(apiErr(noAutorizado()), "test")).toBeUndefined()
    expect(Respaldo.esCuota(apiErr(caida()), "test")).toBe(false)
  })
  test("las pruebas de coste y proveedor", () => {
    const m = (providerID: string, id: string, cost: { input: number; output: number } | undefined) =>
      ({ providerID, id, cost: cost && { ...cost, cache: { read: 0, write: 0 } } }) as unknown as Provider.Model
    const actual = mr("test", "test-model")
    const aj = (otroProveedor: boolean) => ({ modelos: [], otroProveedor })
    const v = (c: Provider.Model, o = false) => Respaldo.admitido({ candidato: c, actual, ajustes: aj(o) })
    expect(v(m("test", "b", { input: 0, output: 0 }))).toEqual({ ok: true })
    expect(v(m("test", "b", { input: 1, output: 0 }))).toEqual({ ok: false, razon: "pago" })
    expect(v(m("test", "b", { input: 0, output: 0.1 }))).toEqual({ ok: false, razon: "pago" })
    expect(v(m("test", "b", undefined))).toEqual({ ok: false, razon: "pago" })
    expect(v(m("test", "test-model", { input: 0, output: 0 }))).toEqual({ ok: false, razon: "mismo-modelo" })
    expect(v(m("otro", "x", { input: 0, output: 0 }))).toEqual({ ok: false, razon: "otro-proveedor" })
    expect(v(m("otro", "x", { input: 0, output: 0 }), true)).toEqual({ ok: true })
    expect(v(m("otro", "x", { input: 2, output: 0 }), true)).toEqual({ ok: false, razon: "pago" }) // el consentimiento no abre el pago
  })
  test("la configuración del proyecto nunca se lee: el módulo solo usa getGlobal", () => {
    const fuente = readFileSync(path.join(import.meta.dir, "../../src/session/respaldo.ts"), "utf8")
    expect(fuente).not.toMatch(/\.get\(\)/)
    expect(fuente).toContain("getGlobal")
  })
  test("el aviso nombra el modelo caído y el que respondió", () => {
    expect(Respaldo.textoAviso(mr("test", "test-model"), mr("test", "free-b"))).toBe(
      "El modelo test/test-model no respondió; este turno se hizo con test/free-b.",
    )
  })
})

// ---------------------------------------------------------------- procesador real con LLM falso
type Comportamiento = () => Stream.Stream<LLMEvent, unknown>
let porModelo: Record<string, Comportamiento> = {}
let llamadas: string[] = []
const bien = (texto: string): Comportamiento => () =>
  Stream.fromIterable([
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.textStart({ id: "t" }),
    LLMEvent.textDelta({ id: "t", text: texto }),
    LLMEvent.textEnd({ id: "t" }),
    LLMEvent.stepFinish({ index: 0, reason: "stop" }),
    LLMEvent.finish({ reason: "stop" }),
  ])
const falla = (e: () => APICallError): Comportamiento => () => Stream.fail(e())

const llmFalso = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: (input) => {
      llamadas.push(`${input.model.providerID}/${input.model.id}`)
      return (porModelo[input.model.id] ?? bien("hola"))()
    },
  }),
)
const resumenFalso = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({ summarize: () => Effect.void, diff: () => Effect.succeed([]), computeDiff: () => Effect.succeed([]) }),
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
const agente = (): Agent.Info => ({
  name: "build",
  mode: "primary",
  options: {},
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
})

/** Un turno de la persona (un mensaje de usuario) con tantos pasos del asistente como se pidan. `global` es la config global falsa. */
const preparar = Effect.fn("test.preparar")(function* (dir: string, globalCfg: ConfigV1.Info, proyectoCfg: ConfigV1.Info = {}) {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  const config = TestConfig.make({ get: () => Effect.succeed(proyectoCfg), getGlobal: () => Effect.succeed(globalCfg) })
  const chat = yield* session.create({})
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
  const paso = Effect.fn("test.paso")(function* () {
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
    const handle = yield* processors.create({
      assistantMessage: msg,
      sessionID: chat.id,
      model: mdl,
      respaldo: Respaldo.resolutor({ config, provider }),
    })
    const resultado = yield* handle.process({
      user: { id: parent.id, sessionID: chat.id, role: "user", time: parent.time, agent: parent.agent, model: { providerID: ref.providerID, modelID: ref.modelID } } satisfies SessionV1.User,
      sessionID: chat.id,
      model: mdl,
      agent: agente(),
      system: [],
      messages: [{ role: "user" as const, content: "hola" }],
      tools: {},
    })
    const parts = yield* MessageV2.parts(msg.id)
    const final = (yield* session.messages({ sessionID: chat.id })).find((m) => m.info.id === msg.id)!.info as SessionV1.Assistant
    return { resultado, parts, msg: final }
  })
  return { paso, provider, config }
})
const reiniciar = () => {
  porModelo = {}
  llamadas = []
}
const avisos = (parts: Effect.Success<ReturnType<typeof MessageV2.parts>>) =>
  parts.filter((p) => p.type === "text" && p.metadata?.lazunox_respaldo) as unknown as { text: string; metadata: Record<string, any> }[]

describe("respaldo (resolutor)", () => {
  it.live("acepta gratis del mismo proveedor y descarta pago, otro proveedor sin consentimiento, inexistentes y el propio modelo", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const resolver = (g: ConfigV1.Info, proyecto: ConfigV1.Info = {}) =>
            Respaldo.resolutor({ config: TestConfig.make({ get: () => Effect.succeed(proyecto), getGlobal: () => Effect.succeed(g) }), provider })
          const actual = mr("test", "test-model")
          const ids = (r: Respaldo.Candidatos) => r.modelos.map((m) => `${m.providerID}/${m.id}`)
          const lista = ["test/pago", "otro/otro-free", "test/free-b"]
          expect(ids(yield* resolver(global({ modelos: lista }))(actual))).toEqual(["test/free-b"])
          expect(ids(yield* resolver(global({ modelos: lista, otro_proveedor: true }))(actual))).toEqual(["otro/otro-free", "test/free-b"])
          expect(ids(yield* resolver(global({ modelos: ["test/no-existe", "test/test-model", "otro/otro-pago"], otro_proveedor: true }))(actual))).toEqual([])
          // solo cuentan los 3 primeros de la lista
          expect(ids(yield* resolver(global({ modelos: ["test/pago", "test/pago2", "test/pago3", "test/free-b"] }))(actual))).toEqual([])
          expect(ids(yield* resolver(global({ modelos: ["otro/otro-pago"], otro_proveedor: true }))(actual))).toEqual([]) // consentir no abre el pago
          expect(ids(yield* resolver({})(actual))).toEqual([]) // apagado por defecto
        }),
      { config: cfgProveedores },
    ),
  )

  it.live("la configuración del proyecto se ignora (aunque traiga un respaldo válido) y el interruptor LAZUNOX_RESPALDO=0 lo apaga", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const hostil = global({ modelos: ["test/free-b"], otro_proveedor: true })
          const r = Respaldo.resolutor({ config: TestConfig.make({ get: () => Effect.succeed(hostil), getGlobal: () => Effect.succeed({}) }), provider })
          expect((yield* r(mr("test", "test-model"))).modelos).toEqual([])
          const g = Respaldo.resolutor({ config: TestConfig.make({ getGlobal: () => Effect.succeed(hostil) }), provider })
          expect((yield* g(mr("test", "test-model"))).modelos.length).toBe(1)
          process.env.LAZUNOX_RESPALDO = "0"
          expect((yield* g(mr("test", "test-model"))).modelos).toEqual([])
        }),
      { config: cfgProveedores },
    ),
  )
})

describe("respaldo (procesador)", () => {
  it.live("cuota agotada: sin esperar, el paso se hace con el respaldo gratuito y se avisa", () => {
    reiniciar()
    porModelo = { "test-model": falla(cuotaAgotada), "free-b": bien("respuesta del respaldo") }
    return provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { paso } = yield* preparar(dir, global({ modelos: ["test/free-b"] }))
          const r = yield* paso()
          expect(r.resultado).toBe("continue")
          expect(r.msg.error).toBeUndefined()
          expect(llamadas).toEqual(["test/test-model", "test/free-b"])
          expect(r.parts.some((p) => p.type === "text" && p.text === "respuesta del respaldo")).toBe(true)
          const [aviso] = avisos(r.parts)
          expect(aviso.text).toBe("El modelo test/test-model no respondió; este turno se hizo con test/free-b.")
          expect(aviso.metadata.lazunox_respaldo).toEqual({ de: "test/test-model", a: "test/free-b", motivo: "cuota" })
          expect(String(r.msg.modelID)).toBe("free-b")
        }),
      { config: cfgProveedores },
    )
  })

  it.live("modelo caído (5xx): agota los reintentos normales y luego usa el respaldo", () => {
    reiniciar()
    porModelo = { "test-model": falla(caida), "free-b": bien("ok") }
    return provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { paso } = yield* preparar(dir, global({ modelos: ["test/free-b"] }))
          const r = yield* paso()
          expect(r.resultado).toBe("continue")
          expect(llamadas.filter((l) => l === "test/test-model").length).toBe(SessionRetry.RETRY_MAX_RETRIES + 1)
          expect(llamadas.filter((l) => l === "test/free-b").length).toBe(1)
          expect(avisos(r.parts)[0].metadata.lazunox_respaldo.motivo).toBe("sobrecarga")
        }),
      { config: cfgProveedores },
    )
  })

  it.live("sin respaldo configurado nada cambia: la cuota se queda con su error de siempre (una sola llamada, sin aviso)", () => {
    reiniciar()
    porModelo = { "test-model": falla(cuotaAgotada), "free-b": bien("no debe usarse") }
    return provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { paso } = yield* preparar(dir, {})
          // Sin respaldo la cuota espera (retry-after de horas); se corta el paso a los 300 ms y se comprueba que solo hubo una llamada.
          const fibra = yield* Effect.forkChild(paso())
          yield* Effect.sleep("300 millis")
          expect(llamadas).toEqual(["test/test-model"])
          yield* Fiber.interrupt(fibra)
        }),
      { config: cfgProveedores },
    )
  })

  it.live("modelo de pago, o de otro proveedor sin consentimiento: no se conmuta y queda el error", () => {
    reiniciar()
    porModelo = { "test-model": falla(cuotaAgotada), pago: bien("no"), "otro-free": bien("no"), "otro-pago": bien("no") }
    return provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { paso } = yield* preparar(dir, global({ modelos: ["test/pago", "otro/otro-free", "otro/otro-pago"] }))
          const fibra = yield* Effect.forkChild(paso())
          yield* Effect.sleep("300 millis")
          expect(llamadas).toEqual(["test/test-model"]) // ningún candidato válido: se comporta como sin respaldo
          yield* Fiber.interrupt(fibra)
        }),
      { config: cfgProveedores },
    )
  })

  it.live("otro proveedor gratuito con consentimiento explícito sí se usa", () => {
    reiniciar()
    porModelo = { "test-model": falla(cuotaAgotada), "otro-free": bien("desde otro") }
    return provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { paso } = yield* preparar(dir, global({ modelos: ["otro/otro-free"], otro_proveedor: true }))
          const r = yield* paso()
          expect(r.resultado).toBe("continue")
          expect(llamadas).toEqual(["test/test-model", "otro/otro-free"])
          expect(avisos(r.parts)[0].metadata.lazunox_respaldo.a).toBe("otro/otro-free")
          expect(String(r.msg.providerID)).toBe("otro")
        }),
      { config: cfgProveedores },
    )
  })

  it.live("la configuración del proyecto se ignora: con un respaldo solo en el proyecto no se conmuta", () => {
    reiniciar()
    porModelo = { "test-model": falla(cuotaAgotada), "free-b": bien("no") }
    return provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { paso } = yield* preparar(dir, {}, global({ modelos: ["test/free-b"], otro_proveedor: true }))
          const fibra = yield* Effect.forkChild(paso())
          yield* Effect.sleep("300 millis")
          expect(llamadas).toEqual(["test/test-model"])
          yield* Fiber.interrupt(fibra)
        }),
      { config: cfgProveedores },
    )
  })

  it.live("sin bucle: si el respaldo también falla por cuota, un solo cambio y el error final (ni segundo respaldo)", () => {
    reiniciar()
    porModelo = { "test-model": falla(cuotaAgotada), "free-b": falla(cuotaAgotada), "free-c": bien("no debe usarse") }
    return provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { paso } = yield* preparar(dir, global({ modelos: ["test/free-b", "test/free-c"] }))
          const r = yield* paso()
          expect(r.resultado).toBe("stop")
          expect(llamadas).toEqual(["test/test-model", "test/free-b"])
          expect(r.msg.error).toBeDefined()
          expect(avisos(r.parts)).toEqual([]) // no se afirma «se hizo con Y» si Y tampoco respondió
        }),
      { config: cfgProveedores },
    )
  })

  it.live("un error que no es caída ni cuota (401) no conmuta", () => {
    reiniciar()
    porModelo = { "test-model": falla(noAutorizado), "free-b": bien("no") }
    return provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { paso } = yield* preparar(dir, global({ modelos: ["test/free-b"] }))
          const r = yield* paso()
          expect(r.resultado).toBe("stop")
          expect(llamadas).toEqual(["test/test-model"])
          expect(avisos(r.parts)).toEqual([])
        }),
      { config: cfgProveedores },
    )
  })

  it.live("dura un turno: el paso siguiente del mismo turno sigue con el respaldo sin volver al caído y sin segundo aviso", () => {
    reiniciar()
    porModelo = { "test-model": falla(cuotaAgotada), "free-b": bien("ok") }
    return provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { paso } = yield* preparar(dir, global({ modelos: ["test/free-b"] }))
          const a = yield* paso()
          expect(avisos(a.parts).length).toBe(1)
          const b = yield* paso()
          expect(llamadas).toEqual(["test/test-model", "test/free-b", "test/free-b"])
          expect(b.resultado).toBe("continue")
          expect(avisos(b.parts)).toEqual([])
          expect(String(b.msg.modelID)).toBe("free-b")
        }),
      { config: cfgProveedores },
    )
  })
})
