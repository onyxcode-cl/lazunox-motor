import "./ayudante-heredado-env"
import { afterEach, describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, Scope } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { TaskTool, renderOutput, type TaskPromptOps } from "../../src/tool/task"
import { AyudanteHeredado } from "../../src/session/heredado"
import { camposHeredar, permisoDeHija } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { Provider } from "@/provider/provider"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { InstanceState } from "@/effect/instance-state"

// Lazunox: regresiones de seguridad de la ola 2B (inyección por el sobre, lápidas forjadas, Terminar por HTTP).

const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Truncate.node,
      Provider.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)]],
  )
const bg = testEffect(layer({ experimentalBackgroundSubagents: true }))
const sinFlag = testEffect(layer())

afterEach(async () => {
  process.env.LAZUNOX_AYUDANTE_HEREDADO = "1"
  delete process.env.LAZUNOX_AYUDANTE_HEREDADO_MAX
  await disposeAllInstances()
})


const textoParte = (sessionID: SessionID, messageID: MessageID, text: string, metadata?: Record<string, unknown>) =>
  ({ id: PartID.ascending(), messageID, sessionID, type: "text", text, ...(metadata ? { metadata } : {}) }) as SessionV1.Part

/** Padre con 3 turnos; el tercero es el actual (el asistente que lanza `task`, sin texto). */
const seed = Effect.fn("HeredadoTest.seed")(function* (
  opts: { permission?: Session.Info["permission"]; metadata?: Record<string, unknown>; grande?: boolean } = {},
) {
  const session = yield* Session.Service
  const chat = yield* session.create({ title: "Padre", permission: opts.permission, metadata: opts.metadata })
  const turnos: Array<{ user: MessageID; assistant: MessageID }> = []
  for (const n of ["uno", "dos", "tres"]) {
    const user = yield* session.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID: chat.id,
      agent: "build",
      model: ref,
      time: { created: Date.now() },
    })
    yield* session.updatePart(textoParte(chat.id, user.id, `pregunta ${n}`))
    const assistant = yield* session.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      parentID: user.id,
      sessionID: chat.id,
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: Date.now() },
    } as SessionV1.Assistant)
    if (n !== "tres") {
      yield* session.updatePart(textoParte(chat.id, assistant.id, `respuesta ${n}`))
      if (n === "dos") yield* session.updatePart(textoParte(chat.id, assistant.id, "INTERNA", { lazunox_objetivo: "continuar" }))
      if (opts.grande && n === "uno") yield* session.updatePart(textoParte(chat.id, assistant.id, "x".repeat(50_000)))
    }
    turnos.push({ user: user.id, assistant: assistant.id })
  }
  return { chat, turnos, actual: turnos[2].assistant }
})

const ops = (vistos: SessionPrompt.PromptInput[]): TaskPromptOps => ({
  cancel: () => Effect.void,
  resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
  prompt: (input) => {
    vistos.push(input)
    const id = MessageID.ascending()
    return Effect.succeed({
      info: {
        id,
        role: "assistant",
        parentID: input.messageID ?? MessageID.ascending(),
        sessionID: input.sessionID,
        mode: "general",
        agent: "general",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: Date.now() },
        finish: "stop",
      },
      parts: [textoParte(input.sessionID, id, "informe")],
    } as SessionV1.WithParts)
  },
})

const ctxOf = (chatID: SessionID, messageID: MessageID, promptOps: TaskPromptOps, agent = "build") => ({
  sessionID: chatID,
  messageID,
  agent,
  abort: new AbortController().signal,
  extra: { promptOps },
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

const lanzar = (
  chat: { id: SessionID },
  actual: MessageID,
  promptOps: TaskPromptOps,
  extra: Record<string, unknown> = {},
  agent = "build",
) =>
  Effect.gen(function* () {
    const def = yield* (yield* TaskTool).init()
    const r = yield* def.execute(
      { description: "mirar", prompt: "resume los modulos", subagent_type: "general", ...extra } as any,
      ctxOf(chat.id, actual, promptOps, agent) as any,
    )
    return r.metadata.sessionId as SessionID
  })

const textos = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const ms = yield* (yield* Session.Service).messages({ sessionID })
    return ms.flatMap((m) => m.parts.filter((p) => p.type === "text").map((p: any) => p.text as string))
  })

