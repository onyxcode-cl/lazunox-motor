import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { BackgroundJob as CoreBackgroundJob } from "@opencode-ai/core/background-job"
import { InstanceState } from "@/effect/instance-state"
import { TrabajosDisco } from "@/tool/shell/trabajos-disco"
import { Effect, Exit, Layer } from "effect"

export {
  Service,
  type ExtendInput,
  type Info,
  type Interface,
  type StartInput,
  type Status,
  type WaitInput,
  type WaitResult,
} from "@opencode-ai/core/background-job"

// Lazunox (2B): marcador en disco de los ayudantes de fondo (`type: "task"` con `metadata.background === true`).
// Mismo mecanismo que shells y celdas: el marcador se escribe al lanzar y se borra cuando el ayudante termina (bien, mal o cancelado
// con `cancel`). Si el motor muere o se cierra la instancia, el marcador queda y el siguiente arranque deja la lápida «perdido»
// (`TrabajosDisco.sweepOrphans`), desde la que la app ofrece «Reanudar».

/** Tipo de trabajo de los ayudantes (el de la herramienta `task`). */
export const TASK_JOB_TYPE = "task"

/** ¿Es un ayudante de fondo con padre conocido? Es lo único que lleva marcador. */
export const esAyudanteDeFondo = (type: string, metadata?: Record<string, unknown>) =>
  type === TASK_JOB_TYPE && metadata?.["background"] === true && typeof metadata["parentSessionId"] === "string"

/** Ejecuciones pendientes por ayudante con marcador (start + extend). El marcador se borra al llegar a 0 o al primer fallo. */
const pendientes = new Map<string, number>()

const marcar = (id: string, title: string | undefined, metadata: Record<string, unknown> | undefined, directory: string) =>
  TrabajosDisco.writeMarker({
    id,
    tipo: "ayudante",
    sessionID: String(metadata?.["parentSessionId"]),
    directory,
    pid: process.pid,
    enginePid: process.pid,
    cmdline: "",
    titulo: title ?? "Ayudante",
    inicio: Date.now(),
  })

const soltar = (id: string) => {
  pendientes.delete(id)
  TrabajosDisco.removeMarker(id)
}

/**
 * Envuelve una ejecución: al terminar sin interrupción descuenta una pendiente (o suelta el marcador de golpe si falló).
 * Una interrupción NO borra el marcador: es el cierre de la instancia o del motor (un `cancel` explícito lo borra aparte).
 */
const vigilar = <E>(id: string, run: Effect.Effect<string, E>) =>
  run.pipe(
    Effect.onExit((exit) =>
      Effect.sync(() => {
        if (!pendientes.has(id) || Exit.hasInterrupts(exit)) return
        if (Exit.isFailure(exit)) return soltar(id)
        const resto = (pendientes.get(id) ?? 1) - 1
        if (resto <= 0) soltar(id)
        else pendientes.set(id, resto)
      }),
    ),
  )

/** Keeps the legacy service instance-scoped while sharing the core registry engine. */
const layer = Layer.effect(
  CoreBackgroundJob.Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make(() => CoreBackgroundJob.make)
    return CoreBackgroundJob.Service.of({
      list: () => InstanceState.useEffect(state, (jobs) => jobs.list()),
      get: (id) => InstanceState.useEffect(state, (jobs) => jobs.get(id)),
      start: (input) =>
        InstanceState.useEffect(state, (jobs) =>
          Effect.gen(function* () {
            if (!esAyudanteDeFondo(input.type, input.metadata) || !input.id || !TrabajosDisco.idValido(input.id))
              return yield* jobs.start(input)
            // Si ya hay uno vivo con ese id, `start` no lanza nada nuevo: no se toca su marcador.
            const previo = yield* jobs.get(input.id)
            if (previo?.status === "running") return yield* jobs.start(input)
            const id = input.id
            const directory = yield* InstanceState.directory
            marcar(id, input.title, input.metadata, directory)
            pendientes.set(id, 1)
            return yield* jobs.start({ ...input, run: vigilar(id, input.run) })
          }),
        ),
      extend: (input) =>
        InstanceState.useEffect(state, (jobs) =>
          Effect.gen(function* () {
            if (!pendientes.has(input.id)) return yield* jobs.extend(input)
            pendientes.set(input.id, (pendientes.get(input.id) ?? 0) + 1)
            const extendido = yield* jobs.extend({ ...input, run: vigilar(input.id, input.run) })
            if (!extendido) pendientes.set(input.id, Math.max(1, (pendientes.get(input.id) ?? 1) - 1))
            return extendido
          }),
        ),
      wait: (input) => InstanceState.useEffect(state, (jobs) => jobs.wait(input)),
      waitForPromotion: (id) => InstanceState.useEffect(state, (jobs) => jobs.waitForPromotion(id)),
      promote: (id) =>
        InstanceState.useEffect(state, (jobs) =>
          Effect.gen(function* () {
            const previo = yield* jobs.get(id)
            const info = yield* jobs.promote(id)
            // Un ayudante de primer plano que pasa a segundo plano también queda con marcador (su ejecución ya corre sin vigilar:
            // el borrado lo hacen `cancel` o el ciclo de vida al terminar, ver abajo).
            if (info && previo && previo.metadata?.["background"] !== true && esAyudanteDeFondo(info.type, info.metadata) && TrabajosDisco.idValido(id)) {
              marcar(id, info.title, info.metadata, yield* InstanceState.directory)
              pendientes.set(id, 1)
              // Sin envoltorio en la ejecución original: se vigila el final del trabajo aparte.
              yield* jobs.wait({ id }).pipe(
                Effect.flatMap((fin) =>
                  Effect.sync(() => {
                    if (fin.info && fin.info.status !== "running" && pendientes.has(id)) soltar(id)
                  }),
                ),
                Effect.forkDetach({ startImmediately: true }),
              )
            }
            return info
          }),
        ),
      cancel: (id) =>
        InstanceState.useEffect(state, (jobs) =>
          Effect.gen(function* () {
            const info = yield* jobs.cancel(id)
            // Cancelado a propósito: no es un trabajo «perdido».
            if (info && pendientes.has(id)) soltar(id)
            return info
          }),
        ),
    })
  }),
)

export const node = LayerNode.make({ service: CoreBackgroundJob.Service, layer, deps: [] })

export * as BackgroundJob from "./job"
