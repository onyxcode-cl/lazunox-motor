import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { Global } from "@opencode-ai/core/global"

// Lazunox: marcadores en disco de los trabajos en segundo plano (shells y celdas de Code Mode).
// Si el motor muere sin avisar, el marcador queda; al arrancar la instancia se limpian los huérfanos y se deja una «lápida»
// (`<id>.perdido.json`) para que shell_wait/execute_wait puedan decir «el motor se reinició» en vez de un error genérico.

export type Tipo = "shell" | "celda"

export type Marcador = {
  id: string
  tipo: Tipo
  sessionID: string
  directory: string
  /** Shell: pid del proceso lanzado (líder de su grupo). Celda: pid del motor. */
  pid: number
  /** pid del motor que lanzó el trabajo. */
  enginePid: number
  /** Línea de comandos del pid al lanzar; vacía si no se pudo leer (entonces nunca se mata). */
  cmdline: string
  titulo: string
  inicio: number
}

export type Lapida = {
  id: string
  tipo: Tipo
  sessionID: string
  directory: string
  titulo: string
  inicio: number
  hora: number
}

export const LAPIDA_TTL_MS = 60 * 60 * 1000

/** Solo ids que sean un nombre de archivo seguro: el id puede venir del modelo o de la URL. */
export const idValido = (id: string) => /^[A-Za-z0-9_]{1,64}$/.test(id)

export const dir = () => path.join(Global.Path.state, "lazunox-jobs")
const marcadorPath = (id: string) => path.join(dir(), `${id}.json`)
const lapidaPath = (id: string) => path.join(dir(), `${id}.perdido.json`)

/** Escritura atómica (archivo temporal + rename) con permisos 0600. Nunca lanza: el marcador es de mejor esfuerzo. */
const writeAtomic = (file: string, data: unknown) => {
  try {
    fs.mkdirSync(dir(), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
    fs.renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

const readJson = <T>(file: string): T | undefined => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T
  } catch {
    return undefined
  }
}

const rm = (file: string) => {
  try {
    fs.rmSync(file, { force: true })
  } catch {}
}

export const writeMarker = (m: Marcador) => {
  if (!idValido(m.id)) return false
  return writeAtomic(marcadorPath(m.id), { ...m, titulo: m.titulo.slice(0, 200) })
}

export const removeMarker = (id: string) => {
  if (!idValido(id)) return
  rm(marcadorPath(id))
}

export const readMarker = (id: string) => (idValido(id) ? readJson<Marcador>(marcadorPath(id)) : undefined)

export const alive = (pid: number) => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Línea de comandos completa de un pid ("" si no existe o no se puede leer). Solo macOS/Linux. */
export const cmdlineOf = (pid: number) => {
  if (process.platform === "win32" || !Number.isInteger(pid) || pid <= 0) return ""
  if (process.platform === "linux") {
    // /proc no depende de que exista `ps` (contenedores mínimos).
    try {
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8").replaceAll("\0", " ").trim()
      if (raw) return raw
    } catch {}
  }
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf-8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {
    return ""
  }
}

/** Grupo de procesos de un pid (NaN si no se puede leer). Solo macOS/Linux. */
export const pgidOf = (pid: number) => {
  if (process.platform === "win32" || !Number.isInteger(pid) || pid <= 0) return Number.NaN
  if (process.platform === "linux") {
    try {
      // /proc/<pid>/stat: «pid (comm) estado ppid pgrp …»; el nombre puede llevar espacios y paréntesis, se corta tras el último «)».
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8")
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
      const pgrp = Number(rest[2])
      if (Number.isInteger(pgrp)) return pgrp
    } catch {}
  }
  try {
    return Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf-8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim())
  } catch {
    return Number.NaN
  }
}

/**
 * ¿Es razonable matar este grupo? Un marcador es un archivo en disco: cualquiera con escritura en esa carpeta (p. ej. un comando dentro
 * del sandbox) podría forjarlo. Solo se mata un proceso que (1) no es el motor ni su padre ni el proceso 1, (2) es líder de su propio
 * grupo (así lanzamos los shells), (3) no es una aplicación de escritorio (`.app/Contents/`, Electron) y (4) cuya línea de comandos
 * coincide con la guardada (lo comprueba el llamador).
 */
export const puedeMatarse = (m: Pick<Marcador, "pid" | "enginePid" | "cmdline">) =>
  Number.isInteger(m.pid) &&
  m.pid > 1 &&
  m.pid !== process.pid &&
  m.pid !== process.ppid &&
  Number.isInteger(m.enginePid) &&
  m.enginePid > 1 &&
  m.enginePid !== m.pid &&
  typeof m.cmdline === "string" &&
  m.cmdline.length > 0 &&
  !/\.app\/Contents\//.test(m.cmdline) &&
  pgidOf(m.pid) === m.pid

/** Tipo de trabajo de las celdas de Code Mode en `BackgroundJob`. Vive aquí (módulo liviano) para que `trabajos.ts` no importe `code-mode.ts`: ese import formaba un ciclo con permisos y complementos. */
export const CELL_JOB_TYPE = "code-mode"

