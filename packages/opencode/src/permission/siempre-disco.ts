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

const excluidos = (env: NodeJS.ProcessEnv = process.env) =>
  new Set([...SIEMPRE_NO, ...(env.LAZUNOX_PERMISSION_NO_PERSIST ?? "").split(",").map((s) => s.trim()).filter(Boolean)])

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
  !excluidos(env).has(r.permission)

export const dir = () => path.join(Global.Path.state, "lazunox-permisos")
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
    const todas = [...cargar(directory, base, env)]
    for (const r of nuevas) {
      if (!persistible(r, env)) continue
      if (todas.some((x) => x.permission === r.permission && x.pattern === r.pattern)) continue
      todas.push({ permission: r.permission, pattern: r.pattern })
    }
    fs.mkdirSync(base, { recursive: true, mode: 0o700 })
    const file = archivo(directory, base)
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ directory, rules: todas.slice(-500) }), { mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch {}
}

/** Revoca todo lo guardado de una carpeta. */
export const olvidar = (directory: string, base = dir()) => {
  try {
    fs.rmSync(archivo(directory, base), { force: true })
  } catch {}
}
