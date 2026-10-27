// Ola 7, paquete 7.10: ayudantes reanudables (task_id), resultado parcial con la pista para continuarlo, esfuerzo por llamada y
// toolChoice "none" en el último paso. La reanudación por task_id ya existía (revisión de seguridad H2); aquí se añade lo que faltaba.
import { afterEach, describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { esParcial, marcarParcial, ultimoPasoSinHerramientas } from "../../src/agent/parcial"
import { TaskTool, type TaskPromptOps, varianteParaEsfuerzo } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { Provider } from "@/provider/provider"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { proveedor } from "./bucle-util"

afterEach(async () => {
  delete process.env.LAZUNOX_AYUDANTE_REANUDABLE
  delete process.env.LAZUNOX_AYUDANTE_ESFUERZO
  delete process.env.LAZUNOX_MAX_SUBAGENTS
  await disposeAllInstances()
})

const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node, BackgroundJob.node, EventV2Bridge.node, Config.node, CrossSpawnSpawner.node, Session.node, SessionProjector.node,
      SessionRunState.node, SessionStatus.node, Truncate.node, Provider.node, ToolRegistry.node, Database.node, RuntimeFlags.node, Ripgrep.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)]],
  )
const it = testEffect(layer())
const background = testEffect(layer({ experimentalBackgroundSubagents: true }))

const seed = Effect.fn("Reanudable.seed")(function* () {
  const session = yield* Session.Service
  const chat = yield* session.create({ title: "Padre" })
  const user = yield* session.updateMessage({ id: MessageID.ascending(), role: "user", sessionID: chat.id, agent: "build", model: ref, time: { created: Date.now() } })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(), role: "assistant", parentID: user.id, sessionID: chat.id, mode: "build", agent: "build", cost: 0,
    path: { cwd: "/tmp", root: "/tmp" }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID, providerID: ref.providerID, variant: "xhigh", time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function respuesta(input: SessionPrompt.PromptInput, text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id, role: "assistant", parentID: input.messageID ?? MessageID.ascending(), sessionID: input.sessionID, mode: input.agent ?? "general",
      agent: input.agent ?? "general", cost: 0, path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID, time: { created: Date.now() }, finish: "stop",
    },
    parts: [{ id: `prt_${id}` as never, sessionID: input.sessionID, messageID: id, type: "text", text }],
  }
}
const ops = (onPrompt?: (i: SessionPrompt.PromptInput) => void, gate?: Promise<void>): TaskPromptOps => ({
  cancel: () => Effect.void,
  resolvePromptParts: (t) => Effect.succeed([{ type: "text" as const, text: t }]),
  prompt: (input) =>
    Effect.promise(async () => {
      onPrompt?.(input)
      if (gate) await gate
      return respuesta(input, "hecho")
    }),
})
const contexto = (chat: { id: any }, assistant: { id: any }, promptOps: TaskPromptOps) => ({
  sessionID: chat.id, messageID: assistant.id, agent: "build", abort: new AbortController().signal, extra: { promptOps },
  messages: [], metadata: () => Effect.void, ask: () => Effect.void,
})
const mensaje = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(eff)
    return exit._tag === "Success" ? undefined : String(exit.cause)
  })

describe("7.10 resultado parcial con pista para continuar (puro)", () => {
  test("lleva el task_id y cómo continuar; sin id es igual que antes; una sola cabecera", () => {
    const con = marcarParcial("lo hecho", 3, "ses_abc")
    expect(con).toContain('[PARCIAL: el ayudante llegó a su límite de 3 turnos')
    expect(con).toContain('task_id "ses_abc"')
    expect(con.endsWith("lo hecho")).toBe(true)
    expect(marcarParcial("lo hecho", 3)).not.toContain("task_id")
    expect(marcarParcial(con, 3, "ses_abc")).toBe(con)
    expect(esParcial({ maxTurns: 3, turnosDados: 3 })).toBe(true)
  })
  test("la variante pedida sale de los niveles que el modelo tiene", () => {
    expect(varianteParaEsfuerzo("bajo", ["low", "high"])).toBe("low")
    expect(varianteParaEsfuerzo("bajo", ["none", "thinking"])).toBe("none")
    expect(varianteParaEsfuerzo("medio", ["low", "high"])).toBeUndefined()
    expect(varianteParaEsfuerzo("alto", ["low", "medium", "high", "xhigh"])).toBe("high")
    expect(varianteParaEsfuerzo("alto", ["xhigh", "max"])).toBe("xhigh")
    expect(varianteParaEsfuerzo("alto", [])).toBeUndefined()
  })
  test("interruptor del último paso", () => {
    expect(ultimoPasoSinHerramientas({})).toBe(true)
    expect(ultimoPasoSinHerramientas({ LAZUNOX_ULTIMO_PASO_SIN_HERRAMIENTAS: "0" })).toBe(false)
  })
})

