import { Effect } from "effect"
import { BackgroundJob } from "@/background/job"
import { ShellBackground, type TrabajoVista } from "./shell/background"
import { TrabajosDisco } from "./shell/trabajos-disco"

const CELL_JOB_TYPE = TrabajosDisco.CELL_JOB_TYPE

// Lazunox: vista unificada de los trabajos en segundo plano de una sesión (shells + celdas de Code Mode + perdidos tras reinicio).
// La usan las rutas HTTP `GET/POST /experimental/session/{sessionID}/trabajos…`.

export const TRABAJOS_MAX = 50

const celdaVista = (info: BackgroundJob.Info): TrabajoVista => {
  const titulo = typeof info.metadata?.["titulo"] === "string" ? (info.metadata["titulo"] as string) : (info.title ?? "Code Mode")
  const estado: TrabajoVista["estado"] =
    info.status === "running"
      ? "en_curso"
      : info.status === "cancelled"
        ? "terminado_por_ti"
        : info.status === "error" && /time ?out|timed out|tiempo/i.test(info.error ?? "")
          ? "tope_de_vida"
          : "terminado"
  return {
    id: info.id,
    tipo: "celda",
    titulo,
    estado,
    codigo: info.status === "completed" ? 0 : info.status === "error" ? 1 : null,
    inicio: info.started_at,
    fin: info.completed_at ?? null,
  }
}

/** Ayudante de fondo (herramienta `task` con background) de ESA sesión padre. */
const esAyudanteDe = (j: BackgroundJob.Info, sessionID: string) =>
  j.type === "task" && j.metadata?.["background"] === true && j.metadata["parentSessionId"] === sessionID

const ayudanteVista = (info: BackgroundJob.Info): TrabajoVista => ({
  id: info.id,
  tipo: "ayudante",
  titulo: (info.title ?? "Ayudante").slice(0, 200),
  estado:
    info.status === "running"
      ? "en_curso"
      : info.status === "cancelled"
        ? "terminado_por_ti"
        : "terminado",
  codigo: info.status === "completed" ? 0 : info.status === "error" ? 1 : null,
  inicio: info.started_at,
  fin: info.completed_at ?? null,
})

/** Trabajos de ESA sesión, los más recientes primero, máximo 50. */
export const listar = (jobs: BackgroundJob.Interface, sessionID: string, directory: string) =>
  Effect.gen(function* () {
    ShellBackground.sweepDirectory(directory)
    const cells = (yield* jobs.list())
      .filter((j) => j.type === CELL_JOB_TYPE && j.metadata?.["sessionID"] === sessionID)
      .map(celdaVista)
    const helpers = (yield* jobs.list()).filter((j) => esAyudanteDe(j, sessionID)).map(ayudanteVista)
    const lost: TrabajoVista[] = TrabajosDisco.tombstonesOf(sessionID).map((l) => ({
      id: l.id,
      tipo: l.tipo,
      titulo: l.titulo,
      estado: "perdido" as const,
      codigo: null,
      inicio: l.inicio,
      fin: l.hora,
    }))
    const known = new Set([...cells.map((c) => c.id), ...helpers.map((h) => h.id), ...ShellBackground.viewsForSession(sessionID).map((s) => s.id)])
    return [...ShellBackground.viewsForSession(sessionID), ...cells, ...helpers, ...lost.filter((l) => !known.has(l.id))]
      .toSorted((a, b) => b.inicio - a.inicio)
      .slice(0, TRABAJOS_MAX)
  })

/** Mata el shell, interrumpe la celda o cancela el ayudante de fondo. false si no existe, ya terminó o es de otra sesión. */
export const terminar = (jobs: BackgroundJob.Interface, sessionID: string, id: string) =>
  Effect.gen(function* () {
    if (id.startsWith("sh_")) return yield* ShellBackground.terminateForSession(sessionID, id)
    const job = yield* jobs.get(id)
    if (job && esAyudanteDe(job, sessionID) && job.status === "running") {
      yield* jobs.cancel(id)
      return true
    }
    if (!job || job.type !== CELL_JOB_TYPE || job.metadata?.["sessionID"] !== sessionID || job.status !== "running") return false
    yield* jobs.cancel(id)
    return true
  })
export * as Trabajos from "./trabajos"
