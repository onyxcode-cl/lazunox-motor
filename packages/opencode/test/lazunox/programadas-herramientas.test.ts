// Ola 7, 7.12: herramientas programar / listar_programadas / borrar_programada / esperar_y_continuar y el vigilante que dispara.
// Reloj falso (reloj.ahora) y vigilante rápido (LAZUNOX_PROGRAMADAS_TICK_MS=20).
import { afterEach, beforeEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Cause, Effect, Exit } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { MessageID } from "../../src/session/schema"
import { Programadas } from "../../src/session/programadas"
import { LazunoxWake } from "../../src/tool/lazunox-wake"
import { BorrarTool, EsperarTool, ListarTool, ProgramarTool, _reiniciarParaPruebas, reloj } from "../../src/tool/programadas"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
const it = testEffect(
  LayerNode.compile(LayerNode.group([EventV2Bridge.node, CrossSpawnSpawner.node, Session.node, SessionProjector.node, SessionStatus.node, Database.node, Truncate.node, Agent.node])),
)

const relojReal = { ...reloj }
let ahora = new Date(2026, 0, 5, 10, 0, 0).getTime()
beforeEach(() => {
  process.env.LAZUNOX_PROGRAMADAS_TICK_MS = "20"
  ahora = new Date(2026, 0, 5, 10, 0, 0).getTime()
  reloj.ahora = () => ahora
  _reiniciarParaPruebas()
  LazunoxWake.resetForTests()
})
afterEach(async () => {
  delete process.env.LAZUNOX_PROGRAMADAS_TICK_MS
  reloj.ahora = relojReal.ahora
  _reiniciarParaPruebas()
  await disposeAllInstances()
})

const prompts: { agent?: string; text: string; sessionID: string }[] = []
const ops = {
  prompt: (input: { sessionID: any; agent?: string; parts: { text: string }[] }) =>
    Effect.sync(() => void prompts.push({ agent: input.agent, text: input.parts[0]!.text, sessionID: String(input.sessionID) })),
}
const asks: { permission: string; patterns: readonly string[]; always: readonly string[] }[] = []

const sesion = Effect.fn("Prog.sesion")(function* (agent = "build") {
  const sessions = yield* Session.Service
  const s = yield* sessions.create({ title: "prog" })
  yield* sessions.updateMessage({ id: MessageID.ascending(), role: "user", sessionID: s.id, agent, model: ref, time: { created: Date.now() } })
  return s
})
const ctx = (s: { id: any }, agent = "build") => ({
  sessionID: s.id, messageID: MessageID.ascending(), agent, abort: new AbortController().signal, extra: { promptOps: ops }, messages: [],
  metadata: () => Effect.void,
  ask: (r: any) => Effect.sync(() => void asks.push(r)),
})
const fallo = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(eff)
    return Exit.isSuccess(exit) ? undefined : String(Cause.squash(exit.cause))
  })
const esperarHasta = (cond: () => boolean, ms = 3000) =>
  Effect.promise(async () => {
    const fin = Date.now() + ms
    while (!cond() && Date.now() < fin) await new Promise((r) => setTimeout(r, 15))
    return cond()
  })

describe("7.12 herramientas", () => {
  it.instance("programar valida el cron ANTES de pedir permiso, y luego pide permiso `programar` sin «siempre»", () =>
    Effect.gen(function* () {
      asks.length = 0
      const s = yield* sesion()
      const def = yield* (yield* ProgramarTool).init()
      expect(yield* fallo(def.execute({ cron: "99 * * * *", tarea: "x" } as never, ctx(s) as never))).toContain("fuera de rango")
      expect(asks).toHaveLength(0)
      const r = yield* def.execute({ cron: "*/30 * * * *", tarea: "revisa el CI" } as never, ctx(s) as never)
      expect(asks).toHaveLength(1)
      expect(asks[0]).toMatchObject({ permission: "programar", patterns: ["*/30 * * * *"], always: [] })
      expect(r.output).toContain("programada")
      expect(Programadas.listar(String(s.id), ahora)).toHaveLength(1)
    }),
  )
  it.instance("si la persona niega el permiso no queda nada programado", () =>
    Effect.gen(function* () {
      const s = yield* sesion()
      const def = yield* (yield* ProgramarTool).init()
      const negar = { ...ctx(s), ask: () => Effect.fail(new Error("negado")) }
      expect(yield* fallo(def.execute({ cron: "0 9 * * *", tarea: "x" } as never, negar as never))).toContain("negado")
      expect(Programadas.listar(String(s.id), ahora)).toHaveLength(0)
    }),
  )
  it.instance("listar y borrar: solo las de esta sesión; un id ajeno da error; «todas» borra las de esta sesión", () =>
    Effect.gen(function* () {
      const a = yield* sesion()
      const b = yield* sesion()
      const prog = yield* (yield* ProgramarTool).init()
      const listar = yield* (yield* ListarTool).init()
      const borrar = yield* (yield* BorrarTool).init()
      const ta = yield* prog.execute({ cron: "0 9 * * *", tarea: "de A" } as never, ctx(a) as never)
      yield* prog.execute({ cron: "0 10 * * *", tarea: "de B" } as never, ctx(b) as never)
      const lista = (yield* listar.execute({} as never, ctx(a) as never)).output
      expect(lista).toContain("de A")
      expect(lista).not.toContain("de B")
      expect(yield* fallo(borrar.execute({ id: Programadas.listar(String(b.id), ahora)[0]!.id } as never, ctx(a) as never))).toContain("No hay ninguna tarea")
      expect(Programadas.listar(String(b.id), ahora)).toHaveLength(1)
      expect((yield* borrar.execute({ id: ta.title } as never, ctx(a) as never)).output).toContain("borrada")
      yield* prog.execute({ cron: "0 9 * * *", tarea: "otra A" } as never, ctx(a) as never)
      expect((yield* borrar.execute({ id: "todas" } as never, ctx(a) as never)).output).toContain("Borradas 1")
      expect(Programadas.listar(String(b.id), ahora)).toHaveLength(1)
      expect((yield* listar.execute({} as never, ctx(a) as never)).output).toContain("No hay tareas")
    }),
  )
  it.instance("esperar_y_continuar valida el rango y registra una espera", () =>
    Effect.gen(function* () {
      const s = yield* sesion()
      const def = yield* (yield* EsperarTool).init()
      expect(yield* fallo(def.execute({ segundos: 5, tarea: "x" } as never, ctx(s) as never))).toContain("entre 60 y 3600")
      const r = yield* def.execute({ segundos: 120, tarea: "mira el despliegue" } as never, ctx(s) as never)
      expect(r.output).toContain("despertaré")
      expect(Programadas.listar(String(s.id), ahora)[0]!.tipo).toBe("espera")
    }),
  )
  it.instance("sin promptOps (modo sin forma de despertar) la herramienta se niega y no deja nada", () =>
    Effect.gen(function* () {
      const s = yield* sesion()
      const def = yield* (yield* EsperarTool).init()
      const sin = { ...ctx(s), extra: {} }
      expect(yield* fallo(def.execute({ segundos: 120, tarea: "x" } as never, sin as never))).toContain("no están disponibles")
      expect(Programadas.listar(String(s.id), ahora)).toHaveLength(0)
    }),
  )
})

