import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { Global } from "@opencode-ai/core/global"

// Lazunox: los permisos «siempre» sobreviven al reinicio del motor, por carpeta de proyecto.
// Apagado salvo que la app lo encienda (LAZUNOX_PERMISSION_PERSIST=1). Solo se guarda lo estrecho: el comodín «*» suelto solo vale para
// herramientas de conectores (MCP: «servidor_herramienta»), nunca para las herramientas propias del motor (bash, edit, write…), y los
// permisos de la lista de exclusión (por defecto `external_directory` y `doom_loop`; la app añade los suyos con
// LAZUNOX_PERMISSION_NO_PERSIST="a,b"). El archivo es de la persona (0600) y se puede borrar para revocar todo.

export type Regla = { permission: string; pattern: string }

const SIEMPRE_NO = ["external_directory", "doom_loop"]
/** Herramientas propias: su «siempre» sin patrón concreto sería permiso total y permanente, y no se guarda. */
const PROPIAS = new Set([
  "bash", "shell", "shell_wait", "execute", "execute_wait", "edit", "write", "multiedit", "patch", "apply_patch",
  "task", "webfetch", "websearch", "skill", "question", "read", "glob", "grep", "list", "todowrite", "todoread", "lsp",
])

export const activo = (env: NodeJS.ProcessEnv = process.env) => env.LAZUNOX_PERMISSION_PERSIST === "1"

/** Lista de exclusión: nombres exactos o con «*» al final (`computer_*`). */
const excluidos = (env: NodeJS.ProcessEnv = process.env) => {
  const lista = [...SIEMPRE_NO, ...(env.LAZUNOX_PERMISSION_NO_PERSIST ?? "").split(",").map((s) => s.trim()).filter(Boolean)]
  return (permission: string) => lista.some((x) => (x.endsWith("*") ? permission.startsWith(x.slice(0, -1)) : permission === x))
}

/** ¿Es seguro recordar esta regla entre reinicios? */
export const persistible = (r: Regla, env: NodeJS.ProcessEnv = process.env) =>
  typeof r.permission === "string" &&
  typeof r.pattern === "string" &&
  r.permission.length > 0 &&
  r.permission.length <= 200 &&
  r.pattern.length > 0 &&
  r.pattern.length <= 500 &&
  (r.pattern.trim() !== "*" || !PROPIAS.has(r.permission)) &&
  !/[\r\n\0]/.test(r.pattern) &&
  !excluidos(env)(r.permission)

/** LAZUNOX_PERMISSION_DIR fija la carpeta (la app la pone dentro de su carpeta de datos); si no, la de estado del motor. */
export const dir = (env: NodeJS.ProcessEnv = process.env) =>
  env.LAZUNOX_PERMISSION_DIR && path.isAbsolute(env.LAZUNOX_PERMISSION_DIR) ? env.LAZUNOX_PERMISSION_DIR : path.join(Global.Path.state, "lazunox-permisos")
const huella = (directory: string) => createHash("sha256").update(directory).digest("hex").slice(0, 24)
export const archivo = (directory: string, base = dir()) => path.join(base, `${huella(directory)}.json`)

/** Lee las reglas guardadas de una carpeta; cualquier problema (archivo ausente, roto, de otra carpeta) = ninguna. */
export const cargar = (directory: string, base = dir(), env: NodeJS.ProcessEnv = process.env): Regla[] => {
  if (!activo(env)) return []
  try {
    const j = JSON.parse(fs.readFileSync(archivo(directory, base), "utf-8")) as { directory?: unknown; rules?: unknown }
    if (j.directory !== directory || !Array.isArray(j.rules)) return []
    return j.rules.filter((r): r is Regla => !!r && typeof r === "object" && persistible(r as Regla, env)).slice(0, 500)
  } catch {
    return []
  }
}

/** Añade reglas (sin duplicar). Mejor esfuerzo: nunca lanza. */
export const guardar = (directory: string, nuevas: Regla[], base = dir(), env: NodeJS.ProcessEnv = process.env) => {
  if (!activo(env)) return
  try {
    conCerrojo(directory, base, () => {
      const todas = [...cargar(directory, base, env)]
      for (const r of nuevas) {
        if (!persistible(r, env)) continue
        if (todas.some((x) => x.permission === r.permission && x.pattern === r.pattern)) continue
        todas.push({ permission: r.permission, pattern: r.pattern })
      }
      escribir(directory, base, todas)
    })
  } catch {}
}

