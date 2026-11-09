// Lazunox (lazunox.16, B2): lista EN MEMORIA de carpetas confiadas. Solo existe mientras vive el motor (no se guarda nada en disco):
// al reiniciar el motor se pierde y la app la reenvía. Solo se consulta con LAZUNOX_TRUST_REQUIRED encendida.
//
// Decisión (documentada en LAZUNOX.md): la confianza es de la ruta FÍSICA exacta. No se hereda a carpetas hijas (una subcarpeta ajena
// puede traer su propio `.opencode`) ni sube a carpetas superiores. Confiar en T sí autoriza, como siempre, la cadena de carpetas
// madre hasta la raíz del repositorio git de T (config/instrucciones), pero ninguna madre queda confiada por eso.
import fs from "fs"
import path from "path"
import { Flag } from "./flag/flag"

export interface Entry {
  /** Ruta física (enlaces resueltos, mayúsculas del sistema de archivos, 8.3). Es la clave. */
  readonly canonical: string
  /** La ruta con la que se registró (ya normalizada con `path.resolve`). Con esta se carga la instancia. */
  readonly display: string
}

const entries = new Map<string, Entry>()

const clave = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p)

export const required = () => Flag.LAZUNOX_TRUST_REQUIRED

/** Ruta absoluta bien formada (en Windows exige unidad o UNC: `\proj` y `C:proj` no valen). */
export function esAbsolutaValida(dir: unknown): dir is string {
  if (typeof dir !== "string" || dir === "" || dir.includes("\0")) return false
  if (process.platform === "win32") return /^(?:[a-zA-Z]:[\\/]|\\\\|\/\/)/.test(dir)
  return path.isAbsolute(dir)
}

/** Ruta física de una carpeta que existe; `undefined` si no existe, no es carpeta, está mal formada o es relativa. */
export function canonical(dir: unknown): string | undefined {
  if (!esAbsolutaValida(dir)) return undefined
  try {
    const real = fs.realpathSync.native(path.resolve(dir))
    return fs.statSync(real).isDirectory() ? real : undefined
  } catch {
    return undefined
  }
}

export type Verdict =
  | { readonly trusted: true; readonly display: string; readonly canonical: string }
  | { readonly trusted: false; readonly stale?: Entry }

/**
 * ¿Esta carpeta (tal como llega en la petición) es una carpeta confiada? La comparación es sobre la ruta física, no sobre el texto.
 * `stale`: la carpeta con la que se registró ya apunta a otra parte (la reemplazaron por un enlace, por ejemplo): ya no vale.
 */
export function check(dir: string): Verdict {
  const real = canonical(dir)
  if (real) {
    const hit = entries.get(clave(real))
    if (hit) return { trusted: true, display: hit.display, canonical: hit.canonical }
  }
  if (!esAbsolutaValida(dir)) return { trusted: false }
  const texto = clave(path.resolve(dir))
  for (const entry of entries.values()) {
    if (clave(entry.display) === texto) return { trusted: false, stale: entry }
  }
  return { trusted: false }
}

export function isTrusted(dir: string): boolean {
  return check(dir).trusted
}

/** Confía una carpeta. `undefined` si no existe o no es una carpeta absoluta. Idempotente: no cambia el `display` ya registrado. */
export function trust(dir: unknown): { entry: Entry; added: boolean } | undefined {
  const real = canonical(dir)
  if (!real) return undefined
  const existing = entries.get(clave(real))
  if (existing) return { entry: existing, added: false }
  const entry: Entry = { canonical: real, display: path.resolve(dir as string) }
  entries.set(clave(real), entry)
  return { entry, added: true }
}

/** Quita la confianza. Acepta la ruta física o cualquiera de las rutas con que se registró. Devuelve lo que quitó. */
export function untrust(dir: unknown): Entry[] {
  if (!esAbsolutaValida(dir)) return []
  const real = canonical(dir)
  const texto = clave(path.resolve(dir))
  const removed: Entry[] = []
  for (const [k, entry] of [...entries]) {
    if ((real && k === clave(real)) || k === texto || clave(entry.display) === texto) {
      entries.delete(k)
      removed.push(entry)
    }
  }
  return removed
}

export const list = (): Entry[] => [...entries.values()]

/** Solo para pruebas. */
export function reset() {
  entries.clear()
}

export * as FolderTrust from "./folder-trust"
