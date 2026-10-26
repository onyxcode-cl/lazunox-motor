// "No releer" (P22): memoria por sesión de las lecturas COMPLETAS de archivos hechas por la herramienta `read`.
// Guarda { ruta -> hash del contenido, llamada que lo leyó, número de lectura }. Una lectura completa idéntica a la
// anterior se responde con una línea corta SOLO si la lectura anterior sigue visible en el contexto del modelo
// (la parte existe en los mensajes de la llamada, está completada y no fue podada). Al compactar o rebobinar esos
// mensajes desaparecen del contexto, así que la comprobación de visibilidad ya cubre esos casos; `vaciar` además
// borra el mapa por si el integrador quiere conectarlo a esos eventos.
import { createHash } from "crypto"
import fs from "fs"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

/** Lazunox (6.7): cómo estaba el archivo en disco cuando se leyó (o la última vez que se avisó de un cambio). */
export interface Base {
  mtimeMs: number
  size: number
  /** sha256 de los bytes; ausente si el archivo pasa de HASH_MAX. */
  hash?: string
  /** Solo las ediciones propias de mensajes con id >= este cuentan como «propias» de este archivo. */
  msgID: string
}

export interface Lectura {
  hash: string
  callID: string
  numero: number
  /** Ruta tal como la pidió la herramienta (antes de resolver enlaces); sirve para decidir si es secreta. */
  pedida?: string
  base?: Base
}

const MAX_RUTAS = 500
const MAX_SESIONES = 64
const sesiones = new Map<string, { n: number; rutas: Map<string, Lectura> }>()

export function activo() {
  return process.env.LAZUNOX_NO_RELEER !== "0"
}

export function hash(texto: string) {
  return createHash("sha256").update(texto).digest("hex")
}

export function vaciar(sessionID: string) {
  sesiones.delete(sessionID)
}

export function anterior(sessionID: string, ruta: string): Lectura | undefined {
  return sesiones.get(sessionID)?.rutas.get(ruta)
}

/** Lazunox (6.7): solo con LAZUNOX_AVISOS_CAMBIOS=1 se guarda mtime/tamaño/hash de bytes de cada lectura. */
export const avisosActivo = (env: NodeJS.ProcessEnv = process.env) => env.LAZUNOX_AVISOS_CAMBIOS === "1"

export const HASH_MAX = 2 * 1024 * 1024
export const CAMBIADAS_MAX = 50

const huella = (ruta: string): { mtimeMs: number; size: number; hash?: string } | undefined => {
  try {
    const st = fs.statSync(ruta)
    if (!st.isFile()) return undefined
    return { mtimeMs: st.mtimeMs, size: st.size, hash: st.size <= HASH_MAX ? bytesHash(ruta) : undefined }
  } catch {
    return undefined
  }
}
const bytesHash = (ruta: string) => {
  try {
    return createHash("sha256").update(fs.readFileSync(ruta)).digest("hex")
  } catch {
    return undefined
  }
}
/** Id que ordena justo después de `id` y antes de cualquier id posterior (los ids de mensaje son ascendentes). */
export const despuesDe = (id: string) => id + "\u0000"

export function registrar(
  sessionID: string,
  ruta: string,
  h: string,
  callID: string,
  extra?: { msgID?: string; pedida?: string },
): Lectura {
  let s = sesiones.get(sessionID)
  if (!s) {
    if (sesiones.size >= MAX_SESIONES) {
      const primera = sesiones.keys().next().value
      if (primera !== undefined) sesiones.delete(primera)
    }
    s = { n: 0, rutas: new Map() }
    sesiones.set(sessionID, s)
  }
  s.n += 1
  const lectura: Lectura = { hash: h, callID, numero: s.n }
  if (avisosActivo()) {
    const f = huella(ruta)
    if (f) lectura.base = { ...f, msgID: extra?.msgID ?? "" }
    if (extra?.pedida) lectura.pedida = extra.pedida
  }
  s.rutas.delete(ruta)
  s.rutas.set(ruta, lectura)
  if (s.rutas.size > MAX_RUTAS) {
    const vieja = s.rutas.keys().next().value
    if (vieja !== undefined) s.rutas.delete(vieja)
  }
  return lectura
}

// ¿Sigue visible la lectura anterior? Existe en los mensajes que ve el modelo, terminó bien y no fue podada.
export function visible(messages: SessionV1.WithParts[], callID: string) {
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type !== "tool" || p.tool !== "read" || p.callID !== callID) continue
      return p.state.status === "completed" && !p.state.time.compacted
    }
  }
  return false
}

export interface Cambiada {
  ruta: string
  pedida?: string
  borrada: boolean
}

/**
 * Lazunox (6.7, H9): rutas leídas por la sesión cuyo archivo cambió en disco desde la lectura (mtime y tamaño; si cambiaron, el hash de
 * bytes: un `touch` no cuenta). Mira como mucho las `max` lecturas más recientes. Solo lecturas que siguen visibles (`visible`) y cuya
 * ruta real queda dentro del proyecto (`dentro`: nunca se hace `stat` fuera). Si `propia` dice que la sesión misma lo editó, no se
 * devuelve. En todo caso la base se actualiza, así un cambio se avisa UNA sola vez. No lee contenido: solo cifras y rutas.
 */
export function cambiadas(
  sessionID: string,
  opts: {
    visible: (callID: string) => boolean
    dentro: (ruta: string) => boolean
    propia: (ruta: string, desdeMsgID: string) => boolean
    /** id del último mensaje ya examinado */
    hasta: string
    max?: number
  },
): Cambiada[] {
  const s = sesiones.get(sessionID)
  if (!s) return []
  const salida: Cambiada[] = []
  const entradas = [...s.rutas.entries()].slice(-(opts.max ?? CAMBIADAS_MAX))
  for (const [ruta, l] of entradas) {
    const b = l.base
    if (!b || !opts.visible(l.callID) || !opts.dentro(ruta)) continue
    let st: fs.Stats
    try {
      st = fs.statSync(ruta)
    } catch {
      s.rutas.delete(ruta)
      if (!opts.propia(ruta, b.msgID)) salida.push({ ruta, pedida: l.pedida, borrada: true })
      continue
    }
    if (!st.isFile() || (st.mtimeMs === b.mtimeMs && st.size === b.size)) continue
    const nuevo = st.size <= HASH_MAX ? bytesHash(ruta) : undefined
    const propia = opts.propia(ruta, b.msgID)
    const igual = nuevo !== undefined && nuevo === b.hash
    l.base = { mtimeMs: st.mtimeMs, size: st.size, hash: nuevo, msgID: despuesDe(opts.hasta) }
    if (!igual && !propia) salida.push({ ruta, pedida: l.pedida, borrada: false })
  }
  return salida
}

/** Lazunox (6.7): la sesión (p. ej. un comando de shell) cambió estos archivos; su base se pone al día sin avisar. */
export function marcarPropias(sessionID: string, rutas: string[], hasta: string) {
  const s = sesiones.get(sessionID)
  if (!s) return
  for (const ruta of rutas) {
    const l = s.rutas.get(ruta)
    if (!l?.base) continue
    const f = huella(ruta)
    if (f) l.base = { ...f, msgID: despuesDe(hasta) }
    else s.rutas.delete(ruta)
  }
}

export * as LecturasSesion from "./lecturas"