const msg = (id: string, role: "user" | "assistant", partes: Array<{ text: string; meta?: Record<string, unknown> }>) =>
  ({
    info: { id, role },
    parts: partes.map((p, i) => ({ id: `p${i}`, type: "text", text: p.text, ...(p.meta ? { metadata: p.meta } : {}) })),
  }) as unknown as SessionV1.WithParts

describe("6.9: seleccionar (puro)", () => {
  test("quita partes internas lazunox_* y mensajes que se quedan vacíos", () => {
    const r = AyudanteHeredado.seleccionar(
      [
        msg("u1", "user", [{ text: "hola" }]),
        msg("a1", "assistant", [{ text: "ok" }, { text: "INTERNA", meta: { lazunox_presupuesto: "aviso" } }]),
        msg("u2", "user", [{ text: "sintético", meta: { lazunox_objetivo: "continuar" } }]),
      ],
      10_000,
    )
    expect(r.mensajes.map((m) => m.info.id as string)).toEqual(["u1", "a1"])
    expect(r.mensajes[1].parts.map((p: any) => p.text)).toEqual(["ok"])
    expect(r.omitidos).toBe(1)
  })
  test("el tope conserva lo más reciente y empieza en un mensaje de usuario", () => {
    const m = [
      msg("u1", "user", [{ text: "a".repeat(100) }]),
      msg("a1", "assistant", [{ text: "b".repeat(100) }]),
      msg("u2", "user", [{ text: "c".repeat(100) }]),
      msg("a2", "assistant", [{ text: "d".repeat(100) }]),
    ]
    expect(AyudanteHeredado.seleccionar(m, 250).mensajes.map((x) => x.info.id as string)).toEqual(["u2", "a2"])
    expect(AyudanteHeredado.seleccionar(m, 150).mensajes.map((x) => x.info.id as string)).toEqual([])
    expect(AyudanteHeredado.seleccionar(m, 10_000).mensajes.length).toBe(4)
  })
  test("bandera, tope por entorno y marca de fork", () => {
    const e = (v: Record<string, string>) => v as NodeJS.ProcessEnv
    expect(AyudanteHeredado.activo(e({}))).toBe(false)
    expect(AyudanteHeredado.activo(e({ LAZUNOX_AYUDANTE_HEREDADO: "true" }))).toBe(false)
    expect(AyudanteHeredado.activo(e({ LAZUNOX_AYUDANTE_HEREDADO: "1" }))).toBe(true)
    expect(AyudanteHeredado.topeBytes(e({}))).toBe(256 * 1024)
    expect(AyudanteHeredado.topeBytes(e({ LAZUNOX_AYUDANTE_HEREDADO_MAX: "1" }))).toBe(4096)
    expect(AyudanteHeredado.topeBytes(e({ LAZUNOX_AYUDANTE_HEREDADO_MAX: "99999999999" }))).toBe(4 * 1024 * 1024)
    expect(AyudanteHeredado.esFork({ lazunox_fork_de: "ses_x" })).toBe(true)
    expect(AyudanteHeredado.esFork({})).toBe(false)
    expect(AyudanteHeredado.esFork(undefined)).toBe(false)
  })
})

describe("6.9: esquema", () => {
  test("`heredar` solo existe en el esquema con la bandera", () => {
    expect(Object.keys(camposHeredar(false))).toEqual([])
    expect(Object.keys(camposHeredar(true))).toEqual(["heredar"])
  })
})

