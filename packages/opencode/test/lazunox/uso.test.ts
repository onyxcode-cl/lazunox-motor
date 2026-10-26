// Lazunox (Ola 7, 7.18): tokens por paso, caché y ayudantes de una sesión. Cifras comprobadas contra un caso calculado a mano.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Database } from "@opencode-ai/core/database/database"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Layer } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { reply } from "../lib/llm-server"
import { Session } from "../../src/session/session"
import { SessionSummary } from "../../src/session/summary"
import { Snapshot } from "../../src/snapshot"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import * as Uso from "../../src/session/uso"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "../server/httpapi-layer"
import { conEntorno, it as itBucle, sesionConPeticion, useServerConfig } from "./bucle-util"

// ---------------------------------------------------------------- caso calculado a mano
// Cada paso: input (sin caché) / lectura / escritura / salida / razonamiento.
//   P1 100/0/400/50/0   -> enviado 500        P4 530/0/0/40/0    -> enviado 530 (la lectura cae de 520 a 0)
//   P2  20/400/100/30/10 -> enviado 520       P5 100/900/0/20/0  -> enviado 1000
//   P3  10/520/0/5/0    -> enviado 530
// enviados ordenados [500, 520, 530, 530, 1000]: mediana 530; p90 (rango más cercano, posición ceil(0.9·5)=5) 1000; total 3080.
// leídos 1820, escritos 500, sin caché 760 (1820+500+760 = 3080); acierto 1820/3080 = 59,09 % -> 59,1. Salida 50+30+5+40+20 = 145.
const PASOS = [
  { input: 100, read: 0, write: 400, output: 50, reasoning: 0 },
  { input: 20, read: 400, write: 100, output: 20, reasoning: 10 },
  { input: 10, read: 520, write: 0, output: 5, reasoning: 0 },
  { input: 530, read: 0, write: 0, output: 40, reasoning: 0 },
  { input: 100, read: 900, write: 0, output: 20, reasoning: 0 },
]

const ESPERADO = {
  pasos: 5,
  tokensEnviadosPorPaso: { mediana: 530, p90: 1000, minimo: 500, maximo: 1000, total: 3080 },
  salida: 145,
}

const ref = { providerID: "test", modelID: "test-model" } as const

