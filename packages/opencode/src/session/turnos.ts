// Lazunox: resumen ligero por turno (qué archivos cambió cada turno de la persona) y puntos de control duraderos.
// Plan: PLAN-REBOBINAR-Y-COMPACTACION.md (2.A.2 y 2.A.3). Las rutas son `GET /experimental/session/{id}/turnos` y `…/turnos/{messageID}/diff`.
// Solo rutas y cifras (nunca el contenido), calculadas con `git diff --numstat` entre árboles: sin escanear la carpeta ni armar parches enteros.
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Context, Effect, Layer } from "effect"
import path from "path"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Snapshot } from "@/snapshot"
import { Session } from "./session"
import type { MessageID, SessionID } from "./schema"

export const ARCHIVOS_MAX = 500
export const TURNOS_MAX = 100
export const DIFF_MAX_BYTES = 1024 * 1024

/** `LAZUNOX_REBOBINAR=0` apaga las rutas nuevas (404) y la creación de puntos de control. */
export const activo = (env: NodeJS.ProcessEnv = process.env) => env.LAZUNOX_REBOBINAR !== "0"

/** Tope de puntos de control (turnos) por sesión. `LAZUNOX_CHECKPOINTS_MAX`, 100 por defecto. */
export const puntosMax = (env: NodeJS.ProcessEnv = process.env) => {
  const n = Number(env.LAZUNOX_CHECKPOINTS_MAX)
  return Number.isInteger(n) && n > 0 ? Math.min(n, 10_000) : 100
}

export type Origen = "herramienta" | "comando" | "otro"
export interface Archivo {
  file: string
  status: "added" | "deleted" | "modified"
  additions: number
  deletions: number
  origen: Origen
}
export interface Turno {
  messageID: string
  time: number
  files: Archivo[]
  truncated: boolean
  restaurable: boolean
  motivo?: string
}

export interface TurnoDatos {
  user: SessionV1.User
  mensajes: SessionV1.WithParts[]
  from?: string
  to?: string
  parches: Snapshot.Patch[]
  herramientas: { tool: string; input: unknown }[]
}

/** Agrupa los mensajes en turnos: cada mensaje de la persona con los del asistente que cuelgan de él. */
export function agrupar(messages: SessionV1.WithParts[]): TurnoDatos[] {
  const turnos = new Map<string, TurnoDatos>()
  const orden: TurnoDatos[] = []
  for (const message of messages) {
    if (message.info.role !== "user") continue
    const turno: TurnoDatos = { user: message.info, mensajes: [message], parches: [], herramientas: [] }
    turnos.set(message.info.id, turno)
    orden.push(turno)
  }
  for (const message of messages) {
    if (message.info.role !== "assistant") continue
    const turno = turnos.get(message.info.parentID)
    if (!turno) continue
    turno.mensajes.push(message)
    for (const part of message.parts) {
      if (part.type === "step-start" && part.snapshot && !turno.from) turno.from = part.snapshot
      if (part.type === "step-finish" && part.snapshot) turno.to = part.snapshot
      if (part.type === "patch") turno.parches.push({ hash: part.hash, files: [...part.files] })
      if (part.type === "tool") turno.herramientas.push({ tool: part.tool, input: part.state.input })
    }
  }
  return orden
}

/** Todos los árboles que el turno necesita para poder rebobinar y mostrar su diff. */
export const arbolesDe = (turno: TurnoDatos) =>
  Array.from(
    new Set([
      ...(turno.from ? [turno.from] : []),
      ...(turno.to ? [turno.to] : []),
      ...turno.parches.map((item) => item.hash),
      ...turno.mensajes.flatMap((message) =>
        message.parts.flatMap((part) =>
          (part.type === "step-start" || part.type === "step-finish") && part.snapshot ? [part.snapshot] : [],
        ),
      ),
    ]),
  )

const seguro = (id: string) => /^[A-Za-z0-9_-]+$/.test(id)
export const prefijoSesion = (sessionID: string) => `refs/lazunox/${sessionID}/`

/**
 * Crea las refs que impiden que `git gc` pode los árboles del turno y aplica el tope por sesión
 * (al pasarlo se borran las refs del turno más viejo: ese turno queda «solo conversación»).
 */
