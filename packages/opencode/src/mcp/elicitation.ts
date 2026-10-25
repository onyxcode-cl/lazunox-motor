// Formularios MCP (elicitation/create, modo formulario): servicio con pendientes, eventos, tiempo de espera y topes.
//
// Diferencia deliberada con `question/index.ts`: allí, si la fibra se interrumpe, el pendiente se borra pero no se publica
// `Rejected` y la tarjeta de la app quedaría huérfana. Aquí TODO cierre que no sea una respuesta pública
// (`reply`) pasa por `cerrar`, que borra el pendiente Y publica `mcp.elicitation.rejected { reason }`.
//
// Privacidad: ni los registros ni los eventos llevan valores; solo ids, servidor y nombres de campo.
// Este servicio todavía no está conectado al cliente MCP (fase B2).
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Deferred, Duration, Effect, Layer, Option, Schema, Context } from "effect"
import { McpEvent } from "@opencode-ai/schema/mcp-event"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "@/session/schema"
import {
  tiempoMaximoMs,
  validarEsquema,
  validarMensaje,
  validarRespuesta,
  type Campo,
  type ErrorCampo,
} from "./elicitation-esquema"

export const ElicitationID = McpEvent.ElicitationID
export type ElicitationID = typeof ElicitationID.Type
export type Request = McpEvent.ElicitationRequest
export type Action = McpEvent.ElicitationAction
export type RejectReason = McpEvent.ElicitationRejectReason
export const Event = {
  Asked: McpEvent.ElicitationAsked,
  Replied: McpEvent.ElicitationReplied,
  Rejected: McpEvent.ElicitationRejected,
}

/** Topes de concurrencia (plan 3.B «Inundación de formularios»). */
export const MAX_POR_LLAMADA = 5

export type Resultado =
  | { action: "accept"; content: Record<string, string | number | boolean> }
  | { action: "decline" }
  | { action: "cancel" }

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("McpElicitation.NotFoundError", {
  requestID: ElicitationID,
}) {}

export class InvalidReplyError extends Schema.TaggedErrorClass<InvalidReplyError>()("McpElicitation.InvalidReplyError", {
  requestID: ElicitationID,
  errors: Schema.Array(Schema.Struct({ campo: Schema.String, motivo: Schema.String })),
}) {
  override get message() {
    return "La respuesta del formulario no es válida: " + this.errors.map((e) => `${e.campo} (${e.motivo})`).join(", ")
  }
}

type Cierre = { kind: "reply"; result: Resultado } | { kind: "closed"; reason: RejectReason } | { kind: "signal"; reason: RejectReason }

interface Pendiente {
  info: Request
  campos: ReadonlyArray<Campo>
  deferred: Deferred.Deferred<Cierre>
  llamada?: string
}

interface State {
  pending: Map<ElicitationID, Pendiente>
  /** Formularios ya lanzados por llamada (sessionID + callID); se limpia con `finishCall`. */
  porLlamada: Map<string, number>
}

export interface AskInput {
  sessionID: SessionID
  server: string
  callID?: string
  message: unknown
  /** `requestedSchema` tal como lo manda el servidor (sin fiar). */
  requestedSchema: unknown
  /** Por defecto `LAZUNOX_ELICITATION_TIMEOUT_MS` (600 000). */
  timeoutMs?: number
  /** Cancelación pedida por el servidor (`extra.signal` del SDK). */
  serverSignal?: AbortSignal
  /** Aborto de la llamada que está usando el conector (Esc/Detener, señal de celda). */
  callSignal?: AbortSignal
}

export interface Interface {
  /** Nunca falla: devuelve la acción que se debe contestar al servidor. Cualquier cierre sin respuesta publica `rejected`. */
  readonly ask: (input: AskInput) => Effect.Effect<Resultado>
  readonly reply: (input: {
    requestID: ElicitationID
    action: Action
    content?: unknown
  }) => Effect.Effect<void, NotFoundError | InvalidReplyError>
  /** Cierra (con `rejected`) los formularios de una sesión. Devuelve cuántos cerró. */
  readonly cancelSession: (sessionID: SessionID, reason?: RejectReason) => Effect.Effect<number>
  /** Olvida el contador de una llamada que terminó. */
  readonly finishCall: (sessionID: SessionID, callID: string) => Effect.Effect<void>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@lazunox/McpElicitation") {}

const claveLlamada = (sessionID: string, callID: string) => `${sessionID}\u0000${callID}`

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service