describe("uso (núcleo)", () => {
  test("mediana y p90", () => {
    expect(Uso.mediana([])).toBe(0)
    expect(Uso.mediana([5])).toBe(5)
    expect(Uso.mediana([4, 1, 3, 2])).toBe(2.5)
    expect(Uso.percentil([], 0.9)).toBe(0)
    expect(Uso.percentil([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.9)).toBe(90)
    expect(Uso.percentil([500, 520, 530, 530, 1000], 0.9)).toBe(1000)
    expect(Uso.percentil([7], 0.9)).toBe(7)
  })

  const paso = (i: number, p: (typeof PASOS)[number], modelo = "test/test-model"): Uso.Paso => ({
    mensajeID: `m${i}`,
    modelo,
    enviado: p.input + p.read + p.write,
    sinCache: p.input,
    leidos: p.read,
    escritos: p.write,
    salida: p.output + p.reasoning,
  })

  test("las cifras coinciden con el caso calculado a mano", () => {
    Uso.olvidarHuellas()
    const r = Uso.resumir(PASOS.map((p, i) => paso(i + 1, p)))
    expect(r.pasos).toBe(ESPERADO.pasos)
    expect(r.tokensEnviadosPorPaso).toEqual(ESPERADO.tokensEnviadosPorPaso)
    expect(r.salida).toBe(ESPERADO.salida)
    expect(r.cache).toMatchObject({ datos: true, leidos: 1820, escritos: 500, sinCache: 760, aciertoPct: 59.1 })
    // Un solo fallo (P3 -> P4) y sin huellas ni cambio de modelo no se inventa la causa.
    expect(r.cache.fallos).toEqual([{ paso: 4, mensajeID: "m4", causa: "desconocida" }])
  })

  test("causa del fallo: solo lo que se comprueba", () => {
    const pasos = PASOS.map((p, i) => paso(i + 1, p))
    const resumen = () => Uso.resumir(pasos).cache.fallos[0].causa
    Uso.olvidarHuellas()
    Uso.registrarHuella("m3", { tools: "A", sistema: "S" })
    Uso.registrarHuella("m4", { tools: "B", sistema: "S" })
    expect(resumen()).toBe("herramientas")
    Uso.registrarHuella("m4", { tools: "A", sistema: "T" })
    expect(resumen()).toBe("sistema")
    Uso.registrarHuella("m4", { tools: "B", sistema: "T" })
    expect(resumen()).toBe("herramientas-y-sistema")
    Uso.registrarHuella("m4", { tools: "A", sistema: "S" })
    expect(resumen()).toBe("desconocida") // todo igual: la caché falló por otra razón (p. ej. caducó); no se adivina
    Uso.olvidarHuellas()
    Uso.registrarHuella("m4", { tools: "B", sistema: "S" })
    expect(resumen()).toBe("desconocida") // falta la huella del paso anterior
    expect(Uso.resumir([paso(3, PASOS[2]), paso(4, PASOS[3], "otro/modelo")]).cache.fallos[0].causa).toBe("modelo")
  })

  test("proveedor sin datos de caché: sin porcentaje ni fallos", () => {
    const sin = [{ input: 300, read: 0, write: 0, output: 10, reasoning: 0 }, { input: 450, read: 0, write: 0, output: 12, reasoning: 0 }]
    const r = Uso.resumir(sin.map((p, i) => paso(i + 1, p)))
    expect(r.cache).toEqual({ datos: false, leidos: 0, escritos: 0, sinCache: 750, aciertoPct: null, fallos: [] })
    expect(r.tokensEnviadosPorPaso).toMatchObject({ mediana: 375, p90: 450, total: 750 })
  })

  test("sesión sin pasos", () => {
    const r = Uso.resumir([])
    expect(r.pasos).toBe(0)
    expect(r.tokensEnviadosPorPaso).toEqual({ mediana: 0, p90: 0, minimo: 0, maximo: 0, total: 0 })
    expect(r.cache.aciertoPct).toBeNull()
  })

  test("interruptor", () => {
    expect(Uso.activo({})).toBe(true)
    expect(Uso.activo({ LAZUNOX_USO: "0" })).toBe(false)
  })
})

// ---------------------------------------------------------------- servicio de sesiones + ruta HTTP
const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([Session.node, Snapshot.node, SessionSummary.node, FSUtil.node, SessionProjector.node, Database.node]),
    ),
    httpApiLayer,
  ),
)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})
beforeEach(() => Uso.olvidarHuellas())

const json = <T>(res: HttpClientResponse.HttpClientResponse) => res.json.pipe(Effect.map((v) => v as T))

/** Un mensaje del asistente con un `step-finish` con esos tokens (lo que el procesador deja tras cada paso). */
const paso = Effect.fn("test.paso")(function* (
  sessionID: SessionID,
  t: { input: number; read: number; write: number; output: number; reasoning: number },
  modelo = ref.modelID as string,
) {
  const session = yield* Session.Service
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: { providerID: ref.providerID, modelID: ref.modelID } as never,
    time: { created: Date.now() },
  })
  const asistente: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: modelo as never,
    providerID: ref.providerID as never,
    time: { created: Date.now() },
    finish: "stop",
  }
  yield* session.updateMessage(asistente)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: asistente.id,
    sessionID,
    type: "step-finish",
    reason: "stop",
    cost: 0,
    tokens: { input: t.input, output: t.output, reasoning: t.reasoning, cache: { read: t.read, write: t.write } },
  })
  return asistente
})