describe("7.12 el vigilante dispara", () => {
  it.instance("una espera vencida despierta la sesión con un aviso automático y se borra", () =>
    Effect.gen(function* () {
      prompts.length = 0
      const s = yield* sesion()
      const def = yield* (yield* EsperarTool).init()
      yield* def.execute({ segundos: 60, tarea: "revisa el despliegue" } as never, ctx(s) as never)
      expect(prompts).toHaveLength(0)
      ahora += 61 * 1000 + 10_000 // pasó el momento (con el retraso incluido), dentro de la gracia
      expect(yield* esperarHasta(() => prompts.length === 1)).toBe(true)
      expect(prompts[0]!.sessionID).toBe(String(s.id))
      expect(prompts[0]!.agent).toBe("build")
      expect(prompts[0]!.text).toContain("<tarea_programada")
      expect(prompts[0]!.text).toContain("No es un mensaje nuevo de la persona")
      expect(prompts[0]!.text).toContain("revisa el despliegue")
      expect(Programadas.listar(String(s.id), ahora)).toHaveLength(0)
    }),
  )
  it.instance("sesión ocupada: no dispara; al quedar libre sí (una vez)", () =>
    Effect.gen(function* () {
      prompts.length = 0
      const s = yield* sesion()
      const status = yield* SessionStatus.Service
      const def = yield* (yield* EsperarTool).init()
      yield* def.execute({ segundos: 60, tarea: "x" } as never, ctx(s) as never)
      yield* status.set(s.id, { type: "busy" })
      ahora += 70_000
      yield* Effect.promise(() => new Promise((r) => setTimeout(r, 200)))
      expect(prompts).toHaveLength(0)
      yield* status.set(s.id, { type: "idle" })
      expect(yield* esperarHasta(() => prompts.length === 1)).toBe(true)
      yield* Effect.promise(() => new Promise((r) => setTimeout(r, 200)))
      expect(prompts).toHaveLength(1)
    }),
  )
  it.instance("usa el agente que la persona usó por última vez (modo plan se respeta)", () =>
    Effect.gen(function* () {
      prompts.length = 0
      const s = yield* sesion("plan")
      const def = yield* (yield* EsperarTool).init()
      // se programó desde `build`, pero el último mensaje de la persona fue con `plan`
      yield* def.execute({ segundos: 60, tarea: "x" } as never, ctx(s, "build") as never)
      ahora += 70_000
      expect(yield* esperarHasta(() => prompts.length === 1)).toBe(true)
      expect(prompts[0]!.agent).toBe("plan")
    }),
  )
  it.instance("pasada la gracia el disparo se pierde y no se recupera", () =>
    Effect.gen(function* () {
      prompts.length = 0
      const s = yield* sesion()
      const def = yield* (yield* EsperarTool).init()
      yield* def.execute({ segundos: 60, tarea: "x" } as never, ctx(s) as never)
      ahora += 60_000 + Programadas.GRACIA_MS + 60_000
      yield* Effect.promise(() => new Promise((r) => setTimeout(r, 250)))
      expect(prompts).toHaveLength(0)
      expect(Programadas.listar(String(s.id), ahora)).toHaveLength(0)
    }),
  )
  it.instance("si la sesión ya no existe, sus tareas se descartan sin disparar", () =>
    Effect.gen(function* () {
      prompts.length = 0
      const sessions = yield* Session.Service
      const s = yield* sesion()
      const def = yield* (yield* EsperarTool).init()
      yield* def.execute({ segundos: 60, tarea: "x" } as never, ctx(s) as never)
      yield* sessions.remove(s.id)
      ahora += 70_000
      yield* Effect.promise(() => new Promise((r) => setTimeout(r, 250)))
      expect(prompts).toHaveLength(0)
      expect(Programadas.listar(String(s.id), ahora)).toHaveLength(0)
    }),
  )
})
