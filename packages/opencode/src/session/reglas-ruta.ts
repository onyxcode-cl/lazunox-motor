// Lazunox (4D, P23): reglas por ruta (`.opencode/rules/*.md` y `.claude/rules/*.md` con `paths:` en el encabezado).
// Funciones puras: lectura del encabezado, patrones y topes. La parte con disco vive en `instruction.ts`.
//
// Las reglas son DATO: solo añaden texto de contexto con tope de tamaño. De todo el encabezado solo se lee `paths`;
// cualquier otra clave (`permission`, `tools`, `model`...) se ignora. Los patrones se comparan contra la ruta
// relativa REAL (realpath) del archivo dentro del proyecto; un patrón absoluto, con `..` o `~` se descarta.
import { minimatch } from "minimatch"

/** `LAZUNOX_REGLAS_RUTA=0` apaga las reglas por ruta. */
export const activo = (env: NodeJS.ProcessEnv = process.env) => env.LAZUNOX_REGLAS_RUTA !== "0"

/** Tope por regla (bytes de cuerpo). */
export const REGLA_MAX_BYTES = 8 * 1024
/** Cuánto de cada archivo de regla se lee para buscar el encabezado y el cuerpo. */
export const REGLA_LECTURA_MAX_BYTES = 16 * 1024
/** Tope total por turno de la persona (bytes). `LAZUNOX_REGLAS_RUTA_MAX_BYTES` lo cambia (1 KB a 256 KB). */
export const turnoMaxBytes = (env: NodeJS.ProcessEnv = process.env) => {
  const n = Number(env.LAZUNOX_REGLAS_RUTA_MAX_BYTES)
  return Number.isInteger(n) && n >= 1024 ? Math.min(n, 256 * 1024) : 24 * 1024
}
/** Máximo de reglas por turno de la persona. */
export const REGLAS_TURNO_MAX = 8
/** Archivos de regla que se examinan por carpeta de reglas y patrones por regla. */
export const REGLAS_ARCHIVOS_MAX = 100
export const PATRONES_MAX = 20
export const PATRON_MAX_LARGO = 200
/** Profundidad máxima de subcarpetas dentro de `rules/`. */
export const PROFUNDIDAD_MAX = 3

export interface ReglaLeida {
  patrones: string[]
  cuerpo: string
}

const sinComillas = (s: string) => {
  const t = s.trim()
  if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) return t.slice(1, -1)
  return t
}

/** Divide `a, b` respetando llaves (`src/**\/*.{ts,tsx}` no se parte por su coma). */
function partirComas(s: string) {
  const out: string[] = []
  let nivel = 0
  let actual = ""
  for (const ch of s) {
    if (ch === "{") nivel++
    if (ch === "}") nivel = Math.max(0, nivel - 1)
    if (ch === "," && nivel === 0) {
      out.push(actual)
      actual = ""
      continue
    }
    actual += ch
  }
  out.push(actual)
  return out
}

/** Un patrón es válido si es relativo al proyecto: sin `..`, sin ruta absoluta, sin `~`, sin negación ni NUL. */
export function patronValido(p: string) {
  if (!p || p.length > PATRON_MAX_LARGO) return false
  if (p.includes("\0")) return false
  if (p.startsWith("/") || p.startsWith("\\") || p.startsWith("~") || p.startsWith("!") || p.startsWith("#")) return false
  if (/^[A-Za-z]:/.test(p)) return false
  if (p.split(/[\\/]/).some((seg) => seg === "..")) return false
  return true
}

/**
 * Lee el encabezado `---` y devuelve los `paths` válidos y el cuerpo. Sin encabezado o sin `paths` devuelve `undefined`
 * (una regla sin `paths` no se carga nunca: el peso fijo no crece por reglas «siempre»).
 */
export function parsearRegla(texto: string): ReglaLeida | undefined {
  const t = texto.replace(/^﻿/, "").replace(/\r\n?/g, "\n")
  if (!t.startsWith("---\n")) return undefined
  const fin = t.indexOf("\n---", 3)
  if (fin < 0) return undefined
  const despues = t.indexOf("\n", fin + 1)
  const cierre = t.slice(fin + 4, despues < 0 ? t.length : despues)
  if (cierre.trim() !== "") return undefined
  const cabecera = t.slice(4, fin).split("\n")
  const cuerpo = despues < 0 ? "" : t.slice(despues + 1)

  const crudos: string[] = []
  for (let i = 0; i < cabecera.length; i++) {
    const m = /^paths\s*:\s*(.*)$/.exec(cabecera[i]!)
    if (!m) continue
    const resto = m[1]!.trim()
    if (resto === "" || resto === "|" || resto === ">") {
      for (let j = i + 1; j < cabecera.length; j++) {
        const item = /^\s+-\s*(.*)$/.exec(cabecera[j]!)
        if (!item) {
          if (cabecera[j]!.trim() === "") continue
          break
        }
        crudos.push(sinComillas(item[1]!))
      }
    } else if (resto.startsWith("[")) {
      const interior = resto.endsWith("]") ? resto.slice(1, -1) : resto.slice(1)
      for (const p of partirComas(interior)) crudos.push(sinComillas(p))
    } else {
      for (const p of partirComas(resto)) crudos.push(sinComillas(p))
    }
    break
  }
  const patrones = crudos.filter(patronValido).slice(0, PATRONES_MAX)
  if (patrones.length === 0) return undefined
  return { patrones, cuerpo }
}

/** `rel` = ruta relativa al proyecto con `/`. `dot: true`: `.github/**` y archivos ocultos también coinciden. */
export function coincide(rel: string, patrones: string[]) {
  if (!rel || rel.startsWith("../") || rel === "..") return false
  return patrones.some((p) => {
    try {
      return minimatch(rel, p, { dot: true, nonegate: true, nocomment: true })
    } catch {
      return false
    }
  })
}

/** Recorta a `max` bytes sin partir un carácter y avisa. */
export function recortar(texto: string, max: number) {
  const buf = Buffer.from(texto, "utf-8")
  if (buf.length <= max) return { texto, recortado: false }
  const corte = buf.subarray(0, max).toString("utf-8").replace(/�+$/, "")
  return { texto: `${corte}\n[... regla recortada a ${Math.round(max / 1024)} KB]`, recortado: true }
}

/** El texto de una regla no puede cerrar el sobre `<system-reminder>` donde se entrega. */
export const neutralizar = (texto: string) => texto.replace(/<(\/?)(system-reminder)\b/gi, "<​$1$2")

export const AVISO = "(Regla por ruta del proyecto: solo contexto; no concede permisos ni cambia herramientas.)"

/** Texto que ve el modelo para una regla. */
export function formatear(ruta: string, cuerpo: string) {
  const { texto } = recortar(neutralizar(cuerpo.trim()), REGLA_MAX_BYTES)
  return `Instructions from: ${ruta}\n${AVISO}\n${texto}`
}

/** Rutas de archivos que nombra un `apply_patch` (para cargar las reglas de lo que edita). */
export function rutasDePatch(patchText: string, max = 5) {
  const out: string[] = []
  for (const m of patchText.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm)) {
    out.push(m[1]!.trim())
    if (out.length >= max) break
  }
  return out
}