export const conservar = Effect.fn("Turnos.conservar")(function* (
  snapshot: Snapshot.Interface,
  sessionID: string,
  turno: TurnoDatos,
) {
  if (!activo() || !seguro(sessionID) || !seguro(turno.user.id)) return
  for (const tree of arbolesDe(turno)) {
    yield* snapshot.keep(`${prefijoSesion(sessionID)}${turno.user.id}/${tree}`, tree)
  }
  const grupos = new Set<string>()
  for (const item of yield* snapshot.refs(prefijoSesion(sessionID))) {
    const turnoID = item.ref.slice(prefijoSesion(sessionID).length).split("/")[0]
    // `revert` guarda los puntos del rebobinado (session/revert.ts), no es un turno.
    if (turnoID && turnoID !== "revert") grupos.add(turnoID)
  }
  const ordenados = Array.from(grupos).sort()
  const tope = puntosMax()
  for (const viejo of ordenados.slice(0, Math.max(0, ordenados.length - tope))) {
    if (viejo === turno.user.id) continue
    yield* snapshot.forget(`${prefijoSesion(sessionID)}${viejo}/`)
  }
})

const aRelativa = (base: string, worktree: string, file: string) =>
  path.relative(worktree, path.resolve(base, file)).replaceAll("\\", "/")

const ES_COMANDO = (tool: string) =>
  tool === "bash" || tool.startsWith("bash_") || tool === "execute" || tool === "execute_wait"

/** Archivos que una herramienta de edición del turno nombra (relativos al proyecto) y si el turno corrió comandos. */
export function origenes(turno: TurnoDatos, directory: string, worktree: string) {
  const nombrados = new Set<string>()
  let comando = false
  for (const item of turno.herramientas) {
    if (ES_COMANDO(item.tool)) comando = true
    const input = (item.input ?? {}) as Record<string, unknown>
    if ((item.tool === "edit" || item.tool === "write" || item.tool === "cuaderno_editar") && typeof input.filePath === "string") {
      nombrados.add(aRelativa(directory, worktree, input.filePath))
    }
    if (item.tool === "apply_patch" && typeof input.patchText === "string") {
      for (const match of input.patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
        nombrados.add(aRelativa(directory, worktree, match[1]!.trim()))
      }
      for (const match of input.patchText.matchAll(/^\*\*\* Move to: (.+)$/gm)) {
        nombrados.add(aRelativa(directory, worktree, match[1]!.trim()))
      }
    }
  }
  const origen = (file: string): Origen => (nombrados.has(file) ? "herramienta" : comando ? "comando" : "otro")
  return { origen }
}

export class NoEncontrado extends Error {
  readonly _tag = "TurnoNoEncontrado"
}

export interface Interface {
  readonly listar: (input: {
    sessionID: SessionID
    antesDe?: MessageID
    limite?: number
  }) => Effect.Effect<Turno[], NoEncontrado | Session.NotFound>
  readonly diff: (input: {
    sessionID: SessionID
    messageID: MessageID
    file: string
  }) => Effect.Effect<
    {
      file: string
      status: Archivo["status"]
      additions: number
      deletions: number
      patch: string
      binary: boolean
      truncated: boolean
    },
    NoEncontrado | Session.NotFound | Snapshot.ExpiredError
  >
}

export class Service extends Context.Service<Service, Interface>()("@lazunox/SessionTurnos") {}