// --- Gestión (Ola 7, 7.22): listar, borrar uno, borrar todos. Funciona aunque LAZUNOX_PERMISSION_PERSIST esté apagado
// (hay que poder quitar lo que quedó guardado). Todo es síncrono, así que dentro de un proceso cada leer-cambiar-escribir
// es atómico; entre procesos las escrituras usan un cerrojo de archivo breve y rename atómico.

/** Clave estable de una regla (la misma en cada lectura): hash de permiso + patrón. */
export const idDe = (r: Regla) => createHash("sha256").update(`${r.permission}\0${r.pattern}`).digest("hex").slice(0, 16)

export type Guardada = Regla & { id: string }
export type Lectura = { reglas: Guardada[]; estado: "ok" | "ausente" | "corrupto"; ignoradas: number }

/** Lee el archivo sin mirar el interruptor. Un archivo roto o de otra carpeta se informa (`corrupto`) y NO se toca. */
export const leer = (directory: string, base = dir(), env: NodeJS.ProcessEnv = process.env): Lectura => {
  let texto: string
  try {
    texto = fs.readFileSync(archivo(directory, base), "utf-8")
  } catch {
    return { reglas: [], estado: "ausente", ignoradas: 0 }
  }
  try {
    const j = JSON.parse(texto) as { directory?: unknown; rules?: unknown }
    if (!j || j.directory !== directory || !Array.isArray(j.rules)) return { reglas: [], estado: "corrupto", ignoradas: 0 }
    const reglas: Guardada[] = []
    let ignoradas = 0
    for (const r of j.rules.slice(0, 500)) {
      if (!r || typeof r !== "object" || !persistible(r as Regla, env)) {
        ignoradas++
        continue
      }
      const { permission, pattern } = r as Regla
      if (!reglas.some((x) => x.permission === permission && x.pattern === pattern)) reglas.push({ id: idDe({ permission, pattern }), permission, pattern })
    }
    return { reglas, estado: "ok", ignoradas }
  } catch {
    return { reglas: [], estado: "corrupto", ignoradas: 0 }
  }
}

const esperar = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** Cerrojo de archivo por carpeta (creación exclusiva; uno abandonado de más de 5 s se rompe). */
const conCerrojo = <T>(directory: string, base: string, fn: () => T): T => {
  fs.mkdirSync(base, { recursive: true, mode: 0o700 })
  const lock = `${archivo(directory, base)}.lock`
  for (let i = 0; i < 100; i++) {
    try {
      fs.closeSync(fs.openSync(lock, "wx", 0o600))
      break
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 5000) fs.rmSync(lock, { force: true })
      } catch {}
      esperar(20)
    }
  }
  try {
    return fn()
  } finally {
    try {
      fs.rmSync(lock, { force: true })
    } catch {}
  }
}

const escribir = (directory: string, base: string, reglas: Regla[]) => {
  const file = archivo(directory, base)
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ directory, rules: reglas.slice(-500) }), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/** Quita UNA regla por su id. Devuelve la regla quitada, o `undefined` si no existía (o el archivo está roto: no se toca). Nunca lanza. */
export const borrarUno = (directory: string, id: string, base = dir(), env: NodeJS.ProcessEnv = process.env): Regla | undefined => {
  try {
    return conCerrojo(directory, base, () => {
      const l = leer(directory, base, env)
      const quitada = l.reglas.find((r) => r.id === id)
      if (l.estado !== "ok" || !quitada) return undefined
      escribir(directory, base, l.reglas.filter((r) => r.id !== id).map(({ permission, pattern }) => ({ permission, pattern })))
      return { permission: quitada.permission, pattern: quitada.pattern }
    })
  } catch {
    return undefined
  }
}

/** Quita todo lo guardado de la carpeta (incluido un archivo roto) y devuelve cuántas reglas válidas había. */
export const borrarTodas = (directory: string, base = dir(), env: NodeJS.ProcessEnv = process.env): Guardada[] => {
  try {
    return conCerrojo(directory, base, () => {
      const antes = leer(directory, base, env).reglas
      fs.rmSync(archivo(directory, base), { force: true })
      return antes
    })
  } catch {
    return []
  }
}

/** Revoca todo lo guardado de una carpeta. */
export const olvidar = (directory: string, base = dir()) => {
  try {
    fs.rmSync(archivo(directory, base), { force: true })
  } catch {}
}