describe("7.10 reanudar una hija", () => {
  it.instance("misma sesión y mismo agente: conserva el historial (sesión) y no crea otra", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const hija = yield* sessions.create({ parentID: chat.id, title: "Explorar", agent: "explore" })
      const def = yield* (yield* TaskTool).init()
      let visto: SessionPrompt.PromptInput | undefined
      const r = yield* def.execute({ description: "d", prompt: "sigue", subagent_type: "explore", task_id: hija.id }, contexto(chat, assistant, ops((i) => (visto = i))))
      expect(r.metadata.sessionId).toBe(hija.id)
      expect(visto?.sessionID).toBe(hija.id)
      expect(yield* sessions.children(chat.id)).toHaveLength(1)
    }),
  )
  it.instance("otro agente distinto al de la hija: se rechaza y no se toca la sesión", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const hija = yield* sessions.create({ parentID: chat.id, title: "Explorar", agent: "explore", permission: [{ permission: "edit", pattern: "*", action: "deny" }] })
      const def = yield* (yield* TaskTool).init()
      let llamado = false
      const m = yield* mensaje(def.execute({ description: "d", prompt: "ahora edita", subagent_type: "general", task_id: hija.id }, contexto(chat, assistant, ops(() => (llamado = true)))))
      expect(m).toContain('pertenece al agente "explore"')
      expect(llamado).toBe(false)
      expect((yield* sessions.get(hija.id)).permission).toEqual([{ permission: "edit", pattern: "*", action: "deny" }])
    }),
  )
  it.instance("LAZUNOX_AYUDANTE_REANUDABLE=0 vuelve a dejar reanudar con otro agente (documenta el comportamiento de antes)", () =>
    Effect.gen(function* () {
      process.env.LAZUNOX_AYUDANTE_REANUDABLE = "0"
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const hija = yield* sessions.create({ parentID: chat.id, title: "Explorar", agent: "explore" })
      const def = yield* (yield* TaskTool).init()
      const r = yield* def.execute({ description: "d", prompt: "x", subagent_type: "general", task_id: hija.id }, contexto(chat, assistant, ops()))
      expect(r.metadata.sessionId).toBe(hija.id)
    }),
  )
  it.instance("una hija sin agente registrado (antiguas) sigue reanudándose", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const hija = yield* sessions.create({ parentID: chat.id, title: "Vieja" })
      const def = yield* (yield* TaskTool).init()
      const r = yield* def.execute({ description: "d", prompt: "x", subagent_type: "general", task_id: hija.id }, contexto(chat, assistant, ops()))
      expect(r.metadata.sessionId).toBe(hija.id)
    }),
  )
  it.instance("al reanudar nunca queda con más permisos que el padre hoy (padre en modo plan: edit denegado)", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const hija = yield* sessions.create({ parentID: chat.id, title: "General", agent: "general", permission: [{ permission: "edit", pattern: "*", action: "allow" }] })
      const def = yield* (yield* TaskTool).init()
      yield* def.execute({ description: "d", prompt: "x", subagent_type: "general", task_id: hija.id }, { ...contexto(chat, assistant, ops()), agent: "plan" })
      const despues = (yield* sessions.get(hija.id)).permission ?? []
      expect(despues.some((r) => r.permission === "edit" && r.pattern === "*" && r.action === "deny")).toBe(true)
    }),
  )
})

