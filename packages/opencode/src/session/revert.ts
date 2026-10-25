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
type Tocados = { files: string[]; after?: string; snapshot?: string }
const tocadosKey = (sessionID: SessionID) => ["lazunox_revert", sessionID]
const notaKey = (sessionID: SessionID) => ["lazunox_nota", sessionID]
const refRevert = (sessionID: SessionID, que: "snapshot" | "after") => `refs/lazunox/${sessionID}/revert/${que}`
const prefijoRevert = (sessionID: SessionID) => `refs/lazunox/${sessionID}/revert/`

/** Lazunox: opciones internas (no forman parte del cuerpo HTTP de /session/revert). */
export interface RevertOptions {
  /** false = «solo conversación»: se marca el revert pero no se tocan archivos. */
  readonly files?: boolean
  /** Archivos (ruta absoluta con /) que se SALTAN, con el motivo que se informa. */
  readonly skip?: ReadonlyMap<string, string>
  /** Archivos (ruta absoluta con /) que la persona pidió sobrescribir aunque hayan cambiado después de un rebobinado anterior. */
  readonly forzar?: ReadonlySet<string>
  /** true = restaura los archivos pero deja los mensajes (no marca `session.revert`); se deshace con `deshacer`. */
  readonly soloCodigo?: boolean
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
  readonly unrevert: (input: {
    sessionID: SessionID
  }) => Effect.Effect<Session.Info, Session.BusyError | Snapshot.ExpiredError>
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
  /** Lazunox: ¿hay un rebobinado (con o sin mensajes ocultos) que se pueda deshacer? */
  readonly hayQueDeshacer: (sessionID: SessionID) => Effect.Effect<boolean>
  /** Lazunox: nota para el modelo tras restaurar solo el código; se entrega UNA vez con el siguiente mensaje de la persona. */
  readonly guardarNota: (sessionID: SessionID, texto: string) => Effect.Effect<void>
  readonly consumirNota: (sessionID: SessionID) => Effect.Effect<string | undefined>
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
      storage
        .read<Tocados>(tocadosKey(sessionID))
        .pipe(Effect.catch(() => Effect.succeed(undefined as Tocados | undefined)))