describe("6.9: task con heredar", () => {
  const permisoPadre = [
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "edit", pattern: "*", action: "deny" },
  ] as Session.Info["permission"]

  sinFlag.instance("con la bandera apagada `heredar` se ignora: la hija empieza de cero", () =>
    Effect.gen(function* () {
      delete process.env.LAZUNOX_AYUDANTE_HEREDADO
      const { chat, actual } = yield* seed()
      const vistos: SessionPrompt.PromptInput[] = []
      const hija = yield* lanzar(chat, actual, ops(vistos), { heredar: "conversacion" })
      expect(yield* textos(hija)).toEqual([])
      expect((yield* (yield* Session.Service).get(hija)).metadata?.lazunox_fork_de).toBeUndefined()
      expect(vistos[0].parts[0]).toMatchObject({ text: "resume los modulos" })
    }),
  )

  sinFlag.instance("encendida: la hija ve los mensajes del padre hasta el turno actual, sin partes internas", () =>
    Effect.gen(function* () {
      process.env.LAZUNOX_AYUDANTE_HEREDADO = "1"
      const { chat, actual } = yield* seed()
      const vistos: SessionPrompt.PromptInput[] = []
      const hija = yield* lanzar(chat, actual, ops(vistos), { heredar: "conversacion" })
      const t = yield* textos(hija)
      expect(t).toEqual(["pregunta uno", "respuesta uno", "pregunta dos", "respuesta dos", "pregunta tres"])
      expect(t).not.toContain("INTERNA")
      const info = yield* (yield* Session.Service).get(hija)
      expect(info.parentID).toBe(chat.id)
      expect(info.metadata).toEqual({ lazunox_fork_de: chat.id })
      const orden = (vistos[0].parts[0] as { text: string }).text
      expect(orden.startsWith(AyudanteHeredado.LINEA_AYUDANTE)).toBe(true)
      expect(orden.endsWith("resume los modulos")).toBe(true)
      const ms = yield* (yield* Session.Service).messages({ sessionID: hija })
      const idsHija = new Set(ms.map((m) => m.info.id))
      expect(ms.every((m) => m.info.sessionID === hija)).toBe(true)
      for (const m of ms) if (m.info.role === "assistant") expect(idsHija.has(m.info.parentID as any)).toBe(true)
      // el padre queda intacto (incluida la parte interna)
      expect(yield* textos(chat.id)).toContain("INTERNA")
    }),
  )

  sinFlag.instance("permisos: iguales a los de una hija sin herencia; no hereda permisos de sesión del padre", () =>
    Effect.gen(function* () {
      process.env.LAZUNOX_AYUDANTE_HEREDADO = "1"
      const { chat, actual } = yield* seed({ permission: permisoPadre })
      const vistos: SessionPrompt.PromptInput[] = []
      const sessions = yield* Session.Service
      const conHerencia = yield* sessions.get(yield* lanzar(chat, actual, ops(vistos), { heredar: "conversacion" }))
      const sinHerencia = yield* sessions.get(yield* lanzar(chat, actual, ops(vistos), { heredar: "nada" }))
      expect(conHerencia.permission).toEqual(sinHerencia.permission)
      const cfg = yield* (yield* Config.Service).get()
      const agents = yield* Agent.Service
      const esperado = permisoDeHija({
        cfg,
        parent: yield* sessions.get(chat.id),
        parentAgent: yield* agents.get("build"),
        next: (yield* agents.get("general"))!,
      })
      expect(conHerencia.permission).toEqual(esperado)
      expect(conHerencia.permission?.some((r) => r.permission === "bash" && r.action === "allow")).toBe(false)
      expect(conHerencia.permission?.some((r) => r.permission === "edit" && r.action === "deny")).toBe(true)
    }),
  )

  sinFlag.instance("tope del modo plan: igual con y sin herencia", () =>
    Effect.gen(function* () {
      process.env.LAZUNOX_AYUDANTE_HEREDADO = "1"
      const { chat, actual } = yield* seed()
      const vistos: SessionPrompt.PromptInput[] = []
      const sessions = yield* Session.Service
      const a = yield* sessions.get(yield* lanzar(chat, actual, ops(vistos), { heredar: "conversacion" }, "plan"))
      const b = yield* sessions.get(yield* lanzar(chat, actual, ops(vistos), {}, "plan"))
      expect(a.permission).toEqual(b.permission)
      expect(a.permission?.some((r) => r.permission === "lazunox_modo_plan" && r.action === "allow")).toBe(true)
    }),
  )

  sinFlag.instance("no hereda `revert`, metadata (presupuesto) ni lo rebobinado", () =>
    Effect.gen(function* () {
      process.env.LAZUNOX_AYUDANTE_HEREDADO = "1"
      const { chat, turnos, actual } = yield* seed({ metadata: { presupuesto: { tokens: 10 }, objetivo: "x" } })
      const sessions = yield* Session.Service
      yield* sessions.setRevert({ sessionID: chat.id, revert: { messageID: turnos[1].user }, summary: undefined })
      const vistos: SessionPrompt.PromptInput[] = []
      const hija = yield* lanzar(chat, actual, ops(vistos), { heredar: "conversacion" })
      expect(yield* textos(hija)).toEqual(["pregunta uno", "respuesta uno"])
      const info = yield* sessions.get(hija)
      expect(info.revert).toBeUndefined()
      expect(info.metadata).toEqual({ lazunox_fork_de: chat.id })
      expect((yield* sessions.get(chat.id)).revert).toBeDefined()
    }),
  )

  sinFlag.instance("un fork no puede bifurcar otra vez", () =>
    Effect.gen(function* () {
      process.env.LAZUNOX_AYUDANTE_HEREDADO = "1"
      const { chat, actual } = yield* seed()
      const vistos: SessionPrompt.PromptInput[] = []
      const hija = yield* lanzar(chat, actual, ops(vistos), { heredar: "conversacion" })
      const ms = yield* (yield* Session.Service).messages({ sessionID: hija })
      const actualHija = ms.findLast((m) => m.info.role === "assistant")!.info.id
      const def = yield* (yield* TaskTool).init()
      const r = yield* def
        .execute(
          { description: "nieto", prompt: "x", subagent_type: "general", heredar: "conversacion" } as any,
          ctxOf(hija, actualHija, ops(vistos)) as any,
        )
        .pipe(Effect.exit)
      expect(r._tag).toBe("Failure")
    }),
  )

  sinFlag.instance("tope de tamaño: se copia lo más reciente", () =>
    Effect.gen(function* () {
      process.env.LAZUNOX_AYUDANTE_HEREDADO = "1"
      process.env.LAZUNOX_AYUDANTE_HEREDADO_MAX = "10000"
      const { chat, actual } = yield* seed({ grande: true })
      const vistos: SessionPrompt.PromptInput[] = []
      const hija = yield* lanzar(chat, actual, ops(vistos), { heredar: "conversacion" })
      const t = yield* textos(hija)
      expect(t.some((x) => x.length > 1000)).toBe(false)
      expect(t[t.length - 1]).toBe("pregunta tres")
      expect(t[0]).toBe("pregunta dos")
    }),
  )

  sinFlag.instance("al reanudar con task_id no se vuelve a copiar", () =>
    Effect.gen(function* () {
      process.env.LAZUNOX_AYUDANTE_HEREDADO = "1"
      const { chat, actual } = yield* seed()
      const vistos: SessionPrompt.PromptInput[] = []
      const o = ops(vistos)
      const hija = yield* lanzar(chat, actual, o, { heredar: "conversacion" })
      const antes = (yield* textos(hija)).length
      const otra = yield* lanzar(chat, actual, o, { heredar: "conversacion", task_id: hija })
      expect(otra).toBe(hija)
      expect((yield* textos(hija)).length).toBe(antes)
    }),
  )
})
