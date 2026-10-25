import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Context, Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Snapshot } from "../snapshot"
import { Storage } from "@/storage/storage"
import { Session } from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID, PartID } from "./schema"
import { SessionRunState } from "./run-state"
import { SessionSummary } from "./summary"
import { InstanceState } from "@/effect/instance-state"
import path from "path"

export const RevertInput = Schema.Struct({
  sessionID: SessionID,
  messageID: MessageID,
  partID: Schema.optional(PartID),
})
export type RevertInput = Schema.Schema.Type<typeof RevertInput>

// Lazunox: lo que el revert de una sesión tocó de verdad (se guarda para deshacer SOLO eso).
type Tocados = { files: string[]; after?: string }
const tocadosKey = (sessionID: SessionID) => ["lazunox_revert", sessionID]

/** Lazunox: opciones internas (no forman parte del cuerpo HTTP de /session/revert). */
export interface RevertOptions {
  /** false = «solo conversación»: se marca el revert pero no se tocan archivos. */
  readonly files?: boolean
  /** Archivos (ruta absoluta con /) que se SALTAN, con el motivo que se informa. */
  readonly skip?: ReadonlyMap<string, string>
}

export interface Detalle {
  readonly session: Session.Info
  /** Rutas relativas al proyecto. */
  readonly restaurados: string[]
  readonly borrados: string[]
  readonly omitidos: { file: string; motivo: string }[]
}

export interface Interface {
  readonly revert: (input: RevertInput) => Effect.Effect<Session.Info, Session.BusyError | Snapshot.ExpiredError>
  readonly unrevert: (input: { sessionID: SessionID }) => Effect.Effect<Session.Info, Session.BusyError | Snapshot.ExpiredError>
  /** Lazunox: como `revert` pero con opciones e informe de lo que se hizo. */
  readonly revertir: (
    input: RevertInput,
    options?: RevertOptions,
  ) => Effect.Effect<Detalle, Session.BusyError | Snapshot.ExpiredError>
  /** Lazunox: como `unrevert` pero solo con los archivos del revert; los cambiados después se saltan salvo `sobrescribir`. */
  readonly deshacer: (input: {
    sessionID: SessionID
    sobrescribir?: ReadonlySet<string>
  }) => Effect.Effect<Detalle, Session.BusyError | Snapshot.ExpiredError>
  readonly cleanup: (session: Session.Info) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRevert") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snap = yield* Snapshot.Service
    const storage = yield* Storage.Service
    const events = yield* EventV2Bridge.Service
    const summary = yield* SessionSummary.Service
    const state = yield* SessionRunState.Service

    const relativa = (file: string) =>
      InstanceState.context.pipe(Effect.map((ctx) => path.relative(ctx.worktree, file).replaceAll("\\", "/")))
    const leerTocados = (sessionID: SessionID) =>
      storage.read<Tocados>(tocadosKey(sessionID)).pipe(Effect.catch(() => Effect.succeed(undefined as Tocados | undefined)))

