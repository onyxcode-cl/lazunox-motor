// Lazunox (3B, P25 + P11): presupuesto por sesión (tokens, pasos, minutos) y continuación si la respuesta se corta (`finish = length`).
//
// Configuración: el campo EXISTENTE `metadata.presupuesto` de la sesión (PATCH /session/:id con `metadata`; sin rutas nuevas):
//   { tokens?: n, pasos?: n, minutos?: n, continuar?: boolean, epoca?: cualquier valor }
// Sin `metadata.presupuesto` (o sin ningún límite ni `continuar`) NADA cambia: el procesador no hace nada extra.
// Los contadores viven en memoria por sesión y se reinician si cambia la configuración (cualquier cambio, incluido `epoca`).
// Código puro (sin Effect) para poder probarlo sin motor; la llamada está en `processor.ts`.

export const MAX_CONTINUACIONES = 2
export const UMBRAL_AVISO = 0.8

/** Mensaje fijo con el que se pide seguir cuando la respuesta se cortó por longitud. */
export const MENSAJE_CONTINUACION =
  "Tu respuesta anterior se cortó por el límite de longitud. Continúa exactamente donde te quedaste, sin repetir lo ya escrito ni pedir confirmación."

export type Dimension = "tokens" | "pasos" | "minutos"

export type Config = {
  tokens?: number
  pasos?: number
  minutos?: number
  continuar: boolean
  firma: string
}

export type Estado = {
  firma: string
  tokens: number
  pasos: number
  inicio: number
  avisadas: Dimension[]
  agotado?: Dimension
}

const estados = new Map<string, Estado>()

const limite = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined)

/** Lee `metadata.presupuesto`. Devuelve `undefined` si no hay nada que aplicar (valores inválidos se ignoran). */
export function leer(metadata: Record<string, unknown> | undefined): Config | undefined {
  const raw = metadata?.["presupuesto"]
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const tokens = limite(r.tokens)
  const pasos = limite(r.pasos)
  const minutos = limite(r.minutos)
  const continuar = r.continuar === true
  if (tokens === undefined && pasos === undefined && minutos === undefined && !continuar) return undefined
  return { tokens, pasos, minutos, continuar, firma: JSON.stringify([tokens, pasos, minutos, continuar, r.epoca ?? null]) }
}

/** Estado vigente de la sesión; si la configuración cambió, empieza de cero. */
export function estado(sessionID: string, cfg: Config, ahora = Date.now()): Estado {
  const actual = estados.get(sessionID)
  if (actual && actual.firma === cfg.firma) return actual
  const nuevo: Estado = { firma: cfg.firma, tokens: 0, pasos: 0, inicio: ahora, avisadas: [] }
  estados.set(sessionID, nuevo)
  return nuevo
}

export function liberar(sessionID: string) {
  estados.delete(sessionID)
}

/** Dimensión agotada, si alguna (tokens/pasos por `>=`, minutos por tiempo transcurrido). */
export function agotada(e: Estado, cfg: Config, ahora = Date.now()): Dimension | undefined {
  if (cfg.tokens !== undefined && e.tokens >= cfg.tokens) return "tokens"
  if (cfg.pasos !== undefined && e.pasos >= cfg.pasos) return "pasos"
  if (cfg.minutos !== undefined && ahora - e.inicio >= cfg.minutos * 60_000) return "minutos"
  return undefined
}

/** ¿Está agotado el presupuesto de la sesión ahora? (para 3A: el bucle de objetivo lo consulta). */
export function estaAgotado(sessionID: string, metadata: Record<string, unknown> | undefined): Dimension | undefined {
  const cfg = leer(metadata)
  if (!cfg) return undefined
  return agotada(estado(sessionID, cfg), cfg)
}

function uso(e: Estado, cfg: Config, d: Dimension, ahora: number) {
  if (d === "tokens") return [e.tokens, cfg.tokens!] as const
  if (d === "pasos") return [e.pasos, cfg.pasos!] as const
  return [Math.floor((ahora - e.inicio) / 60_000), cfg.minutos!] as const
}

/** Anota un paso terminado y devuelve las dimensiones que cruzan ahora el 80 % (una sola vez cada una). */
export function registrarPaso(e: Estado, cfg: Config, tokens: number, ahora = Date.now()): Dimension[] {
  e.pasos += 1
  e.tokens += Number.isFinite(tokens) && tokens > 0 ? tokens : 0
  const nuevas: Dimension[] = []
  for (const d of ["tokens", "pasos", "minutos"] as const) {
    if (cfg[d] === undefined || e.avisadas.includes(d)) continue
    const fraccion = d === "minutos" ? (ahora - e.inicio) / (cfg.minutos! * 60_000) : uso(e, cfg, d, ahora)[0] / cfg[d]!
    if (fraccion >= UMBRAL_AVISO) {
      e.avisadas.push(d)
      nuevas.push(d)
    }
  }
  return nuevas
}

/** Tokens que cuentan por paso: lo que se paga de verdad (la lectura de caché se re-lee gratis y no cuenta). */
export function tokensDelPaso(t: { input?: number; output?: number; reasoning?: number; cache?: { write?: number } }) {
  return (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cache?.write ?? 0)
}

const NOMBRE: Record<Dimension, string> = { tokens: "tokens", pasos: "pasos", minutos: "minutos" }

export function textoAviso(e: Estado, cfg: Config, dims: Dimension[], ahora = Date.now()) {
  const partes = dims.map((d) => {
    const [u, l] = uso(e, cfg, d, ahora)
    return `${NOMBRE[d]} ${u}/${l}`
  })
  return `Aviso de presupuesto: se alcanzó el 80 % (${partes.join(", ")}). Termina lo esencial y deja la tarea en un punto estable.`
}

export function textoAgotado(e: Estado, cfg: Config, d: Dimension, ahora = Date.now()) {
  const [u, l] = uso(e, cfg, d, ahora)
  return `Presupuesto agotado (${NOMBRE[d]} ${u}/${l}). Se detuvo la ejecución sin perder lo hecho; sube el límite o reinicia el presupuesto para continuar.`
}