export const writeTombstone = (m: Pick<Marcador, "id" | "tipo" | "sessionID" | "directory" | "titulo" | "inicio">, now = Date.now()) => {
  if (!idValido(m.id)) return
  const l: Lapida = { id: m.id, tipo: m.tipo, sessionID: m.sessionID, directory: m.directory, titulo: m.titulo, inicio: m.inicio, hora: now }
  writeAtomic(lapidaPath(m.id), l)
}

/** Borra las lápidas con más de una hora. */
export const pruneTombstones = (now = Date.now()) => {
  let names: string[] = []
  try {
    names = fs.readdirSync(dir())
  } catch {
    return
  }
  for (const name of names) {
    if (!name.endsWith(".perdido.json")) continue
    const file = path.join(dir(), name)
    const l = readJson<Lapida>(file)
    if (!l || typeof l.hora !== "number" || now - l.hora >= LAPIDA_TTL_MS) rm(file)
  }
}

/** Lápida de ESTA sesión para ese id; cualquier otra cosa (otra sesión, caducada, inexistente) da undefined. */
export const tombstoneFor = (id: string, sessionID: string, now = Date.now()): Lapida | undefined => {
  if (!idValido(id)) return
  const file = lapidaPath(id)
  const l = readJson<Lapida>(file)
  if (!l) return
  if (typeof l.hora !== "number" || now - l.hora >= LAPIDA_TTL_MS) {
    rm(file)
    return
  }
  return l.sessionID === sessionID ? l : undefined
}

/** Lápidas vigentes de una sesión. */
export const tombstonesOf = (sessionID: string, now = Date.now()): Lapida[] => {
  let names: string[] = []
  try {
    names = fs.readdirSync(dir())
  } catch {
    return []
  }
  const out: Lapida[] = []
  for (const name of names) {
    if (!name.endsWith(".perdido.json")) continue
    const l = readJson<Lapida>(path.join(dir(), name))
    if (l && l.sessionID === sessionID && typeof l.hora === "number" && now - l.hora < LAPIDA_TTL_MS) out.push(l)
  }
  return out
}

export const lostMessage = (l: Pick<Lapida, "id" | "tipo">) =>
  `El motor se reinició: el ${l.tipo === "shell" ? "comando" : "script"} ${l.id} se perdió (lo que ya había hecho no se deshizo).`

/**
 * Recorre los marcadores del `directory` cuyo motor ya no existe (o que ya no están en el registro de este proceso),
 * mata el grupo de procesos de los shells que sigan vivos con la MISMA línea de comandos y deja una lápida.
 * `liveShellIds`: ids de shells que este proceso sí tiene en marcha (nunca se tocan).
 */
export const sweepOrphans = (directory: string, liveShellIds: ReadonlySet<string>, now = Date.now()) => {
  pruneTombstones(now)
  let names: string[] = []
  try {
    names = fs.readdirSync(dir())
  } catch {
    return []
  }
  const lost: Marcador[] = []
  for (const name of names) {
    if (!name.endsWith(".json") || name.endsWith(".perdido.json")) continue
    const file = path.join(dir(), name)
    const m = readJson<Marcador>(file)
    if (!m || !idValido(m.id) || typeof m.pid !== "number") {
      // Basura ilegible: solo se borra si es antigua, por si otro proceso la está escribiendo.
      try {
        if (now - fs.statSync(file).mtimeMs > 60_000) rm(file)
      } catch {}
      continue
    }
    if (m.directory !== directory) continue
    if (liveShellIds.has(m.id)) continue
    const mine = m.enginePid === process.pid
    // Un motor distinto que sigue vivo es dueño de su trabajo. Celdas de este mismo proceso: las gestiona su propio ciclo de vida.
    if (!mine && alive(m.enginePid)) continue
    if (mine && m.tipo === "celda") continue
    if (m.tipo === "shell" && process.platform !== "win32" && alive(m.pid)) {
      const now_ = cmdlineOf(m.pid)
      if (m.cmdline && now_ === m.cmdline && puedeMatarse(m)) {
        try {
          process.kill(-m.pid, "SIGKILL")
        } catch {
          try {
            process.kill(m.pid, "SIGKILL")
          } catch {}
        }
      }
    }
    writeTombstone(m, now)
    rm(file)
    lost.push(m)
  }
  return lost
}

const swept = new Set<string>()
/** Barrido una sola vez por directorio y proceso (idempotente). Los llamadores pasan los shells vivos del proceso. */
export const ensureSwept = (directory: string, liveShellIds: ReadonlySet<string>) => {
  if (swept.has(directory)) return
  swept.add(directory)
  sweepOrphans(directory, liveShellIds)
}
/** Para pruebas y para cuando se libera una instancia. */
export const forgetSwept = (directory?: string) => (directory ? swept.delete(directory) : swept.clear())

export * as TrabajosDisco from "./trabajos-disco"
