// Lazunox (Ola 6, 6.9 · H6): ayudante «fork» que hereda la conversación del padre.
// Apagado por defecto: `LAZUNOX_AYUDANTE_HEREDADO=1`. Lo copiado es DATO: no cambia permisos (los fija `permisoDeHija`, intersección con el
// padre de 2A + tope del modo plan), no trae permisos pendientes, trabajos vivos ni el estado de `revert`, y se acota por tamaño.
// Este módulo no tiene dependencias del motor: solo decide QUÉ mensajes y partes viajan a la sesión hija.
import type { SessionV1 } from "@opencode-ai/core/v1/session"

export const ENV = "LAZUNOX_AYUDANTE_HEREDADO"
export const ENV_MAX = "LAZUNOX_AYUDANTE_HEREDADO_MAX"
/** Marca en `metadata` de la sesión hija: id de la sesión padre de la que se bifurcó. Su presencia impide bifurcar otra vez. */
export const MARCA_FORK = "lazunox_fork_de"
export const MARCA_OMITIDOS = "lazunox_fork_omitidos"
/** Línea que abre la orden del ayudante bifurcado. */
export const LINEA_AYUDANTE = "Eres un ayudante bifurcado: haz SOLO esto y devuelve un informe."
export const MAX_DEFECTO = 256 * 1024

export const activo = (env: NodeJS.ProcessEnv = process.env) => env[ENV] === "1"

/** Tope de bytes del historial copiado (LAZUNOX_AYUDANTE_HEREDADO_MAX; por defecto 256 KB; se acota a 4 KB..4 MB). */
export const topeBytes = (env: NodeJS.ProcessEnv = process.env) =>
  Math.min(4 * 1024 * 1024, Math.max(4096, Number.parseInt(env[ENV_MAX] ?? "", 10) || MAX_DEFECTO))

/** Una parte interna del motor (`metadata.lazunox_*`: objetivo, presupuesto, avisos, resumen incompleto…) no viaja. */
export const esInterna = (part: { metadata?: Record<string, unknown> }) =>
  part.metadata !== undefined && Object.keys(part.metadata).some((k) => k.startsWith("lazunox_"))

/** ¿Esta sesión ya es un fork heredado? Un fork no crea forks. */
export const esFork = (metadata: Record<string, unknown> | undefined) => typeof metadata?.[MARCA_FORK] === "string"

function tamanoParte(part: SessionV1.Part): number {
  switch (part.type) {
    case "text":
    case "reasoning":
      return Buffer.byteLength(part.text, "utf-8")
    case "tool": {
      const s = part.state as { input?: unknown; output?: unknown; error?: unknown; status: string }
      return Buffer.byteLength(JSON.stringify({ i: s.input, o: s.output, e: s.error }) ?? "", "utf-8")
    }
    case "file":
      return (part.url?.length ?? 0) + (part.source ? 256 : 0)
    default:
      return 64
  }
}
export const tamanoMensaje = (msg: SessionV1.WithParts) => msg.parts.reduce((n, p) => n + tamanoParte(p), 0)

/**
 * Qué viaja a la hija. Entrada: los mensajes del padre YA cortados (antes del turno actual y antes del punto de rebobinado).
 *  1. Fuera las partes internas `lazunox_*`; un mensaje que se queda sin partes se va (y los asistentes que colgaban de un usuario
 *     eliminado pasan a colgar del usuario anterior que se conserva: lo hace `Session.fork`).
 *  2. Tope de tamaño: se conservan los mensajes MÁS RECIENTES que quepan; la copia empieza siempre en un mensaje de usuario.
 * Devuelve también cuántos mensajes se omitieron (por tope o por quedar vacíos).
 */
export function seleccionar(msgs: ReadonlyArray<SessionV1.WithParts>, maxBytes: number) {
  const limpios: SessionV1.WithParts[] = []
  for (const m of msgs) {
    const parts = m.parts.filter((p) => !esInterna(p as { metadata?: Record<string, unknown> }))
    if (parts.length > 0) limpios.push({ ...m, parts })
  }
  let acumulado = 0
  let desde = limpios.length
  for (let i = limpios.length - 1; i >= 0; i--) {
    const t = tamanoMensaje(limpios[i])
    if (acumulado + t > maxBytes) break
    acumulado += t
    desde = i
  }
  while (desde < limpios.length && limpios[desde].info.role !== "user") desde++
  const mensajes = limpios.slice(desde)
  return { mensajes, omitidos: msgs.length - mensajes.length }
}

export * as AyudanteHeredado from "./heredado"
