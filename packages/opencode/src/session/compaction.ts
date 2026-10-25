import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Session } from "./session"
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"
import { Token } from "@/util/token"
import { SessionProcessor } from "./processor"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { NotFoundError } from "@/storage/storage"

import { Effect, Layer, Context, Schema } from "effect"
import path from "node:path"
import fsp from "node:fs/promises"
import { InstanceState } from "@/effect/instance-state"
import { isOverflow as overflow, usable } from "./overflow"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Todo } from "./todo"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { buildPrompt } from "@opencode-ai/core/session/compaction"
import { SessionCompactionEvent } from "@opencode-ai/schema/session-compaction-event"
import { Database } from "@opencode-ai/core/database/database"
import { Skill } from "@/skill"
import { Instruction } from "./instruction"
import { BackgroundJob } from "@/background/job"
import { SessionStatus } from "./status"
import { Trabajos } from "@/tool/trabajos"
import { construirBloque, presupuestoBloque, reinyectarActivo, type Documento } from "./contexto-vigente"

export const Event = SessionCompactionEvent

export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const PRUNE_PROTECTED_TOOLS = ["skill"]
const MIN_PRESERVE_RECENT_TOKENS = 2_000
const MAX_PRESERVE_RECENT_TOKENS = 15_000
type Turn = {
  start: number
  end: number
  id: MessageID
}

type Tail = {
  start: number
  id: MessageID
}

type CompletedCompaction = {
  userIndex: number
  assistantIndex: number
  summary: string | undefined
}

