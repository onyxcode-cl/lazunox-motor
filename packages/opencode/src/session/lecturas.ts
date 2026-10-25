// "No releer" (P22): memoria por sesión de las lecturas COMPLETAS de archivos hechas por la herramienta `read`.
// Guarda { ruta -> hash del contenido, llamada que lo leyó, número de lectura }. Una lectura completa idéntica a la
// anterior se responde con una línea corta SOLO si la lectura anterior sigue visible en el contexto del modelo
// (la parte existe en los mensajes de la llamada, está completada y no fue podada). Al compactar o rebobinar esos
// mensajes desaparecen del contexto, así que la comprobación de visibilidad ya cubre esos casos; `vaciar` además
// borra el mapa por si el integrador quiere conectarlo a esos eventos.
import { createHash } from "crypto"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

export interface Lectura {
  hash: string
  callID: string
  numero: number
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

export function registrar(sessionID: string, ruta: string, h: string, callID: string): Lectura {
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
  const lectura = { hash: h, callID, numero: s.n }
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

export * as LecturasSesion from "./lecturas"
