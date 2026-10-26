// Lazunox (Ola 6, 6.3 · H4): nivel de exhaustividad de `explore`. Quien lo lanza acota cuánto busca: se traduce en un tope de pasos
// (6, 15 o 40) y una línea al principio de la orden. Solo para `explore` y solo con LAZUNOX_AYUDANTES_MINIMOS=1. Nunca AMPLÍA el
// tope propio del agente (`steps`/`max_turns` de 2A): manda el más bajo.
export const NIVELES = ["rapida", "media", "a_fondo"] as const
export type Nivel = (typeof NIVELES)[number]

export const PASOS: Record<Nivel, number> = { rapida: 6, media: 15, a_fondo: 40 }

const LINEAS: Record<Nivel, string> = {
  rapida: "Thoroughness: quick. Do a basic search, stop at the first good answer and use at most 6 steps.",
  media: "Thoroughness: medium. Explore a moderate number of places and use at most 15 steps.",
  a_fondo: "Thoroughness: very thorough. Check several locations and naming conventions, using at most 40 steps.",
}

export const linea = (nivel: Nivel) => LINEAS[nivel]

/** Tope efectivo: el más bajo entre el del agente y el del nivel. */
export function topeEfectivo(propio: number | undefined, nivel: Nivel | undefined) {
  if (!nivel) return propio
  return propio === undefined ? PASOS[nivel] : Math.min(propio, PASOS[nivel])
}

// Nivel pedido por sesión hija (vive lo que dura el proceso; son unos pocos bytes por ayudante lanzado).
const porSesion = new Map<string, Nivel>()
export const fijar = (sessionID: string, nivel: Nivel) => void porSesion.set(sessionID, nivel)
export const nivelDe = (sessionID: string) => porSesion.get(sessionID)
export const olvidar = (sessionID: string) => void porSesion.delete(sessionID)