const truncate = (value: string) =>
  value.length <= TOOL_OUTPUT_MAX_CHARS ? value : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`

const serialize = (message: SessionV1.WithParts) => {
  if (message.info.role === "user") {
    const text = message.parts
      .filter((part): part is SessionV1.TextPart => part.type === "text" && !part.ignored)
      .map((part) => part.text)
      .filter(Boolean)
      .join("\n")
    const files = message.parts.flatMap((part) =>
      part.type === "file" ? [`[Attached ${part.mime}: ${part.filename ?? "file"}]`] : [],
    )
    return [...(text ? [`[User]: ${text}`] : []), ...files].join("\n")
  }
  return message.parts
    .flatMap((part) => {
      if (part.type === "text") return part.text ? [`[Assistant]: ${part.text}`] : []
      if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
      if (part.type !== "tool") return []
      const call = `[Assistant tool call]: ${part.tool}(${JSON.stringify(part.state.input)})`
      if (part.state.status === "completed") {
        const attachments = (part.state.attachments ?? []).map(
          (item) => `[Attached ${item.mime}: ${item.filename ?? "file"}]`,
        )
        const output = part.state.time.compacted
          ? "[Old tool result content cleared]"
          : truncate([part.state.output, ...attachments].join("\n"))
        return [call, `[Tool result]: ${output}`]
      }
      if (part.state.status === "error") return [call, `[Tool error]: ${part.state.error}`]
      return [call]
    })
    .join("\n")
}

function summaryText(message: SessionV1.WithParts) {
  const text = message.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return text || undefined
}

function completedCompactions(messages: SessionV1.WithParts[]) {
  const users = new Map<MessageID, number>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (!msg.parts.some((part) => part.type === "compaction")) continue
    users.set(msg.info.id, i)
  }

  return messages.flatMap((msg, assistantIndex): CompletedCompaction[] => {
    if (msg.info.role !== "assistant") return []
    if (!msg.info.summary || !msg.info.finish || msg.info.error) return []
    const userIndex = users.get(msg.info.parentID)
    if (userIndex === undefined) return []
    return [{ userIndex, assistantIndex, summary: summaryText(msg) }]
  })
}

function preserveRecentBudget(input: { cfg: ConfigV1.Info; model: Provider.Model }) {
  return (
    input.cfg.compaction?.preserve_recent_tokens ??
    Math.min(MAX_PRESERVE_RECENT_TOKENS, Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable(input) * 0.25)))
  )
}

function turns(messages: SessionV1.WithParts[]) {
  const result: Turn[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (msg.parts.some((part) => part.type === "compaction")) continue
    result.push({
      start: i,
      end: messages.length,
      id: msg.info.id,
    })
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i].end = result[i + 1].start
  }
  return result
}

function splitTurn(input: {
  messages: SessionV1.WithParts[]
  turn: Turn
  model: Provider.Model
  budget: number
  estimate: (input: { messages: SessionV1.WithParts[]; model: Provider.Model }) => Effect.Effect<number>
}) {
  return Effect.gen(function* () {
    if (input.budget <= 0) return undefined
    if (input.turn.end - input.turn.start <= 1) return undefined
    for (let start = input.turn.start + 1; start < input.turn.end; start++) {
      const size = yield* input.estimate({
        messages: input.messages.slice(start, input.turn.end),
        model: input.model,
      })
      if (size > input.budget) continue
      return {
        start,
        id: input.messages[start]!.info.id,
      } satisfies Tail
    }
    return undefined
  })
}


/** Lazunox: «compactar hasta aquí» no se puede cumplir (mensaje inválido o la cola elegida no cabe). */
export class UpToError extends Schema.TaggedErrorClass<UpToError>()("SessionCompaction.UpToError", {
  razon: Schema.Literals(["invalido", "cola-grande"]),
  message: Schema.String,
}) {}

/** Parte de lo usable que puede ocupar la cola elegida con «compactar hasta aquí». */
export const COLA_MANUAL_MAX = 0.6

/** Quita de la lista los pares compactación + resumen ya terminados (el resumen nuevo los reemplaza). */
function sinCompactadas(history: SessionV1.WithParts[]) {
  const prior = completedCompactions(history)
  const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]))
  return { prior, visible: history.filter((_, index) => !hidden.has(index)) }
}

const esMarcador = (m: SessionV1.WithParts) => m.parts.some((p) => p.type === "compaction")

/** Tokens reales de la última respuesta terminada que no es un resumen. */
function tokensReales(messages: SessionV1.WithParts[]) {
  const last = messages.findLast((m) => m.info.role === "assistant" && m.info.finish && !m.info.summary && !m.info.error)
  if (!last || last.info.role !== "assistant") return undefined
  const t = last.info.tokens
  const total = t.total || t.input + t.output + t.cache.read + t.cache.write
  return total > 0 ? total : undefined
}

/** Habilidades cargadas (`skill`) y rutas de instrucciones adjuntadas (`read` → metadata.loaded) en los mensajes resumidos. */
function cargadoEn(messages: SessionV1.WithParts[]) {
  const habilidades = new Set<string>()
  const instrucciones = new Set<string>()
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type !== "tool" || part.state.status !== "completed") continue
      if (part.tool === "skill") {
        const nombre = part.state.metadata?.name ?? (part.state.input as { name?: unknown } | undefined)?.name
        if (typeof nombre === "string" && nombre) habilidades.add(nombre)
      }
      if (part.tool === "read") {
        const loaded = part.state.metadata?.loaded
        if (Array.isArray(loaded)) for (const p of loaded) if (typeof p === "string" && p) instrucciones.add(p)
      }
    }
  }
  return { habilidades, instrucciones }
}

/** Lo que dejó el bloque de una compactación anterior (para que la segunda no lo pierda). */
function cargadoPrevio(messages: SessionV1.WithParts[]) {
  const habilidades = new Set<string>()
  const instrucciones = new Set<string>()
  for (const msg of messages) {
    if (msg.info.role !== "user" || !esMarcador(msg)) continue
    for (const part of msg.parts) {
      if (part.type !== "text") continue
      const meta = part.metadata?.["lazunoxContextoVigente"] as { habilidades?: unknown; instrucciones?: unknown } | undefined
      if (!meta) continue
      if (Array.isArray(meta.habilidades)) for (const n of meta.habilidades) if (typeof n === "string") habilidades.add(n)
      if (Array.isArray(meta.instrucciones)) for (const n of meta.instrucciones) if (typeof n === "string") instrucciones.add(n)
    }
  }
  return { habilidades, instrucciones }
}

const INSTRUCCION_MAX_BYTES = 64 * 1024
const MAX_DOCUMENTOS = 12

export interface Interface {
  readonly isOverflow: (input: {
    tokens: SessionV1.Assistant["tokens"]
    model: Provider.Model
  }) => Effect.Effect<boolean>
  readonly prune: (input: { sessionID: SessionID }) => Effect.Effect<void>
  readonly process: (input: {
    parentID: MessageID
    messages: SessionV1.WithParts[]
    sessionID: SessionID
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<"continue" | "stop">
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    auto: boolean
    overflow?: boolean
    /** Lazunox: «compactar hasta aquí»; ya validado con `validateUpTo`. */
    tail?: MessageID
  }) => Effect.Effect<void>
  /** Lazunox: comprueba un `upTo` antes de crear la compactación (mensaje de la persona visible y cola que cabe). */
  readonly validateUpTo: (input: {
    sessionID: SessionID
    upTo: MessageID
    model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
  }) => Effect.Effect<void, UpToError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const plugin = yield* Plugin.Service
    const processors = yield* SessionProcessor.Service
    const provider = yield* Provider.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    const todos = yield* Todo.Service
    const skills = yield* Skill.Service
    const instruction = yield* Instruction.Service
    const background = yield* BackgroundJob.Service
    const statuses = yield* SessionStatus.Service
    const database = yield* Database.Service

    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: SessionV1.Assistant["tokens"]
      model: Provider.Model
    }) {
      return overflow({
        cfg: yield* config.get(),
        tokens: input.tokens,
        model: input.model,
        outputTokenMax: flags.outputTokenMax,
      })
    })

    const estimate = Effect.fn("SessionCompaction.estimate")(function* (input: {
      messages: SessionV1.WithParts[]
      model: Provider.Model
    }) {
      const msgs = yield* MessageV2.toModelMessagesEffect(input.messages, input.model)
      return Token.estimate(JSON.stringify(msgs))
    })

    const select = Effect.fn("SessionCompaction.select")(function* (input: {
      messages: SessionV1.WithParts[]
      cfg: ConfigV1.Info
      model: Provider.Model
    }) {
      const limit = input.cfg.compaction?.tail_turns
      if (limit !== undefined && limit <= 0) return { head: input.messages, tail_start_id: undefined }
      const budget = preserveRecentBudget({ cfg: input.cfg, model: input.model })
      const all = turns(input.messages)
      if (!all.length) return { head: input.messages, tail_start_id: undefined }
      const recent = limit === undefined ? all : all.slice(-limit)

      let total = 0
      let keep: Tail | undefined
      for (let i = recent.length - 1; i >= 0; i--) {
        const turn = recent[i]!
        // estimate lazily so cost stays proportional to the retained tail, not the whole session
        const size = yield* estimate({
          messages: input.messages.slice(turn.start, turn.end),
          model: input.model,
        })
        if (total + size <= budget) {
          total += size
          keep = { start: turn.start, id: turn.id }
          continue
        }
        const remaining = budget - total
        const split = yield* splitTurn({
          messages: input.messages,
          turn,
          model: input.model,
          budget: remaining,
          estimate,
        })
        if (split) keep = split
        else if (!keep) {
          yield* Effect.logInfo("tail fallback", { budget, size, total })
        }
        break
      }

      if (!keep || keep.start === 0) return { head: input.messages, tail_start_id: undefined }
      return {
        head: input.messages.slice(0, keep.start),
        tail_start_id: keep.id,
      }
    })

    // goes backwards through parts until there are PRUNE_PROTECT tokens worth of tool
    // calls, then erases output of older tool calls to free context space
    const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
      const cfg = yield* config.get()
      if (!cfg.compaction?.prune) return
      yield* Effect.logInfo("pruning")

      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return

      let total = 0
      let pruned = 0
      const toPrune: SessionV1.ToolPart[] = []
      let turns = 0

      loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
        const msg = msgs[msgIndex]
        if (msg.info.role === "user") turns++
        if (turns < 2) continue
        if (msg.info.role === "assistant" && msg.info.summary) break loop
        for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
          const part = msg.parts[partIndex]
          if (part.type !== "tool") continue
          if (part.state.status !== "completed") continue
          if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
          if (part.state.time.compacted) break loop
          const estimate = Token.estimate(part.state.output)
          total += estimate
          if (total <= PRUNE_PROTECT) continue
          pruned += estimate
          toPrune.push(part)
        }
      }

      yield* Effect.logInfo("found", { pruned, total })
      if (pruned > PRUNE_MINIMUM) {
        for (const part of toPrune) {
          if (part.state.status === "completed") {
            part.state.time.compacted = Date.now()
            yield* session.updatePart(part)
          }
        }
        yield* Effect.logInfo("pruned", { count: toPrune.length })
      }
    })

    // Lazunox: tras un resumen correcto: estima el tamaño nuevo, avisa a los plugins (`PostCompact`), reinyecta `<contexto-vigente>`
    // y guarda las métricas en la parte `compaction`. Devuelve lo que falta para el evento.
    const finalizar = Effect.fn("SessionCompaction.finalizar")(function* (input: {
      sessionID: SessionID
      parent: SessionV1.WithParts
      compactionPart: SessionV1.CompactionPart | undefined
      summaryID: MessageID
      visible: SessionV1.WithParts[]
      head: SessionV1.WithParts[]
      tailStartID: MessageID | undefined
      history: SessionV1.WithParts[]
      model: Provider.Model
      cfg: ConfigV1.Info
      base: { auto: boolean; parcial: boolean; mensajes: number; tokensAntes: number | undefined }
    }) {
      const resumen = (yield* session.messages({ sessionID: input.sessionID, limit: 8 })).find((m) => m.info.id === input.summaryID)
      const textoResumen = resumen ? (summaryText(resumen) ?? "") : ""
      const cola = input.visible.slice(input.head.length)
      const tokensCola = cola.length ? yield* estimate({ messages: cola, model: input.model }) : 0
      const sinBloque = Token.estimate(textoResumen) + tokensCola

      // Gancho de usuario `PostCompact` (también corre con la reinyección apagada: es informativo, pero su salida solo entra al bloque).
      const compactado = yield* plugin.trigger(
        "experimental.session.compacted",
        {
          sessionID: input.sessionID,
          trigger: input.base.auto ? ("auto" as const) : ("manual" as const),
          parcial: input.base.parcial,
          tokensAntes: input.base.tokensAntes,
          tokensDespues: sinBloque,
        },
        { context: [] as string[] },
      )

      let reinyectado: string[] = []
      let tokensDespues = sinBloque
      if (reinyectarActivo() && input.compactionPart) {
        const bloque = yield* armarBloque({ ...input, ganchos: compactado.context })
        if (bloque) {
          reinyectado = bloque.etiquetas
          tokensDespues = sinBloque + Token.estimate(bloque.texto)
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: input.parent.info.id,
            sessionID: input.sessionID,
            type: "text",
            synthetic: true,
            text: bloque.texto,
            metadata: { lazunoxContextoVigente: { habilidades: bloque.habilidades, instrucciones: bloque.instrucciones } },
            time: { start: Date.now(), end: Date.now() },
          })
        }
      }

      if (input.compactionPart) {
        yield* session.updatePart({
          ...input.compactionPart,
          ...(input.tailStartID ? { tail_start_id: input.tailStartID } : {}),
          lazunox: {
            auto: input.base.auto,
            parcial: input.base.parcial,
            mensajes: input.base.mensajes,
            ...(input.base.tokensAntes !== undefined ? { tokensAntes: input.base.tokensAntes } : {}),
            tokensDespues,
            reinyectado,
          },
        })
      }
      return { reinyectado, tokensDespues }
    })

    // Reúne lo que el resumen puede perder y lo ajusta al presupuesto (ver `contexto-vigente.ts`).
    const armarBloque = Effect.fn("SessionCompaction.armarBloque")(function* (input: {
      sessionID: SessionID
      head: SessionV1.WithParts[]
      history: SessionV1.WithParts[]
      model: Provider.Model
      cfg: ConfigV1.Info
      ganchos: string[]
    }) {
      const tareas = yield* todos.get(input.sessionID).pipe(Effect.orElseSucceed(() => []))

      const nuevo = cargadoEn(input.head)
      const previo = cargadoPrevio(input.history)
      const nombres = [...new Set([...previo.habilidades, ...nuevo.habilidades])].slice(0, MAX_DOCUMENTOS)
      const habilidades: Documento[] = []
      for (const nombre of nombres) {
        const info = yield* skills.get(nombre).pipe(Effect.orElseSucceed(() => undefined))
        if (info?.content?.trim()) habilidades.push({ nombre, contenido: info.content })
      }

      // Instrucciones de subcarpetas: solo dentro del proyecto, solo archivos de instrucciones reales y que no vayan ya en el sistema.
      const ctx = yield* InstanceState.context
      const raiz = yield* Effect.promise(() => fsp.realpath(ctx.directory).catch(() => path.resolve(ctx.directory)))
      const delSistema = yield* instruction.systemPaths().pipe(Effect.orElseSucceed(() => new Set<string>()))
      const rutas = [...new Set([...previo.instrucciones, ...nuevo.instrucciones])].slice(0, MAX_DOCUMENTOS * 2)
      const instrucciones: Documento[] = []
      for (const ruta of rutas) {
        if (instrucciones.length >= MAX_DOCUMENTOS) break
        const abs = path.resolve(ruta)
        if (delSistema.has(abs)) continue
        const autentico = yield* instruction.find(path.dirname(abs)).pipe(Effect.orElseSucceed(() => undefined))
        if (autentico !== abs) continue
        const real = yield* Effect.promise(() => fsp.realpath(abs).catch(() => undefined))
        if (!real || !real.startsWith(raiz + path.sep)) continue
        const contenido = yield* Effect.promise(async () => {
          const st = await fsp.stat(real).catch(() => undefined)
          if (!st?.isFile()) return ""
          const fh = await fsp.readFile(real).catch(() => undefined)
          return fh ? fh.subarray(0, INSTRUCCION_MAX_BYTES).toString("utf-8") : ""
        })
        if (contenido.trim()) instrucciones.push({ nombre: path.relative(raiz, real) || real, contenido })
      }

      // Ayudantes y trabajos en segundo plano vivos de ESTA sesión.
      const vivos = new Map<string, { id: string; titulo: string; estado: string }>()
      for (const job of yield* background.list()) {
        if (job.status !== "running") continue
        if (job.metadata?.["parentSessionId"] !== input.sessionID) continue
        vivos.set(job.id, { id: job.id, titulo: job.title ?? job.type, estado: "en curso" })
      }
      for (const hija of yield* session.children(input.sessionID).pipe(Effect.orElseSucceed(() => []))) {
        if (vivos.has(hija.id)) continue
        const estado = yield* statuses.get(hija.id)
        if (estado.type !== "idle") vivos.set(hija.id, { id: hija.id, titulo: hija.title, estado: "en curso" })
      }
      const trabajos = yield* Trabajos.listar(background, input.sessionID, ctx.directory).pipe(Effect.orElseSucceed(() => []))
      for (const t of trabajos) if (t.estado === "en_curso" && !vivos.has(t.id)) vivos.set(t.id, { id: t.id, titulo: t.titulo, estado: `en curso (${t.tipo})` })

      return construirBloque({
        tareas,
        habilidades,
        instrucciones,
        ayudantes: [...vivos.values()].slice(0, 50),
        ganchos: input.ganchos,
        presupuestoBytes: presupuestoBloque(usable({ cfg: input.cfg, model: input.model, outputTokenMax: flags.outputTokenMax })),
      })
    })

    // Lazunox: valida «compactar hasta aquí» con lo que el modelo verá hoy (mensajes visibles, sin resúmenes ya hechos).
    const validateUpTo = Effect.fn("SessionCompaction.validateUpTo")(function* (input: {
      sessionID: SessionID
      upTo: MessageID
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    }) {
      const msgs = yield* MessageV2.filterCompactedEffect(input.sessionID).pipe(Effect.provideService(Database.Service, database), Effect.orElseSucceed(() => [] as SessionV1.WithParts[]))
      const { visible } = sinCompactadas(msgs)
      const idx = visible.findIndex((m) => m.info.id === input.upTo)
      const objetivo = visible[idx]
      if (!objetivo || objetivo.info.role !== "user" || esMarcador(objetivo))
        return yield* new UpToError({ razon: "invalido", message: "El mensaje elegido no es un mensaje tuyo de esta conversación (o ya se resumió)." })
      const antes = visible.slice(0, idx).filter((m) => m.info.role === "user" && !esMarcador(m))
      if (idx === 0 || antes.length === 0)
        return yield* new UpToError({ razon: "invalido", message: "No hay nada anterior a ese mensaje que resumir; elige un mensaje más reciente." })
      const model = yield* provider.getModel(input.model.providerID, input.model.modelID).pipe(Effect.orDie)
      const cfg = yield* config.get()
      const tope = Math.floor(usable({ cfg, model, outputTokenMax: flags.outputTokenMax }) * COLA_MANUAL_MAX)
      const tamano = yield* estimate({ messages: visible.slice(idx), model })
      if (tamano > tope)
        return yield* new UpToError({ razon: "cola-grande", message: "Lo que quieres conservar ya no cabe; elige un mensaje más reciente." })
    })

    const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
      parentID: MessageID
      messages: SessionV1.WithParts[]
      sessionID: SessionID
      auto: boolean
      overflow?: boolean
    }) {
      const parent = input.messages.findLast((m) => m.info.id === input.parentID)
      if (!parent || parent.info.role !== "user") {
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      }
      const userMessage = parent.info
      const compactionPart = parent.parts.find((part): part is SessionV1.CompactionPart => part.type === "compaction")

      let messages = input.messages
      let replay:
        | {
            info: SessionV1.User
            parts: SessionV1.Part[]
          }
        | undefined
      if (input.overflow) {
        const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
        for (let i = idx - 1; i >= 0; i--) {
          const msg = input.messages[i]
          if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
            replay = { info: msg.info, parts: msg.parts }
            messages = input.messages.slice(0, i)
            break
          }
        }
        const hasContent =
          replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
        if (!hasContent) {
          replay = undefined
          messages = input.messages
        }
      }

      const agent = yield* agents.get("compaction")
      const model = agent.model
        ? yield* provider.getModel(agent.model.providerID, agent.model.modelID).pipe(Effect.orDie)
        : yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID).pipe(Effect.orDie)
      const cfg = yield* config.get()
      const history = compactionPart && messages.at(-1)?.info.id === input.parentID ? messages.slice(0, -1) : messages
      const { prior, visible } = sinCompactadas(history)
      const previousSummary = prior.at(-1)?.summary
      // Lazunox: «compactar hasta aquí»: la cola la eligió la persona; no se llama a `select`.
      const manualIdx =
        compactionPart?.manual_tail && compactionPart.tail_start_id
          ? visible.findIndex((m) => m.info.id === compactionPart.tail_start_id)
          : -1
      const selected =
        manualIdx > 0
          ? { head: visible.slice(0, manualIdx), tail_start_id: compactionPart!.tail_start_id }
          : yield* select({ messages: visible, cfg, model })
      // Allow plugins to inject context or replace compaction prompt.
      const compacting = yield* plugin.trigger(
        "experimental.session.compacting",
        { sessionID: input.sessionID },
        { context: [], prompt: undefined },
      )
      // Lazunox: el plan (lista de tareas) vive fuera de los mensajes; si no se le dice al resumen, se pierde al compactar.
      const pendientes = yield* todos.get(input.sessionID).pipe(Effect.orElseSucceed(() => []))
      const planContext: string[] = []
      if (pendientes.length > 0) {
        planContext.push(
          "Lista de tareas de la sesión (consérvala en el resumen tal cual, con el estado de cada una):\n" +
            pendientes.map((t) => `- [${t.status}] ${t.content}`).join("\n"),
        )
      }
      const msgs = structuredClone(selected.head)
      yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
      const conversation = msgs.map(serialize).filter(Boolean).join("\n\n")
      const nextPrompt =
        compacting.prompt ??
        [
          buildPrompt({
            previousSummary,
            context: [conversation],
          }),
          ...compacting.context,
          ...planContext,
        ]
          .filter(Boolean)
          .join("\n\n")
      const ctx = yield* InstanceState.context
      const msg: SessionV1.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: input.parentID,
        sessionID: input.sessionID,
        mode: "compaction",
        agent: "compaction",
        variant: userMessage.model.variant,
        summary: true,
        path: {
          cwd: ctx.directory,
          root: ctx.worktree,
        },
        cost: 0,
        tokens: {
          output: 0,
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: model.id,
        providerID: model.providerID,
        time: {
          created: Date.now(),
        },
      }
      yield* session.updateMessage(msg)
      const processor = yield* processors.create({
        assistantMessage: msg,
        sessionID: input.sessionID,
        model,
      })
      const result = yield* processor.process({
        user: userMessage,
        agent,
        sessionID: input.sessionID,
        tools: {},
        system: [],
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: [
                  nextPrompt,
                  ...(compacting.prompt ? ["The following is the conversation history:", conversation] : []),
                ]
                  .filter(Boolean)
                  .join("\n\n"),
              },
            ],
          },
        ],
        model,
      })

      if (result === "compact") {
        processor.message.error = new SessionV1.ContextOverflowError({
          message: replay
            ? "Conversation history too large to compact - exceeds model context limit"
            : "Session too large to compact - context exceeds model limit even after stripping media",
        }).toObject()
        processor.message.finish = "error"
        yield* session.updateMessage(processor.message)
        return "stop"
      }

      if (compactionPart && selected.tail_start_id && compactionPart.tail_start_id !== selected.tail_start_id) {
        yield* session.updatePart({
          ...compactionPart,
          tail_start_id: selected.tail_start_id,
        })
      }

      if (result === "continue" && input.auto) {
        if (replay) {
          const original = replay.info
          const replayMsg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: input.sessionID,
            time: { created: Date.now() },
            agent: original.agent,
            model: original.model,
            format: original.format,
            tools: original.tools,
            system: original.system,
          })
          for (const part of replay.parts) {
            if (part.type === "compaction") continue
            const replayPart =
              part.type === "file" && MessageV2.isMedia(part.mime)
                ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
                : part
            yield* session.updatePart({
              ...replayPart,
              id: PartID.ascending(),
              messageID: replayMsg.id,
              sessionID: input.sessionID,
            })
          }
        }

        if (!replay) {
          const info = yield* provider.getProvider(userMessage.model.providerID)
          if (
            (yield* plugin.trigger(
              "experimental.compaction.autocontinue",
              {
                sessionID: input.sessionID,
                agent: userMessage.agent,
                model: yield* provider
                  .getModel(userMessage.model.providerID, userMessage.model.modelID)
                  .pipe(Effect.orDie),
                provider: {
                  source: info.source,
                  info,
                  options: info.options,
                },
                message: userMessage,
                overflow: input.overflow === true,
              },
              { enabled: true },
            )).enabled
          ) {
            const continueMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: userMessage.agent,
              model: userMessage.model,
            })
            const text =
              (input.overflow
                ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
                : "") +
              "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: continueMsg.id,
              sessionID: input.sessionID,
              type: "text",
              // Internal marker for auto-compaction followups so provider plugins
              // can distinguish them from manual post-compaction user prompts.
              // This is not a stable plugin contract and may change or disappear.
              metadata: { compaction_continue: true },
              synthetic: true,
              text,
              time: {
                start: Date.now(),
                end: Date.now(),
              },
            })
          }
        }
      }

      if (processor.message.error) return "stop"
      if (result === "continue") {
        const base = {
          auto: input.auto,
          parcial: compactionPart?.manual_tail === true,
          mensajes: selected.head.length,
          tokensAntes: tokensReales(input.messages),
        }
        // La reinyección y las métricas nunca hacen fallar una compactación que ya salió bien.
        const extra = yield* finalizar({
          sessionID: input.sessionID,
          parent,
          compactionPart,
          summaryID: processor.message.id,
          visible,
          head: selected.head,
          tailStartID: selected.tail_start_id,
          history,
          model,
          cfg,
          base,
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("compaction finalize failed", { cause }).pipe(Effect.as({ reinyectado: [] as string[], tokensDespues: undefined as number | undefined })),
          ),
        )
        const metricas = { ...base, tokensDespues: extra.tokensDespues, reinyectado: extra.reinyectado }
        yield* events.publish(Event.Compacted, {
          sessionID: input.sessionID,
          ...Object.fromEntries(Object.entries(metricas).filter(([, v]) => v !== undefined)),
        })
      }
      return result
    })

    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      auto: boolean
      overflow?: boolean
      tail?: MessageID
    }) {
      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
        ...(input.tail ? { tail_start_id: input.tail, manual_tail: true } : {}),
      })
    })

    return Service.of({
      isOverflow,
      prune,
      process: processCompaction,
      create,
      validateUpTo,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Config.node,
    Session.node,
    Agent.node,
    Plugin.node,
    SessionProcessor.node,
    Provider.node,
    EventV2Bridge.node,
    RuntimeFlags.node,
    Todo.node,
    Skill.node,
    Instruction.node,
    BackgroundJob.node,
    SessionStatus.node,
    Database.node,
  ],
})

export * as SessionCompaction from "./compaction"