    // Único camino de cierre sin respuesta: borra el pendiente, publica `rejected` y despierta a quien espera.
    const cerrarEn = (pending: Map<ElicitationID, Pendiente>, id: ElicitationID, reason: RejectReason) =>
      Effect.gen(function* () {
        const item = pending.get(id)
        if (!item) return false
        pending.delete(id)
        yield* Effect.logInfo("mcp elicitation rejected", { id, reason })
        yield* events
          .publish(Event.Rejected, { id, sessionID: item.info.sessionID, reason })
          .pipe(Effect.catchCause(() => Effect.void))
        Deferred.doneUnsafe(item.deferred, Effect.succeed({ kind: "closed", reason } as Cierre))
        return true
      })

    const state = yield* InstanceState.make<State>(
      Effect.fn("McpElicitation.state")(function* () {
        const state: State = { pending: new Map(), porLlamada: new Map() }
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const id of [...state.pending.keys()]) yield* cerrarEn(state.pending, id, "abort")
            state.porLlamada.clear()
          }),
        )
        return state
      }),
    )

    // Rechazo inmediato (nunca llegó a mostrarse): publica `rejected` con un id propio y contesta `decline`.
    const rechazar = (sessionID: SessionID, reason: RejectReason, server: string, detalle: string) =>
      Effect.gen(function* () {
        const id = ElicitationID.ascending()
        yield* Effect.logWarning("mcp elicitation refused", { id, server, reason, detalle })
        yield* events
          .publish(Event.Rejected, { id, sessionID, reason })
          .pipe(Effect.catchCause(() => Effect.void))
        return { action: "decline" } as Resultado
      })

    const ask = Effect.fn("McpElicitation.ask")(function* (input: AskInput) {
      const st = yield* InstanceState.get(state)
      const { sessionID, server } = input

      const mensaje = validarMensaje(input.message)
      if (!mensaje.ok) return yield* rechazar(sessionID, "schema", server, mensaje.detalle)
      const esquema = validarEsquema(input.requestedSchema)
      if (!esquema.ok) {
        return yield* rechazar(
          sessionID,
          esquema.motivo,
          server,
          esquema.campo ? `${esquema.detalle} [campo ${esquema.campo}]` : esquema.detalle,
        )
      }

      // Topes: 1 pendiente por servidor y sesión; MAX_POR_LLAMADA por llamada.
      for (const p of st.pending.values()) {
        if (p.info.sessionID === sessionID && p.info.server === server)
          return yield* rechazar(sessionID, "ambiguous", server, "ya hay un formulario abierto de este conector")
      }
      const claveLl = input.callID ? claveLlamada(sessionID, input.callID) : undefined
      if (claveLl && (st.porLlamada.get(claveLl) ?? 0) >= MAX_POR_LLAMADA)
        return yield* rechazar(sessionID, "ambiguous", server, "demasiados formularios en una misma llamada")

      if (input.serverSignal?.aborted) return yield* rechazar(sessionID, "server-cancel", server, "ya cancelado")
      if (input.callSignal?.aborted) return yield* rechazar(sessionID, "abort", server, "llamada abortada")

      const ms = input.timeoutMs !== undefined && input.timeoutMs > 0 ? input.timeoutMs : tiempoMaximoMs()
      const id = ElicitationID.ascending()
      const deferred = yield* Deferred.make<Cierre>()
      const info: Request = {
        id,
        sessionID,
        server,
        ...(input.callID ? { callID: input.callID } : {}),
        message: mensaje.mensaje,
        fields: esquema.campos,
        expiresAt: Date.now() + ms,
      }
      st.pending.set(id, { info, campos: esquema.campos, deferred, llamada: claveLl })
      if (claveLl) st.porLlamada.set(claveLl, (st.porLlamada.get(claveLl) ?? 0) + 1)
      yield* Effect.logInfo("mcp elicitation asked", { id, server, fields: esquema.campos.map((c) => c.name) })

      const onServer = () => Deferred.doneUnsafe(deferred, Effect.succeed({ kind: "signal", reason: "server-cancel" } as Cierre))
      const onCall = () => Deferred.doneUnsafe(deferred, Effect.succeed({ kind: "signal", reason: "abort" } as Cierre))
      input.serverSignal?.addEventListener("abort", onServer, { once: true })
      input.callSignal?.addEventListener("abort", onCall, { once: true })
      // Si se abortó entre la comprobación y el registro, el oyente no dispara: se despierta a mano.
      if (input.serverSignal?.aborted) onServer()
      if (input.callSignal?.aborted) onCall()

      const cierre: Cierre = yield* Effect.gen(function* () {
        yield* events.publish(Event.Asked, info)
        const salida = yield* Deferred.await(deferred).pipe(Effect.timeoutOption(Duration.millis(ms)))
        if (Option.isSome(salida)) return salida.value
        // Tiempo agotado. Si una respuesta ganó la carrera, `cerrarEn` no hace nada y se usa su valor.
        yield* cerrarEn(st.pending, id, "timeout")
        return yield* Deferred.await(deferred)
      }).pipe(
        // Fibra interrumpida (Esc, cierre de sesión): el cierre SIEMPRE se publica.
        Effect.onInterrupt(() => cerrarEn(st.pending, id, "abort")),
        // Si fallara la publicación de `asked`, tampoco queda nada huérfano.
        Effect.onError(() => cerrarEn(st.pending, id, "abort")),
        Effect.ensuring(
          Effect.sync(() => {
            input.serverSignal?.removeEventListener("abort", onServer)
            input.callSignal?.removeEventListener("abort", onCall)
          }),
        ),
      )

      if (cierre.kind === "reply") return cierre.result
      if (cierre.kind === "signal") yield* cerrarEn(st.pending, id, cierre.reason)
      return { action: "cancel" } as Resultado
    })

    const reply = Effect.fn("McpElicitation.reply")(function* (input: {
      requestID: ElicitationID
      action: Action
      content?: unknown
    }) {
      const st = yield* InstanceState.get(state)
      const item = st.pending.get(input.requestID)
      // Una señal de cancelación ya despertó la espera: la respuesta llega tarde.
      if (!item || (yield* Deferred.isDone(item.deferred))) return yield* new NotFoundError({ requestID: input.requestID })

      let result: Resultado
      if (input.action === "accept") {
        const valida = validarRespuesta(item.campos, input.content)
        if (!valida.ok) {
          const errors: ErrorCampo[] = valida.errores
          yield* Effect.logWarning("mcp elicitation invalid reply", { id: input.requestID, fields: errors.map((e) => e.campo) })
          return yield* new InvalidReplyError({ requestID: input.requestID, errors })
        }
        result = { action: "accept", content: valida.content }
      } else {
        result = { action: input.action }
      }

      st.pending.delete(input.requestID)
      yield* Effect.logInfo("mcp elicitation replied", { id: input.requestID, action: input.action })
      yield* events
        .publish(Event.Replied, { id: item.info.id, sessionID: item.info.sessionID, action: input.action })
        .pipe(Effect.catchCause(() => Effect.void))
      Deferred.doneUnsafe(item.deferred, Effect.succeed({ kind: "reply", result } as Cierre))
    })

    const cancelSession = Effect.fn("McpElicitation.cancelSession")(function* (
      sessionID: SessionID,
      reason: RejectReason = "abort",
    ) {
      const st = yield* InstanceState.get(state)
      let n = 0
      for (const [id, p] of [...st.pending]) {
        if (p.info.sessionID !== sessionID) continue
        if (yield* cerrarEn(st.pending, id, reason)) n++
      }
      return n
    })

    const finishCall = Effect.fn("McpElicitation.finishCall")(function* (sessionID: SessionID, callID: string) {
      const st = yield* InstanceState.get(state)
      st.porLlamada.delete(claveLlamada(sessionID, callID))
    })

    const list = Effect.fn("McpElicitation.list")(function* () {
      const st = yield* InstanceState.get(state)
      return Array.from(st.pending.values(), (p) => p.info)
    })

    return Service.of({ ask, reply, cancelSession, finishCall, list })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [EventV2Bridge.node] })

export * as McpElicitation from "./elicitation"
