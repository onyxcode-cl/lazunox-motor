import { Effect } from "effect"
import fs from "node:fs"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"

// Lazunox: registro de shells en segundo plano (pausa y espera al estilo Codex, lectura incremental al estilo Claude Code).
// Vive en el proceso del motor: no es durable. Cada trabajo escribe su salida a un archivo con tope y se lee por desplazamiento.

const fromEnv = (name: string, fallback: number) => {
  const n = Number(process.env[name])
  return Number.isInteger(n) && n > 0 ? n : fallback
}

export const BG_MAX_PER_SESSION = 3
export const BG_MAX_PER_ENGINE = 6
export const bgMaxLifeMs = () => fromEnv("LAZUNOX_SHELL_BG_MAX_MS", 30 * 60 * 1000)
export const bgMaxOutput = () => fromEnv("LAZUNOX_SHELL_BG_MAX_OUTPUT", 10 * 1024 * 1024)
export const DEFAULT_YIELD_MS = 10_000
export const MIN_YIELD_MS = 1_000

export const clampYield = (value: number | undefined) => {
  const requested = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_YIELD_MS
  return Math.min(Math.max(requested, MIN_YIELD_MS), 10 * 60 * 1000)
}

export type EndReason = "exit" | "terminated" | "lifetime"

export type Job = {
  id: string
  sessionID: string
  directory: string
  command: string
  startedAt: number
  file: string
  written: number
  capped: boolean
  readOffset: number
  running: boolean
  code: number | null
  reason?: EndReason
  finishedAt?: number
  /** El modelo ya leyó el resultado final (shell_wait) o lo terminó él: no se avisa. */
  consumed?: boolean
  /** Ya se mandó el aviso de fin (uno por trabajo). */
  notified?: boolean
  finished: Promise<void>
  /** Mata el grupo de procesos y libera el scope. Idempotente. */
  kill: Effect.Effect<void>
}

const jobs = new Map<string, Job>()

export const get = (id: string) => jobs.get(id)
export const all = () => [...jobs.values()]
export const running = () => all().filter((job) => job.running)

export const newId = () => `sh_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

export const fileFor = (id: string) => path.join(Global.Path.tmp, `shell-bg-${id}.log`)

/** Devuelve el mensaje de error si no se puede lanzar otro trabajo, o undefined si hay cupo. */
export const quota = (sessionID: string) => {
  const live = running()
  const mine = live.filter((job) => job.sessionID === sessionID)
  if (mine.length >= BG_MAX_PER_SESSION)
    return `Ya hay ${mine.length} shells en segundo plano en esta sesión (${mine.map((j) => j.id).join(", ")}). Espera a que terminen con shell_wait o termina alguno con terminate: true.`
  if (live.length >= BG_MAX_PER_ENGINE)
    return `Ya hay ${live.length} shells en segundo plano en el motor (tope ${BG_MAX_PER_ENGINE}). Espera a que termine alguno o termínalo con shell_wait y terminate: true.`
}

export const append = (job: Job, chunk: string) => {
  if (job.capped) return
  const max = bgMaxOutput()
  let buf = Buffer.from(chunk, "utf-8")
  if (job.written + buf.length > max) {
    buf = buf.subarray(0, Math.max(0, max - job.written))
    job.capped = true
  }
  if (buf.length === 0) return
  try {
    fs.appendFileSync(job.file, buf)
    job.written += buf.length
  } catch {
    job.capped = true
  }
}

/** Lee lo escrito desde la última lectura. Si es más que `maxBytes` entrega la cola e indica cuánto se omitió. */
export const readNew = (job: Job, maxBytes: number) => {
  const total = job.written - job.readOffset
  if (total <= 0) return { text: "", skipped: 0 }
  const take = Math.min(total, maxBytes)
  const start = job.written - take
  const buf = Buffer.alloc(take)
  let fd: number | undefined
  try {
    fd = fs.openSync(job.file, "r")
    fs.readSync(fd, buf, 0, take, start)
  } catch {
    return { text: "", skipped: total }
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
  job.readOffset = job.written
  return { text: buf.toString("utf-8"), skipped: total - take }
}

/** Cola de la salida sin mover el desplazamiento de lectura (para el aviso de fin). */
export const peekTail = (job: Job, maxBytes: number) => {
  const take = Math.min(job.written, maxBytes)
  if (take <= 0) return ""
  const buf = Buffer.alloc(take)
  let fd: number | undefined
  try {
    fd = fs.openSync(job.file, "r")
    fs.readSync(fd, buf, 0, take, job.written - take)
  } catch {
    return ""
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
  return buf.toString("utf-8")
}

export const removeFile = (job: Job) => {
  try {
    fs.rmSync(job.file, { force: true })
  } catch {}
}

/** Borra los trabajos terminados hace más de una hora (y su archivo). */
export const prune = (now = Date.now()) => {
  for (const job of all()) {
    if (job.running || !job.finishedAt || now - job.finishedAt < 60 * 60 * 1000) continue
    removeFile(job)
    jobs.delete(job.id)
  }
}

export const register = (job: Job) => void jobs.set(job.id, job)

/** Al terminar la instancia: mata sus trabajos vivos y borra sus archivos. */
export const disposeDirectory = (directory: string) =>
  Effect.gen(function* () {
    for (const job of all()) {
      if (job.directory !== directory) continue
      if (job.running) yield* job.kill
      removeFile(job)
      jobs.delete(job.id)
    }
  })

export const statusLine = (job: Job) => {
  if (job.running) return `Comando en curso (shell_id=${job.id}). No lo vuelvas a lanzar: usa shell_wait con este shell_id para seguir esperando y leer la salida nueva, o terminate: true para pararlo.`
  if (job.reason === "terminated") return `Comando terminado por ti con terminate (shell_id=${job.id}). Lo que ya había hecho no se deshizo.`
  if (job.reason === "lifetime")
    return `Comando terminado por exceder el tope de vida de ${Math.round(bgMaxLifeMs() / 1000)} s (shell_id=${job.id}). Lo que ya había hecho no se deshizo.`
  return `Comando terminó con código ${job.code} (shell_id=${job.id}).`
}

export * as ShellBackground from "./background"