    /** Falla CERRADO: si falta cualquiera de los árboles no se toca nada (ExpiredError → 409 caducado). */
    const exigirArboles = Effect.fnUntraced(function* (hashes: (string | undefined)[]) {
      for (const hash of new Set(hashes.filter((item): item is string => !!item))) {
        if (!(yield* snap.has(hash))) {
          return yield* Effect.fail(
            new Snapshot.ExpiredError({
              hash,
              message: `El punto de control ${hash.slice(0, 12)} ya no existe (caducó o se limpió). No se cambió ningún archivo.`,
            }),
          )
        }
      }
    })

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
        // Antes de tocar nada: deben existir TODOS los árboles (el anterior, el de los parches y el de después del primer revert).
        yield* exigirArboles([
          previos?.files.length ? session.revert?.snapshot : undefined,
          previos?.files.length ? previos.after : undefined,
          ...patches.filter((patch) => patch.files.length).map((patch) => patch.hash),
        ])
        const saltar = options?.skip
        if (session.revert?.snapshot && previos?.files.length) {
          // Lo que cambió después del primer rebobinado no se pisa sin que la persona lo pida (igual que en deshacer).
          const cambiadosDespues = previos.after
            ? new Set((yield* snap.patchEstricto(previos.after)).files)
            : new Set<string>()
          const lista: string[] = []
          for (const file of previos.files) {
            const motivo = saltar?.get(file)
            if (motivo) informe.omitidos.push({ file: yield* relativa(file), motivo })
            else if (cambiadosDespues.has(file) && !options?.forzar?.has(file))
              informe.omitidos.push({ file: yield* relativa(file), motivo: "conflicto" })
            else lista.push(file)
          }
          yield* snap.restoreFiles(session.revert.snapshot, lista)
        }
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
        // Un archivo se informa una sola vez (puede salir del restaurado previo y del nuevo).
        const dicho = new Set<string>()
        informe.omitidos = informe.omitidos.filter((item) => !dicho.has(item.file) && !!dicho.add(item.file))
        const tocados = Array.from(new Set(aplicar.flatMap((item) => item.files)))
        const despues = yield* snap.track()
        // Que `git gc` no pode el estado de antes ni el de después mientras se pueda deshacer.
        if (rev.snapshot) yield* snap.keep(refRevert(input.sessionID, "snapshot"), rev.snapshot)
        if (despues) yield* snap.keep(refRevert(input.sessionID, "after"), despues)
        yield* storage
          .write(tocadosKey(input.sessionID), {
            files: Array.from(new Set([...(previos?.files ?? []), ...tocados])),
            after: despues,
            ...(options?.soloCodigo ? { snapshot: rev.snapshot } : {}),
          } satisfies Tocados)
          .pipe(Effect.ignore)
        // «Solo código»: los mensajes se quedan; no hay revert pendiente que marcar.
        if (options?.soloCodigo) return { session, ...informe }
      }
      if (!tocaArchivos) {
        // «Solo conversación»: ningún archivo cambió, así que deshacer tampoco debe tocar ninguno.
        // (si ya había un registro de un rebobinado anterior con archivos, se conserva)
        if (!(yield* leerTocados(input.sessionID))) {
          yield* storage.write(tocadosKey(input.sessionID), { files: [] } satisfies Tocados).pipe(Effect.ignore)
        }
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
      const guardado = yield* leerTocados(input.sessionID)
      // Sin revert pendiente solo se deshace un «solo código» (su registro lleva el estado de antes).
      if (!session.revert && !guardado?.snapshot) return informe
      let restaurados: string[] = []
      let borrados: string[] = []
      const omitidos: { file: string; motivo: string }[] = []
      const antes = session.revert?.snapshot ?? guardado?.snapshot
      if (antes) {
        // Sin registro (revert hecho con una versión anterior): todo lo que hoy difiere del estado previo.
        const archivos = guardado?.files ?? (yield* snap.patchEstricto(antes)).files
        // Falla CERRADO: si hay archivos que restaurar y falta el estado de antes o el de después, no se toca nada (409 caducado).
        // («solo conversación» no toca archivos: su deshacer no depende de ningún árbol.)
        if (archivos.length) yield* exigirArboles([antes, guardado?.after])
        // Lo que la persona cambió DESPUÉS del revert no se pisa salvo que lo pida.
        const cambiados = guardado?.after ? new Set((yield* snap.patchEstricto(guardado.after)).files) : new Set<string>()
        const lista: string[] = []
        for (const file of archivos) {
          if (cambiados.has(file) && !input.sobrescribir?.has(file))
            omitidos.push({ file: yield* relativa(file), motivo: "conflicto" })
          else lista.push(file)
        }
        const r = yield* snap.restoreFiles(antes, lista)
        restaurados = r.restaurados
        borrados = r.borrados
        omitidos.push(...r.omitidos)
      }
      if (session.revert) yield* sessions.clearRevert(input.sessionID)
      yield* storage.remove(tocadosKey(input.sessionID)).pipe(Effect.ignore)
      yield* snap.forget(prefijoRevert(input.sessionID)).pipe(Effect.ignore)
      yield* storage.remove(notaKey(input.sessionID)).pipe(Effect.ignore)
      return { session: yield* sessions.get(input.sessionID).pipe(Effect.orDie), restaurados, borrados, omitidos }
    })

    const hayQueDeshacer = Effect.fn("SessionRevert.hayQueDeshacer")(function* (sessionID: SessionID) {
      const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
      if (session.revert) return true
      return !!(yield* leerTocados(sessionID))?.snapshot
    })

    const guardarNota = Effect.fn("SessionRevert.guardarNota")(function* (sessionID: SessionID, texto: string) {
      yield* storage.write(notaKey(sessionID), { texto }).pipe(Effect.ignore)
    })

    const consumirNota = Effect.fn("SessionRevert.consumirNota")(function* (sessionID: SessionID) {
      const nota = yield* storage
        .read<{ texto: string }>(notaKey(sessionID))
        .pipe(Effect.catch(() => Effect.succeed(undefined as { texto: string } | undefined)))
      if (!nota?.texto) return undefined
      yield* storage.remove(notaKey(sessionID)).pipe(Effect.ignore)
      return nota.texto
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
      // Sin «solo código» pendiente ya no hay nada que deshacer: se sueltan las refs del revert.
      if (!(yield* leerTocados(sessionID))?.snapshot) yield* snap.forget(prefijoRevert(sessionID)).pipe(Effect.ignore)
    })

    return Service.of({ revert, unrevert, revertir, deshacer, hayQueDeshacer, guardarNota, consumirNota, cleanup })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Session.node, Snapshot.node, Storage.node, EventV2Bridge.node, SessionSummary.node, SessionRunState.node],
})

export * as SessionRevert from "./revert"
