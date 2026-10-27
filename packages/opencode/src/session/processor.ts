import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Image } from "@/image/image"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Deferred, Effect, Exit, Layer, Context, Scope, Schema } from "effect"
import * as Stream from "effect/Stream"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Snapshot } from "@/snapshot"
import { Session } from "./session"
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import { isOverflow } from "./overflow"
import { PartID } from "./schema"
import type { SessionID } from "./schema"
import { SessionRetry } from "./retry"
import * as Respaldo from "./respaldo"
import * as Presupuesto from "./presupuesto"
import * as SalidaCortada from "./salida-cortada"
import * as Uso from "./uso"
import { entradaGuardada, metadatosGuardados, textoParaElModelo, textoGuardado } from "./sanitizar-partes"
import { SessionStatus } from "./status"
import { SessionSummary } from "./summary"
import type { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { Usage, type LLMEvent } from "@opencode-ai/llm"

const DOOM_LOOP_THRESHOLD = 3
export type Result = "compact" | "stop" | "continue"

export interface Handle {
  readonly message: SessionV1.Assistant
  readonly updateToolCall: (
    toolCallID: string,
    update: (part: SessionV1.ToolPart) => SessionV1.ToolPart,
  ) => Effect.Effect<SessionV1.ToolPart | undefined>
  readonly completeToolCall: (
    toolCallID: string,
    output: {
      title: string
      metadata: Record<string, any>
      output: string
      attachments?: SessionV1.FilePart[]
    },
  ) => Effect.Effect<void>
  readonly process: (streamInput: LLM.StreamInput) => Effect.Effect<Result>
}

type Input = {
  assistantMessage: SessionV1.Assistant
  sessionID: SessionID
  model: Provider.Model
  /** Lazunox (6.10): respaldos válidos (solo config GLOBAL, coste cero). Sin él no hay respaldo. */
  respaldo?: Respaldo.Resolutor
}

export interface Interface {
  readonly create: (input: Input) => Effect.Effect<Handle>
}

type ToolCall = {
  partID: SessionV1.ToolPart["id"]
  messageID: SessionV1.ToolPart["messageID"]
  sessionID: SessionV1.ToolPart["sessionID"]
  done: Deferred.Deferred<void>
}

interface ProcessorContext extends Input {
  toolcalls: Record<string, ToolCall>
  shouldBreak: boolean
  snapshot: string | undefined
  blocked: boolean
  needsCompaction: boolean
  currentText: SessionV1.TextPart | undefined
  reasoningMap: Record<string, SessionV1.ReasoningPart>
  // Lazunox (3B): presupuesto de la sesión (metadata.presupuesto). Sin él, todo esto queda inerte.
  presupuesto: { cfg: Presupuesto.Config; est: Presupuesto.Estado } | undefined
  agotado: Presupuesto.Dimension | undefined
  textoPaso: string
  // Lazunox (7.4): argumentos tal como llegaron en la transmisión, por llamada, del paso en curso.
  crudo: Record<string, { name: string; raw: string }>
}

type StreamEvent = LLMEvent

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionProcessor") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const config = yield* Config.Service
    const snapshot = yield* Snapshot.Service
    const agents = yield* Agent.Service
    const llm = yield* LLM.Service
    const permission = yield* Permission.Service
    const plugin = yield* Plugin.Service
    const summary = yield* SessionSummary.Service
    const scope = yield* Scope.Scope
    const status = yield* SessionStatus.Service
    const image = yield* Image.Service
    const events = yield* EventV2Bridge.Service
    const database = yield* Database.Service

    const create = Effect.fn("SessionProcessor.create")(function* (input: Input) {
      // Pre-capture snapshot before the LLM stream starts. The AI SDK
      // may execute tools internally before emitting start-step events,
      // so capturing inside the event handler can be too late.
      const initialSnapshot = yield* snapshot.track()
      const ctx: ProcessorContext = {
        assistantMessage: input.assistantMessage,
        sessionID: input.sessionID,
        model: input.model,
        toolcalls: {},
        shouldBreak: false,
        snapshot: initialSnapshot,
        blocked: false,
        needsCompaction: false,
        currentText: undefined,
        reasoningMap: {},
        presupuesto: undefined,
        agotado: undefined,
        textoPaso: "",
        crudo: {},
      }
      let aborted = false

      const parse = (e: unknown) =>
        MessageV2.fromError(e, {
          providerID: ctx.model.providerID,
          aborted,
        })

      const settleToolCall = Effect.fn("SessionProcessor.settleToolCall")(function* (toolCallID: string) {
        const done = ctx.toolcalls[toolCallID]?.done
        delete ctx.toolcalls[toolCallID]
        if (done) yield* Deferred.succeed(done, undefined).pipe(Effect.ignore)
      })

      const readToolCall = Effect.fn("SessionProcessor.readToolCall")(function* (toolCallID: string) {
        const call = ctx.toolcalls[toolCallID]
        if (!call) return undefined
        const part = yield* session.getPart({
          partID: call.partID,
          messageID: call.messageID,
          sessionID: call.sessionID,
        })
        if (!part || part.type !== "tool") {
          delete ctx.toolcalls[toolCallID]
          return undefined
        }
        return { call, part }
      })

      // Lazunox (7.5, nivel 1): lo que se muestra y se guarda de la llamada (comando, título, metadatos) sale sin secretos.
      const limpiarParte = (part: SessionV1.ToolPart): SessionV1.ToolPart => {
        const state = part.state
        if (state.status === "pending") return part
        const input = entradaGuardada(part.tool, state.input)
        const metadata = state.metadata && metadatosGuardados(state.metadata)
        if (state.status === "error") return { ...part, state: { ...state, input, metadata } }
        return { ...part, state: { ...state, input, metadata, title: state.title && textoGuardado(state.title) } } as SessionV1.ToolPart
      }

      const updateToolCall = Effect.fn("SessionProcessor.updateToolCall")(function* (
        toolCallID: string,
        update: (part: SessionV1.ToolPart) => SessionV1.ToolPart,
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match) return undefined
        const part = yield* session.updatePart(limpiarParte(update(match.part)))
        ctx.toolcalls[toolCallID] = {
          ...match.call,
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        return part
      })

      const completeToolCall = Effect.fn("SessionProcessor.completeToolCall")(function* (
        toolCallID: string,
        output: {
          title: string
          metadata: Record<string, any>
          output: string
          attachments?: SessionV1.FilePart[]
        },
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return
        yield* session.updatePart(
          limpiarParte({
            ...match.part,
            state: {
              status: "completed",
              input: match.part.state.input,
              output: textoParaElModelo(match.part.tool, output.output),
              metadata: output.metadata,
              title: output.title,
              time: { start: match.part.state.time.start, end: Date.now() },
              attachments: output.attachments,
            },
          }),
        )
        yield* settleToolCall(toolCallID)
      })

      const failToolCall = Effect.fn("SessionProcessor.failToolCall")(function* (toolCallID: string, error: unknown) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return false
        yield* session.updatePart(
          limpiarParte({
            ...match.part,
            state: {
              status: "error",
              input: match.part.state.input,
              error: textoParaElModelo(match.part.tool, errorMessage(error)),
              // Keep metadata streamed while running so failures retain progress detail (e.g. execute's child calls).
              metadata: match.part.state.metadata,
              time: { start: match.part.state.time.start, end: Date.now() },
            },
          }),
        )
        if (error instanceof PermissionV1.RejectedError || error instanceof Question.RejectedError) {
          ctx.blocked = ctx.shouldBreak
        }
        yield* settleToolCall(toolCallID)
        return true
      })

      const finishReasoning = Effect.fn("SessionProcessor.finishReasoning")(function* (reasoningID: string) {
        if (!(reasoningID in ctx.reasoningMap)) return
        // oxlint-disable-next-line no-self-assign -- reactivity trigger
        ctx.reasoningMap[reasoningID].text = ctx.reasoningMap[reasoningID].text
        ctx.reasoningMap[reasoningID].time = { ...ctx.reasoningMap[reasoningID].time, end: Date.now() }
        yield* session.updatePart(ctx.reasoningMap[reasoningID])
        delete ctx.reasoningMap[reasoningID]
      })

      const ensureToolCall = Effect.fn("SessionProcessor.ensureToolCall")(function* (input: {
        id: string
        name: string
        providerExecuted?: boolean
      }) {
        const existing = yield* readToolCall(input.id)
        if (existing) {
          if (!input.providerExecuted || existing.part.metadata?.providerExecuted) return existing
          const part = yield* session.updatePart({
            ...existing.part,
            metadata: { ...existing.part.metadata, providerExecuted: true },
          })
          ctx.toolcalls[input.id] = {
            ...existing.call,
            partID: part.id,
            messageID: part.messageID,
            sessionID: part.sessionID,
          }
          return { call: ctx.toolcalls[input.id], part }
        }
        const part = yield* session.updatePart({
          id: PartID.ascending(),
          messageID: ctx.assistantMessage.id,
          sessionID: ctx.assistantMessage.sessionID,
          type: "tool",
          tool: input.name,
          callID: input.id,
          state: { status: "pending", input: {}, raw: "" },
          metadata: input.providerExecuted ? { providerExecuted: true } : undefined,
        } satisfies SessionV1.ToolPart)
        ctx.toolcalls[input.id] = {
          done: yield* Deferred.make<void>(),
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        return { call: ctx.toolcalls[input.id], part }
      })

      const isFilePart = (value: unknown): value is SessionV1.FilePart => Schema.is(SessionV1.FilePart)(value)

      const toolResultOutput = (
        value: Extract<StreamEvent, { type: "tool-result" }>,
      ): { title: string; metadata: Record<string, any>; output: string; attachments?: SessionV1.FilePart[] } => {
        if (isRecord(value.result.value) && typeof value.result.value.output === "string") {
          return {
            title: typeof value.result.value.title === "string" ? value.result.value.title : value.name,
            metadata: isRecord(value.result.value.metadata) ? value.result.value.metadata : {},
            output: value.result.value.output,
            attachments: Array.isArray(value.result.value.attachments)
              ? value.result.value.attachments.filter(isFilePart)
              : undefined,
          }
        }
        return {
          title: value.name,
          metadata: value.result.type === "json" && isRecord(value.result.value) ? value.result.value : {},
          output:
            typeof value.result.value === "string" ? value.result.value : (JSON.stringify(value.result.value) ?? ""),
        }
      }

      // Lazunox (3B): texto visible de la propia sesión (aviso al 80 % y «presupuesto agotado»), marcado en metadata para que la app lo pinte.
      const textoPresupuesto = Effect.fn("SessionProcessor.textoPresupuesto")(function* (
        texto: string,
        tipo: "aviso" | "agotado",
      ) {
        const now = Date.now()
        yield* session.updatePart({
          id: PartID.ascending(),
          messageID: ctx.assistantMessage.id,
          sessionID: ctx.assistantMessage.sessionID,
          type: "text",
          text: texto,
          time: { start: now, end: now },
          metadata: { lazunox_presupuesto: tipo },
        })
      })

      // Lazunox (6.10): aviso visible de que este turno se hizo con el modelo de respaldo; la app lo pinta con `lazunox_respaldo`.
      const avisoRespaldo = Effect.fn("SessionProcessor.avisoRespaldo")(function* (
        de: Provider.Model,
        a: Provider.Model,
        motivo: Respaldo.Motivo,
      ) {
        const now = Date.now()
        yield* session.updatePart({
          id: PartID.ascending(),
          messageID: ctx.assistantMessage.id,
          sessionID: ctx.assistantMessage.sessionID,
          type: "text",
          text: Respaldo.textoAviso(de, a),
          time: { start: now, end: now },
          metadata: {
            lazunox_respaldo: { de: `${de.providerID}/${de.id}`, a: `${a.providerID}/${a.id}`, motivo },
          },
        })
        yield* session.updateMessage(ctx.assistantMessage)
      })

      // Lazunox (7.4): el paso terminó por límite de salida. Cada llamada cuyos argumentos quedaron incompletos se cierra como ERROR con un
      // mensaje que pide dividir el trabajo (con un extracto de lo recibido). Solo cambia el estado de la llamada: nada se reejecuta, y
      // una llamada con argumentos completos (y su resultado) no se toca.
      const cerrarLlamadasCortadas = Effect.fn("SessionProcessor.cerrarLlamadasCortadas")(function* () {
        const parts = yield* MessageV2.parts(ctx.assistantMessage.id).pipe(Effect.provideService(Database.Service, database))
        for (const part of parts) {
          if (part.type !== "tool" || part.metadata?.providerExecuted) continue
          const visto = ctx.crudo[part.callID]
          if (!visto) continue
          const estado = part.state.status
          if (estado === "completed" && part.tool !== "invalid") continue
          const incompleta =
            estado === "pending" ? true : SalidaCortada.argumentosIncompletos(visto.raw)
          if (!incompleta) continue
          const tool = part.tool === "invalid" ? visto.name : part.tool
          const end = Date.now()
          yield* session.updatePart({
            ...part,
            tool,
            state: {
              status: "error",
              input: {},
              error: textoGuardado(SalidaCortada.mensajeHerramienta(tool, visto.raw)),
              metadata: { lazunox_salida_cortada: true },
              time: { start: "time" in part.state ? part.state.time.start : end, end },
            },
          })
          yield* settleToolCall(part.callID)
        }
      })

      const handleEvent = Effect.fnUntraced(function* (value: StreamEvent) {
        switch (value.type) {
          case "reasoning-start":
            if (value.id in ctx.reasoningMap) return
            ctx.reasoningMap[value.id] = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "reasoning",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            yield* session.updatePart(ctx.reasoningMap[value.id])
            return

          case "reasoning-delta":
            // Match dev: silently drop orphan deltas (no preceding reasoning-start).
            if (!(value.id in ctx.reasoningMap)) return
            ctx.reasoningMap[value.id].text += value.text
            if (value.providerMetadata) ctx.reasoningMap[value.id].metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.reasoningMap[value.id].sessionID,
              messageID: ctx.reasoningMap[value.id].messageID,
              partID: ctx.reasoningMap[value.id].id,
              field: "text",
              delta: value.text,
            })
            return

          case "reasoning-end":
            if (value.providerMetadata && value.id in ctx.reasoningMap) {
              ctx.reasoningMap[value.id].metadata = value.providerMetadata
            }
            yield* finishReasoning(value.id)
            return

          case "tool-input-start":
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            ctx.crudo[value.id] = { name: value.name, raw: "" }
            yield* ensureToolCall(value)
            return

          case "tool-input-delta":
            if (ctx.crudo[value.id]) ctx.crudo[value.id].raw += value.text
            yield* ensureToolCall(value)
            return

          case "tool-input-end": {
            yield* ensureToolCall(value)
            return
          }

          case "tool-call": {
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            yield* ensureToolCall(value)
            const input = isRecord(value.input) ? value.input : { value: value.input }
            yield* updateToolCall(value.id, (match) => ({
              ...match,
              tool: value.name,
              state:
                match.state.status === "running"
                  ? { ...match.state, input }
                  : {
                      status: "running",
                      input,
                      time: { start: Date.now() },
                    },
              metadata: match.metadata?.providerExecuted
                ? { ...value.providerMetadata, providerExecuted: true }
                : value.providerMetadata,
            }))

            const parts = yield* MessageV2.parts(ctx.assistantMessage.id).pipe(
              Effect.provideService(Database.Service, database),
            )
            const recentParts = parts.slice(-DOOM_LOOP_THRESHOLD)

            if (
              recentParts.length !== DOOM_LOOP_THRESHOLD ||
              !recentParts.every(
                (part) =>
                  part.type === "tool" &&
                  part.tool === value.name &&
                  part.state.status !== "pending" &&
                  JSON.stringify(part.state.input) === JSON.stringify(input),
              )
            ) {
              return
            }

            const agent = yield* agents.get(ctx.assistantMessage.agent)
            yield* permission.ask({
              permission: "doom_loop",
              patterns: [value.name],
              sessionID: ctx.assistantMessage.sessionID,
              metadata: { tool: value.name, input },
              always: [value.name],
              ruleset: agent.permission,
            })
            return
          }

          case "tool-result": {
            const toolCall = yield* readToolCall(value.id)
            if (!toolCall && value.result.type === "error") return
            if (value.result.type === "error") {
              yield* failToolCall(value.id, value.result.value)
              return
            }
            const rawOutput = toolResultOutput(value)
            const normalized = yield* Effect.forEach(rawOutput.attachments ?? [], (attachment) =>
              attachment.mime.startsWith("image/")
                ? image.normalize(attachment).pipe(
                    Effect.catchIf(
                      (error) => error instanceof Image.ResizerUnavailableError,
                      () => Effect.succeed(attachment),
                    ),
                    Effect.exit,
                  )
                : Effect.succeed(Exit.succeed<SessionV1.FilePart>(attachment)),
            )
            const omitted = normalized.filter(Exit.isFailure).length
            const attachments = normalized.filter(Exit.isSuccess).map((item) => item.value)
            const output = {
              ...rawOutput,
              output:
                omitted === 0
                  ? rawOutput.output
                  : `${rawOutput.output}\n\n[${omitted} image${omitted === 1 ? "" : "s"} omitted: could not be resized below the image size limit.]`,
              attachments: attachments.length ? attachments : undefined,
            }
            yield* completeToolCall(value.id, output)
            return
          }

          case "tool-error": {
            yield* failToolCall(value.id, value.error ?? new Error(value.message))
            return
          }

          case "provider-error":
            throw new Error(value.message)

          case "step-start":
            if (!ctx.snapshot) ctx.snapshot = yield* snapshot.track()
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              snapshot: ctx.snapshot,
              type: "step-start",
            })
            return

          case "step-finish": {
            const completedSnapshot = yield* snapshot.track()
            yield* Effect.forEach(Object.keys(ctx.reasoningMap), finishReasoning)
            // Anthropic reports thinking blocks it removed before the model saw the
            // prompt. Prefix mismatches mean opencode changed history behind a signed
            // block; log them so the churn can be tracked down.
            const dropped = isRecord(value.providerMetadata?.anthropic)
              ? value.providerMetadata.anthropic.inputTransformations
              : undefined
            if (Array.isArray(dropped) && dropped.length > 0) {
              yield* Effect.logWarning("thinking blocks dropped by provider", {
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.id,
                model: ctx.model.id,
                transformations: JSON.stringify(dropped),
              })
            }
            const usage = Session.getUsage({
              model: ctx.model,
              usage: value.usage ?? new Usage({}),
              metadata: value.providerMetadata,
            })
            ctx.assistantMessage.finish = value.reason
            ctx.assistantMessage.cost += usage.cost
            ctx.assistantMessage.tokens = usage.tokens
            yield* session.updatePart({
              id: PartID.ascending(),
              reason: value.reason,
              snapshot: completedSnapshot,
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "step-finish",
              tokens: usage.tokens,
              cost: usage.cost,
            })
            yield* session.updateMessage(ctx.assistantMessage)
            if (ctx.snapshot) {
              const patch = yield* snapshot.patch(ctx.snapshot)
              if (patch.files.length) {
                yield* session.updatePart({
                  id: PartID.ascending(),
                  messageID: ctx.assistantMessage.id,
                  sessionID: ctx.sessionID,
                  type: "patch",
                  hash: patch.hash,
                  files: patch.files,
                })
              }
              ctx.snapshot = undefined
            }
            if (value.reason === "length" && SalidaCortada.activo()) yield* cerrarLlamadasCortadas()
            ctx.crudo = {}
            yield* summary
              .summarize({
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.parentID,
              })
              .pipe(Effect.ignore, Effect.forkIn(scope))
            if (ctx.presupuesto) {
              const { cfg, est } = ctx.presupuesto
              const nuevas = Presupuesto.registrarPaso(est, cfg, Presupuesto.tokensDelPaso(usage.tokens))
              // Solo se corta o se avisa si la ejecución iba a seguir (otro paso o continuación por longitud).
              const seguiria = value.reason === "tool-calls" || (value.reason === "length" && cfg.continuar)
              const dim = seguiria ? Presupuesto.agotada(est, cfg) : undefined
              if (dim) ctx.agotado = dim
              else if (seguiria && nuevas.length) yield* textoPresupuesto(Presupuesto.textoAviso(est, cfg, nuevas), "aviso")
            }
            if (
              !ctx.assistantMessage.summary &&
              isOverflow({ cfg: yield* config.get(), tokens: usage.tokens, model: ctx.model })
            ) {
              ctx.needsCompaction = true
            }
            return
          }

          case "text-start":
            ctx.currentText = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "text",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            yield* session.updatePart(ctx.currentText)
            return

          case "text-delta":
            if (!ctx.currentText) return
            ctx.currentText.text += value.text
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.currentText.sessionID,
              messageID: ctx.currentText.messageID,
              partID: ctx.currentText.id,
              field: "text",
              delta: value.text,
            })
            return

          case "text-end":
            if (!ctx.currentText) return
            // oxlint-disable-next-line no-self-assign -- reactivity trigger
            ctx.currentText.text = ctx.currentText.text
            ctx.currentText.text = (yield* plugin.trigger(
              "experimental.text.complete",
              {
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.id,
                partID: ctx.currentText.id,
              },
              { text: ctx.currentText.text },
            )).text
            {
              const end = Date.now()
              ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
            }
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* session.updatePart(ctx.currentText)
            ctx.textoPaso += ctx.currentText.text
            ctx.currentText = undefined
            return

          case "finish":
            return
        }
      })

      const cleanup = Effect.fn("SessionProcessor.cleanup")(function* () {
        if (ctx.snapshot) {
          const patch = yield* snapshot.patch(ctx.snapshot)
          if (patch.files.length) {
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              type: "patch",
              hash: patch.hash,
              files: patch.files,
            })
          }
          ctx.snapshot = undefined
        }

        if (ctx.currentText) {
          const end = Date.now()
          ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
          yield* session.updatePart(ctx.currentText)
          ctx.currentText = undefined
        }

        for (const part of Object.values(ctx.reasoningMap)) {
          const end = Date.now()
          yield* session.updatePart({
            ...part,
            time: { start: part.time.start ?? end, end },
          })
        }
        ctx.reasoningMap = {}

        yield* Effect.forEach(
          Object.values(ctx.toolcalls),
          (call) => Deferred.await(call.done).pipe(Effect.timeout("250 millis"), Effect.ignore),
          { concurrency: "unbounded" },
        )

        for (const toolCallID of Object.keys(ctx.toolcalls)) {
          const match = yield* readToolCall(toolCallID)
          if (!match) continue
          const part = match.part
          const end = Date.now()
          const metadata = "metadata" in part.state && isRecord(part.state.metadata) ? part.state.metadata : {}
          yield* session.updatePart({
            ...part,
            state: {
              ...part.state,
              status: "error",
              error: "Tool execution aborted",
              metadata: { ...metadata, interrupted: true },
              time: { start: "time" in part.state ? part.state.time.start : end, end },
            },
          })
        }
        ctx.toolcalls = {}
        ctx.assistantMessage.time.completed = Date.now()
        yield* session.updateMessage(ctx.assistantMessage)
      })

      const halt = Effect.fn("SessionProcessor.halt")(function* (e: unknown) {
        yield* Effect.logError("process", {
          "session.id": input.sessionID,
          messageID: input.assistantMessage.id,
          error: errorMessage(e),
          stack: e instanceof Error ? e.stack : undefined,
        })
        const error = parse(e)
        if (SessionV1.ContextOverflowError.isInstance(error)) {
          if ((yield* config.get()).compaction?.auto === false && !ctx.assistantMessage.summary) {
            ctx.assistantMessage.error = error
            ctx.assistantMessage.finish = "error"
            yield* events.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
            yield* status.set(ctx.sessionID, { type: "idle" })
            return
          }
          ctx.needsCompaction = true
          yield* events.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
          return
        }
        ctx.assistantMessage.error = error
        yield* events.publish(Session.Event.Error, {
          sessionID: ctx.assistantMessage.sessionID,
          error: ctx.assistantMessage.error,
        })
        yield* status.set(ctx.sessionID, { type: "idle" })
      })

      const process = Effect.fn("SessionProcessor.process")(function* (streamInput: LLM.StreamInput) {
        yield* Effect.logInfo("process", {
          "session.id": input.sessionID,
          messageID: input.assistantMessage.id,
        })
        ctx.needsCompaction = false
        // Lazunox (7.18): huella de herramientas y sistema de esta petición, para explicar fallos de caché (solo en memoria).
        Uso.registrarHuella(String(ctx.assistantMessage.id), Uso.huellaDe({ system: streamInput.system, tools: streamInput.tools }))
        ctx.agotado = undefined
        ctx.presupuesto = undefined
        {
          const cfg = Presupuesto.leer(
            (yield* session.get(ctx.sessionID).pipe(Effect.catch(() => Effect.succeed(undefined))))?.metadata,
          )
          if (cfg) ctx.presupuesto = { cfg, est: Presupuesto.estado(ctx.sessionID, cfg) }
        }
        ctx.shouldBreak = (yield* config.get()).experimental?.continue_loop_on_deny !== true

        // Lazunox (6.10): respaldos válidos (config GLOBAL, coste cero). Si ya hubo un cambio en este turno de la persona,
        // los pasos siguientes siguen con ese modelo y no hay un segundo cambio.
        let candidatos: Provider.Model[] = []
        let consentido = false
        if (input.respaldo) {
          const r = yield* input.respaldo(ctx.model)
          candidatos = r.modelos
          consentido = r.otroProveedor
        }
        let conmutado = false
        const previo = candidatos.length ? Respaldo.modeloVigente(ctx.sessionID, streamInput.user.id) : undefined
        if (previo) {
          const cand = candidatos.find((m) => `${m.providerID}/${m.id}` === previo)
          if (cand && Respaldo.admitir(cand, ctx.model, consentido)) {
            ctx.model = cand
            ctx.assistantMessage.providerID = cand.providerID
            ctx.assistantMessage.modelID = cand.id
            streamInput = { ...streamInput, model: cand }
          }
          conmutado = true
          candidatos = []
        }

        return yield* Effect.gen(function* () {
          const intento = (parar: (e: SessionRetry.Err) => boolean) => Effect.gen(function* () {
            ctx.currentText = undefined
            ctx.reasoningMap = {}
            yield* status.set(ctx.sessionID, { type: "busy" })
            // Lazunox (3B): si el presupuesto ya estaba agotado, ni se llama al modelo.
            if (ctx.presupuesto) ctx.agotado = Presupuesto.agotada(ctx.presupuesto.est, ctx.presupuesto.cfg)
            let entrada = streamInput
            let continuaciones = 0
            while (!ctx.agotado) {
              ctx.textoPaso = ""
              yield* llm.stream(entrada).pipe(
                Stream.tap((event) => handleEvent(event)),
                Stream.takeUntil(() => ctx.needsCompaction || ctx.agotado !== undefined),
                Stream.runDrain,
              )
              // Lazunox (3B, P11): respuesta cortada por longitud -> continuar (máx. 2) con un mensaje fijo.
              if (
                !ctx.presupuesto?.cfg.continuar ||
                ctx.assistantMessage.finish !== "length" ||
                ctx.agotado ||
                ctx.needsCompaction ||
                ctx.assistantMessage.error ||
                Object.keys(ctx.toolcalls).length > 0 ||
                continuaciones >= Presupuesto.MAX_CONTINUACIONES
              )
                break
              continuaciones++
              const abierto = ctx.currentText as SessionV1.TextPart | undefined
              if (abierto) {
                const end = Date.now()
                abierto.time = { start: abierto.time?.start ?? end, end }
                yield* session.updatePart(abierto)
                ctx.textoPaso += abierto.text
                ctx.currentText = undefined
              }
              entrada = {
                ...streamInput,
                messages: [
                  ...streamInput.messages,
                  ...(ctx.textoPaso ? [{ role: "assistant" as const, content: ctx.textoPaso }] : []),
                  { role: "user" as const, content: Presupuesto.MENSAJE_CONTINUACION },
                ],
              }
            }
            if (ctx.agotado && ctx.presupuesto) {
              yield* textoPresupuesto(Presupuesto.textoAgotado(ctx.presupuesto.est, ctx.presupuesto.cfg, ctx.agotado), "agotado")
              ctx.assistantMessage.finish = "stop"
            }
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                aborted = true
                if (!ctx.assistantMessage.error) {
                  yield* halt(new DOMException("Aborted", "AbortError"))
                }
              }),
            ),
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) => Effect.fail(Cause.squash(cause)),
            ),
            Effect.retry(
              SessionRetry.policy({
                provider: ctx.model.providerID,
                parse,
                stop: parar,
                set: (info) => {
                  return status.set(ctx.sessionID, {
                    type: "retry",
                    attempt: info.attempt,
                    message: info.message,
                    action: info.action,
                    next: info.next,
                  })
                },
              }),
            ),
          )
          // Lazunox (6.10): con respaldo disponible, la cuota agotada no espera horas: se pasa al respaldo de inmediato.
          // El segundo intento (ya con el respaldo) no vuelve a conmutar y tampoco espera por cuota.
          yield* intento((e) => candidatos.length > 0 && Respaldo.esCuota(e, ctx.model.providerID)).pipe(
            Effect.catch((e) =>
              Effect.gen(function* () {
                const error = parse(e)
                const original = ctx.model
                const motivo = aborted ? undefined : Respaldo.motivoDe(error, original.providerID)
                const otro = motivo
                  ? candidatos.find((m) => Respaldo.admitir(m, original, consentido))
                  : undefined
                if (!motivo || !otro || conmutado) return yield* Effect.fail(e)
                conmutado = true
                yield* Effect.logWarning("respaldo de modelo", {
                  "session.id": ctx.sessionID,
                  de: `${original.providerID}/${original.id}`,
                  a: `${otro.providerID}/${otro.id}`,
                  motivo,
                })
                // Estado del intento caído: texto/razonamiento abiertos y llamadas a herramientas sin cerrar.
                ctx.currentText = undefined
                ctx.reasoningMap = {}
                ctx.model = otro
                ctx.assistantMessage.providerID = otro.providerID
                ctx.assistantMessage.modelID = otro.id
                streamInput = { ...streamInput, model: otro }
                Respaldo.recordar(ctx.sessionID, streamInput.user.id, otro)
                yield* intento((er) => Respaldo.esCuota(er, ctx.model.providerID))
                yield* avisoRespaldo(original, otro, motivo)
              }),
            ),
            Effect.catch(halt),
            Effect.ensuring(cleanup()),
          )

          if (ctx.agotado) return "stop"
          if (ctx.needsCompaction) return "compact"
          if (ctx.blocked || ctx.assistantMessage.error) return "stop"
          return "continue"
        })
      })

      return {
        get message() {
          return ctx.assistantMessage
        },
        updateToolCall,
        completeToolCall,
        process,
      } satisfies Handle
    })

    return Service.of({ create })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Session.node,
    Config.node,
    Snapshot.node,
    Agent.node,
    LLM.node,
    Permission.node,
    Plugin.node,
    SessionSummary.node,
    SessionStatus.node,
    Image.node,
    EventV2Bridge.node,
    Database.node,
  ],
})

export * as SessionProcessor from "./processor"