    const revertir = Effect.fn("SessionRevert.revertir")(function* (input: RevertInput, options?: RevertOptions) {
      yield* state.assertNotBusy(input.sessionID)
      const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
      let lastUser: SessionV1.User | undefined
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)

      let rev: Session.Info["revert"]
      const patches: Snapshot.Patch[] = []
      for (const msg of all) {
        if (msg.info.role === "user") lastUser = msg.info
        const remaining = []
        for (const part of msg.parts) {
          if (rev) {
            if (part.type === "patch") patches.push(part)
            continue
          }

          if (!rev) {
            if ((msg.info.id === input.messageID && !input.partID) || part.id === input.partID) {
              const partID = remaining.some((item) => ["text", "tool"].includes(item.type)) ? input.partID : undefined
              rev = {
                messageID: !partID && lastUser ? lastUser.id : msg.info.id,
                partID,
              }
            }
            remaining.push(part)
          }
        }
      }

      const vacio: Detalle = { session, restaurados: [], borrados: [], omitidos: [] }
      if (!rev) return vacio

      const tocaArchivos = options?.files !== false
      rev.snapshot = session.revert?.snapshot ?? (yield* snap.track())
      const informe: { restaurados: string[]; borrados: string[]; omitidos: { file: string; motivo: string }[] } = {
        restaurados: [],
        borrados: [],
        omitidos: [],
      }
      if (tocaArchivos) {
        // Un segundo revert parte del estado de antes del primero, pero solo en los archivos que el primero tocó.
        const previos = session.revert?.snapshot ? yield* leerTocados(input.sessionID) : undefined
        if (session.revert?.snapshot && previos?.files.length) {
          yield* snap.restoreFiles(session.revert.snapshot, previos.files)
        }
        const saltar = options?.skip
        const aplicar: Snapshot.Patch[] = []
        const vistos = new Set<string>()
        for (const patch of patches) {
          const files: string[] = []
          for (const file of patch.files) {
            if (vistos.has(file)) continue
            vistos.add(file)
            const motivo = saltar?.get(file)
            if (motivo) informe.omitidos.push({ file: yield* relativa(file), motivo })
            else files.push(file)
          }
          aplicar.push({ hash: patch.hash, files })
        }
        const hecho = yield* snap.revert(aplicar)
        informe.restaurados.push(...hecho.restaurados)
        informe.borrados.push(...hecho.borrados)
        informe.omitidos.push(...hecho.omitidos)
        const tocados = Array.from(new Set(aplicar.flatMap((item) => item.files)))
        const despues = yield* snap.track()
        yield* storage
          .write(tocadosKey(input.sessionID), {
            files: Array.from(new Set([...(previos?.files ?? []), ...tocados])),
            after: despues,
          } satisfies Tocados)
          .pipe(Effect.ignore)
      }
      if (rev.snapshot) rev.diff = yield* snap.diff(rev.snapshot)
      const index = all.findIndex((msg) => msg.info.id === rev.messageID)
      const range = index < 0 ? [] : all.slice(index)
      const diffs = yield* summary.computeDiff({ messages: range })
      yield* storage.write(["session_diff", input.sessionID], diffs).pipe(Effect.ignore)
      yield* events.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: diffs })
      yield* sessions.setRevert({
        sessionID: input.sessionID,
        revert: rev,
        summary: {
          additions: diffs.reduce((sum, x) => sum + x.additions, 0),
          deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
          files: diffs.length,
        },
      })
      return { session: yield* sessions.get(input.sessionID).pipe(Effect.orDie), ...informe }
    })

    const deshacer = Effect.fn("SessionRevert.deshacer")(function* (input: {
      sessionID: SessionID
      sobrescribir?: ReadonlySet<string>
    }) {
      yield* Effect.logInfo("unreverting", { sessionID: input.sessionID })
      yield* state.assertNotBusy(input.sessionID)
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      const informe: Detalle = { session, restaurados: [], borrados: [], omitidos: [] }
      if (!session.revert) return informe
      let restaurados: string[] = []
      let borrados: string[] = []
      const omitidos: { file: string; motivo: string }[] = []
      const antes = session.revert.snapshot
      if (antes) {
        const guardado = yield* leerTocados(input.sessionID)
        // Sin registro (revert hecho con una versión anterior): todo lo que hoy difiere del estado previo.
        const archivos = guardado?.files ?? (yield* snap.patch(antes)).files
        // Lo que la persona cambió DESPUÉS del revert no se pisa salvo que lo pida.
        const cambiados = guardado?.after ? new Set((yield* snap.patch(guardado.after)).files) : new Set<string>()
        const lista: string[] = []
        for (const file of archivos) {
          if (cambiados.has(file) && !input.sobrescribir?.has(file)) omitidos.push({ file: yield* relativa(file), motivo: "conflicto" })
          else lista.push(file)
        }
        const r = yield* snap.restoreFiles(antes, lista)
        restaurados = r.restaurados
        borrados = r.borrados
        omitidos.push(...r.omitidos)
      }
      yield* sessions.clearRevert(input.sessionID)
      yield* storage.remove(tocadosKey(input.sessionID)).pipe(Effect.ignore)
      return { session: yield* sessions.get(input.sessionID).pipe(Effect.orDie), restaurados, borrados, omitidos }
    })

    const revert = Effect.fn("SessionRevert.revert")(function* (input: RevertInput) {
      return (yield* revertir(input)).session
    })

    const unrevert = Effect.fn("SessionRevert.unrevert")(function* (input: { sessionID: SessionID }) {
      return (yield* deshacer(input)).session
    })

    const cleanup = Effect.fn("SessionRevert.cleanup")(function* (session: Session.Info) {
      if (!session.revert) return
      const sessionID = session.id
      const msgs = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
      const messageID = session.revert.messageID
      const index = msgs.findIndex((msg) => msg.info.id === messageID)
      const target = index < 0 ? undefined : msgs[index]
      const remove = index < 0 ? [] : msgs.slice(index + (session.revert.partID ? 1 : 0))
      for (const msg of remove) {
        yield* sessions.removeMessage({ sessionID, messageID: msg.info.id })
      }
      if (session.revert.partID && target) {
        const partID = session.revert.partID
        const idx = target.parts.findIndex((part) => part.id === partID)
        if (idx >= 0) {
          const removeParts = target.parts.slice(idx)
          target.parts = target.parts.slice(0, idx)
          for (const part of removeParts) {
            yield* sessions.removePart({ sessionID, messageID: target.info.id, partID: part.id })
          }
        }
      }
      yield* sessions.clearRevert(sessionID)
    })

    return Service.of({ revert, unrevert, revertir, deshacer, cleanup })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Session.node, Snapshot.node, Storage.node, EventV2Bridge.node, SessionSummary.node, SessionRunState.node],
})

export * as SessionRevert from "./revert"