describe("7.10 el tope de ayudantes cuenta al reanudar", () => {
  background.instance("con el tope lleno, reanudar una hija TERMINADA en segundo plano se rechaza; reanudar la que ya corre no", () =>
    Effect.gen(function* () {
      process.env.LAZUNOX_MAX_SUBAGENTS = "1"
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const terminada = yield* sessions.create({ parentID: chat.id, title: "Terminada", agent: "general" })
      const def = yield* (yield* TaskTool).init()
      let soltar!: () => void
      const puerta = new Promise<void>((r) => (soltar = r))
      const c = contexto(chat, assistant, ops(undefined, puerta))
      const corriendo = yield* def.execute({ description: "a", prompt: "largo", subagent_type: "general", background: true }, c)
      // Tope 1 y ya hay uno vivo: reanudar la terminada en segundo plano no cabe.
      const m = yield* mensaje(def.execute({ description: "b", prompt: "x", subagent_type: "general", task_id: terminada.id, background: true }, c))
      expect(m).toContain("máximo 1")
      // Reanudar la que YA corre solo le manda contexto: no ocupa un cupo nuevo.
      const r = yield* def.execute({ description: "c", prompt: "más", subagent_type: "general", task_id: corriendo.metadata.sessionId, background: true }, c)
      expect(r.output).toContain("Background task updated")
      soltar()
    }),
  )
})

describe("7.10 esfuerzo por llamada", () => {
  const conVariantes = {
    config: {
      ...proveedor("http://localhost:1"),
    } as never,
  }
  const cfgConNiveles = (() => {
    const p = proveedor("http://localhost:1") as { provider: { test: { models: Record<string, Record<string, unknown>> } } }
    p.provider.test.models["test-model"]!.variants = { low: { x: 1 }, high: { x: 2 } }
    return { config: p as never }
  })()

  it.instance(
    "con la bandera y un modelo con niveles, el ayudante corre con la variante pedida",
    () =>
      Effect.gen(function* () {
        process.env.LAZUNOX_AYUDANTE_ESFUERZO = "1"
        const { chat, assistant } = yield* seed()
        const def = yield* (yield* TaskTool).init()
        const vistos: (string | undefined)[] = []
        const c = contexto(chat, assistant, ops((i) => vistos.push(i.variant)))
        yield* def.execute({ description: "d", prompt: "x", subagent_type: "general", esfuerzo: "bajo" } as never, c)
        yield* def.execute({ description: "d", prompt: "x", subagent_type: "general", esfuerzo: "alto" } as never, c)
        yield* def.execute({ description: "d", prompt: "x", subagent_type: "general", esfuerzo: "medio" } as never, c)
        yield* def.execute({ description: "d", prompt: "x", subagent_type: "general" } as never, c)
        // medio no existe en este modelo -> la variante de siempre (la del padre); sin esfuerzo también.
        expect(vistos).toEqual(["low", "high", "xhigh", "xhigh"])
      }),
    cfgConNiveles,
  )
  it.instance(
    "sin la bandera el campo se ignora aunque llegue",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const def = yield* (yield* TaskTool).init()
        const vistos: (string | undefined)[] = []
        yield* def.execute({ description: "d", prompt: "x", subagent_type: "general", esfuerzo: "bajo" } as never, contexto(chat, assistant, ops((i) => vistos.push(i.variant))))
        expect(vistos).toEqual(["xhigh"])
      }),
    cfgConNiveles,
  )
  it.instance("un modelo sin niveles de razonamiento: se ignora y usa la variante de siempre", () =>
    Effect.gen(function* () {
      process.env.LAZUNOX_AYUDANTE_ESFUERZO = "1"
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* TaskTool).init()
      const vistos: (string | undefined)[] = []
      yield* def.execute({ description: "d", prompt: "x", subagent_type: "general", esfuerzo: "bajo" } as never, contexto(chat, assistant, ops((i) => vistos.push(i.variant))))
      expect(vistos).toEqual(["xhigh"])
    }),
  )
})