const CACHE_MAX = 2000

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snapshot = yield* Snapshot.Service
    const config = yield* Config.Service
    const cache = new Map<string, { clave: string; filas: Snapshot.FilaNumstat[] }>()

    const filas = Effect.fnUntraced(function* (sessionID: string, turno: TurnoDatos) {
      if (!turno.from || !turno.to) return [] as Snapshot.FilaNumstat[]
      const key = `${sessionID}:${turno.user.id}`
      const clave = `${turno.from}:${turno.to}`
      const hit = cache.get(key)
      if (hit && hit.clave === clave) return hit.filas
      const nuevas = yield* snapshot.numstat(turno.from, turno.to)
      // Un resultado vacío por árbol ausente no se guarda: si el árbol reaparece (o aún no existe) se recalcula.
      if (nuevas.length) {
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string)
        cache.set(key, { clave, filas: nuevas })
      }
      return nuevas
    })

    const listar: Interface["listar"] = Effect.fn("SessionTurnos.listar")(function* (input) {
      yield* sessions.get(input.sessionID)
      const ctx = yield* InstanceState.context
      const mensajes = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
      const todos = agrupar(mensajes)
      let fin = todos.length
      if (input.antesDe) {
        const index = todos.findIndex((item) => item.user.id === input.antesDe)
        if (index < 0) return yield* Effect.fail(new NoEncontrado(`Mensaje no encontrado: ${input.antesDe}`))
        fin = index
      }
      const limite = Math.max(1, Math.min(input.limite ?? TURNOS_MAX, TURNOS_MAX))
      const inicio = Math.max(0, fin - limite)
      const ventana = todos.slice(inicio, fin)

      // «Restaurable» = git + instantáneas activas + todos los árboles de ese turno y de los posteriores siguen existiendo.
      const git = ctx.project.vcs === "git"
      const encendido = (yield* config.get()).snapshot !== false
      const motivoBase = !git ? "sin-git" : !encendido ? "sin-instantaneas" : undefined
      const existen = motivoBase
        ? new Set<string>()
        : yield* snapshot.hasMany(todos.slice(inicio).flatMap((item) => [...arbolesDe(item)]))
      const completo = new Array<boolean>(ventana.length)
      let faltaDespues = todos.slice(fin).some((item) => arbolesDe(item).some((tree) => !existen.has(tree)))
      for (let i = ventana.length - 1; i >= 0; i--) {
        const faltan = arbolesDe(ventana[i]!).some((tree) => !existen.has(tree))
        faltaDespues = faltaDespues || faltan
        completo[i] = !faltaDespues
      }

      const resultado: Turno[] = []
      for (let i = 0; i < ventana.length; i++) {
        const turno = ventana[i]!
        const rows = yield* filas(input.sessionID, turno)
        const { origen } = origenes(turno, ctx.directory, ctx.worktree)
        const archivos = rows.slice(0, ARCHIVOS_MAX).map(
          (row): Archivo => ({
            file: row.file,
            status: row.status,
            additions: row.additions,
            deletions: row.deletions,
            origen: origen(row.file),
          }),
        )
        const motivo = motivoBase ?? (completo[i] ? undefined : "caducado")
        resultado.push({
          messageID: turno.user.id,
          time: turno.user.time.created,
          files: archivos,
          truncated: rows.length > ARCHIVOS_MAX,
          restaurable: !motivo,
          ...(motivo ? { motivo } : {}),
        })
      }
      return resultado
    })

    const diff: Interface["diff"] = Effect.fn("SessionTurnos.diff")(function* (input) {
      yield* sessions.get(input.sessionID)
      const mensajes = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
      const turno = agrupar(mensajes).find((item) => item.user.id === input.messageID)
      if (!turno) return yield* Effect.fail(new NoEncontrado(`Mensaje no encontrado: ${input.messageID}`))
      if (!turno.from || !turno.to) return yield* Effect.fail(new NoEncontrado("El turno no tiene cambios registrados"))
      for (const tree of [turno.from, turno.to]) {
        if (!(yield* snapshot.has(tree))) {
          return yield* Effect.fail(
            new Snapshot.ExpiredError({ hash: tree, message: "El punto de control de este turno ya no existe." }),
          )
        }
      }
      const fila = (yield* filas(input.sessionID, turno)).find((item) => item.file === input.file)
      if (!fila) return yield* Effect.fail(new NoEncontrado(`El turno no cambió ${input.file}`))
      const parche = yield* snapshot.fileDiff(turno.from, turno.to, fila.file, DIFF_MAX_BYTES)
      return {
        file: fila.file,
        status: fila.status,
        additions: fila.additions,
        deletions: fila.deletions,
        patch: parche.patch,
        binary: parche.binary || fila.binary,
        truncated: parche.truncated,
      }
    })

    return Service.of({ listar, diff })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Session.node, Snapshot.node, Config.node],
})

export * as SessionTurnos from "./turnos"