describe("uso (sesión real y ruta)", () => {
  it.instance("las cifras de la sesión coinciden con el caso calculado a mano; los ayudantes suman aparte", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "principal" })
      const mensajes = []
      for (const p of PASOS) mensajes.push(yield* paso(chat.id, p))
      // Dos ayudantes: uno directo y uno anidado (nieto).
      const h1 = yield* sessions.create({ parentID: chat.id, title: "ayudante uno" })
      yield* paso(h1.id, { input: 50, read: 0, write: 0, output: 5, reasoning: 0 })
      yield* paso(h1.id, { input: 20, read: 40, write: 0, output: 7, reasoning: 1 })
      const h2 = yield* sessions.create({ parentID: h1.id, title: "nieto" })
      yield* paso(h2.id, { input: 100, read: 0, write: 0, output: 9, reasoning: 0 })
      // Huellas: el paso 4 cambió la lista de herramientas.
      Uso.registrarHuella(String(mensajes[2].id), { tools: "A", sistema: "S" })
      Uso.registrarHuella(String(mensajes[3].id), { tools: "B", sistema: "S" })

      const uso = yield* Uso.calcular(sessions, chat.id)
      expect(uso.sesion.pasos).toBe(ESPERADO.pasos)
      expect(uso.sesion.tokensEnviadosPorPaso).toEqual(ESPERADO.tokensEnviadosPorPaso)
      expect(uso.sesion.salida).toBe(ESPERADO.salida)
      expect(uso.sesion.cache).toMatchObject({ datos: true, leidos: 1820, escritos: 500, sinCache: 760, aciertoPct: 59.1 })
      expect(uso.sesion.cache.fallos).toEqual([{ paso: 4, mensajeID: String(mensajes[3].id), causa: "herramientas" }])
      expect(uso.porPaso.map((p) => p.enviado)).toEqual([500, 520, 530, 530, 1000])

      expect(uso.ayudantes).toHaveLength(2)
      const uno = uso.ayudantes.find((a) => a.titulo === "ayudante uno")!
      const nieto = uso.ayudantes.find((a) => a.titulo === "nieto")!
      // h1: enviados 50 y 20+40 = 60 -> 110; salida 5 + (7+1) = 13; caché leída 40.
      expect(uno).toMatchObject({ sessionID: String(h1.id), pasos: 2, tokensEnviados: 110, salida: 13, cache: { leidos: 40, escritos: 0 } })
      expect(nieto).toMatchObject({ sessionID: String(h2.id), pasos: 1, tokensEnviados: 100, salida: 9 })
      expect(uso.total).toEqual({ tokensEnviados: 3080 + 110 + 100, salida: 145 + 13 + 9 })
    }),
  )

  it.instance("GET /session/:id/uso: 200 con la misma forma, 404 si no existe, 404 con LAZUNOX_USO=0", () =>
    Effect.gen(function* () {
      const { directory: d } = yield* TestInstance
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "ruta" })
      for (const p of PASOS) yield* paso(chat.id, p)
      const h = yield* sessions.create({ parentID: chat.id, title: "ayudante" })
      yield* paso(h.id, { input: 10, read: 0, write: 0, output: 1, reasoning: 0 })

      const ok = yield* requestInDirectory(`/session/${chat.id}/uso`, d)
      expect(ok.status).toBe(200)
      const cuerpo = yield* json<Uso.Uso>(ok)
      expect(cuerpo.sessionID).toBe(String(chat.id))
      expect(cuerpo.sesion.tokensEnviadosPorPaso).toEqual(ESPERADO.tokensEnviadosPorPaso)
      expect(cuerpo.sesion.cache.aciertoPct).toBe(59.1)
      expect(cuerpo.ayudantes).toHaveLength(1)
      expect(cuerpo.total.tokensEnviados).toBe(3090)

      expect((yield* requestInDirectory(`/session/ses_noexiste/uso`, d)).status).toBe(404)
      const apagado = yield* conEntorno("LAZUNOX_USO", "0", () => requestInDirectory(`/session/${chat.id}/uso`, d))
      expect(apagado.status).toBe(404)
    }),
  )
})

// ---------------------------------------------------------------- bucle real (proveedor HTTP falso)
describe("uso (bucle real)", () => {
  itBucle.instance("tokens por paso del proveedor; sin datos de caché si no los reporta; huella registrada por petición", () =>
    Effect.gen(function* () {
      Uso.olvidarHuellas()
      const { llm } = yield* useServerConfig()
      const { prompt, sessions, session } = yield* sesionConPeticion("busca archivos")
      yield* llm.push(reply().tool("glob", { pattern: "*.nada" }).usage({ input: 120, output: 30 }))
      yield* llm.push(reply().text("listo").usage({ input: 200, output: 10 }).stop())
      yield* prompt.loop({ sessionID: session.id })

      const uso = yield* Uso.calcular(sessions, session.id)
      expect(uso.sesion.pasos).toBe(2)
      expect(uso.porPaso.map((p) => p.enviado)).toEqual([120, 200])
      expect(uso.sesion.tokensEnviadosPorPaso).toMatchObject({ mediana: 160, p90: 200, total: 320 })
      expect(uso.sesion.salida).toBe(40)
      expect(uso.sesion.cache).toMatchObject({ datos: false, aciertoPct: null, fallos: [] })
      const huellas = uso.porPaso.map((p) => Uso.huellaRegistrada(p.mensajeID))
      expect(huellas.every((h) => h !== undefined)).toBe(true)
      expect(huellas[0]).toEqual(huellas[1]) // mismas herramientas y mismo sistema entre los dos pasos
    }),
  )
})
