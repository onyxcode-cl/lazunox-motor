export * as Bucles from "./bucles"

// Lazunox (motor-18, J): detectores de bucle que complementan el de siempre (3 llamadas idénticas seguidas, processor.ts).
// Idea de Gemini CLI (services/loopDetectionService.ts: ciclos de largo 1-5 y texto repetido); código y umbrales propios, no copiados.
//  - Ciclos de 2 a 5 llamadas que se repiten (A-B-A-B…): se compara herramienta + argumentos, así que leer muchos archivos distintos
//    con la misma herramienta NO cuenta. Umbral conservador: el ciclo completo repetido 4 veces si es de largo 2 (8 llamadas) y 3 veces
//    si es de largo 3 a 5 (9 a 15 llamadas), todas seguidas al final del turno.
//  - Texto repetido del asistente: el mismo trozo de 64 caracteres (con letras) 8 o más veces en los últimos 6000, sin contar bloques de
//    código, tablas, listas, encabezados ni citas (donde repetir es normal).
// Al detectar, el procesador hace lo mismo que el detector de siempre: pide el permiso `doom_loop` (la persona decide si seguir).
// LAZUNOX_BUCLES_AMPLIADOS=0 apaga los dos detectores nuevos.

export const activo = (env: NodeJS.ProcessEnv = process.env) => env.LAZUNOX_BUCLES_AMPLIADOS !== "0"

/** Firma de una llamada: herramienta + argumentos (JSON). */
export const firma = (tool: string, input: unknown) => `${tool}\u0000${JSON.stringify(input ?? null)}`

const repeticionesPara = (largo: number) => (largo === 2 ? 4 : 3)

/**
 * ¿Las últimas llamadas son un ciclo de largo 2 a 5 repetido? Devuelve el largo o `undefined`. Un ciclo de llamadas todas iguales (largo
 * 1) lo cubre el detector de siempre y aquí no se cuenta.
 */
export function ciclo(firmas: readonly string[]): number | undefined {
  for (let largo = 2; largo <= 5; largo++) {
    const veces = repeticionesPara(largo)
    const total = largo * veces
    if (firmas.length < total) continue
    const cola = firmas.slice(-total)
    const patron = cola.slice(0, largo)
    if (new Set(patron).size < 2) continue
    if (cola.every((f, i) => f === patron[i % largo])) return largo
  }
  return undefined
}

const TROZO = 64
const VENTANA = 6000
const MIN_VECES = 8

/** Quita lo que suele repetirse sin ser un bucle: bloques de código, tablas, listas, encabezados, citas y líneas vacías. */
export function sinEstructura(texto: string): string {
  const sinCodigo = texto.replace(/```[\s\S]*?(```|$)/g, "\n")
  return sinCodigo
    .split("\n")
    .filter((l) => {
      const t = l.trim()
      if (!t) return false
      return !/^(\||[-*+]\s|\d+[.)]\s|#|>)/.test(t)
    })
    .join("\n")
}

/** ¿El asistente está repitiendo el mismo trozo de texto una y otra vez? */
export function textoRepetido(texto: string): boolean {
  const limpio = sinEstructura(texto.slice(-VENTANA * 2)).slice(-VENTANA)
  if (limpio.length < TROZO * MIN_VECES) return false
  const trozo = limpio.slice(-TROZO)
  if ((trozo.match(/\p{L}/gu) ?? []).length < 24) return false
  let veces = 0
  for (let i = limpio.indexOf(trozo); i >= 0; i = limpio.indexOf(trozo, i + 1)) veces++
  return veces >= MIN_VECES
}
