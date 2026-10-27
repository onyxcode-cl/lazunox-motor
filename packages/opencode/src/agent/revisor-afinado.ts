// Lazunox (Ola 7 — 7.14): criterios de la rúbrica de revisión de Codex (`review/rubric.md`) que el revisor nativo no tenía por escrito.
// Solo texto de prompt: no cambia permisos, herramientas ni el formato de salida. `LAZUNOX_OBJETIVO_AFINADO=0` lo quita (y el afinado
// del modo objetivo, que comparte interruptor).
export const afinado = (env: NodeJS.ProcessEnv = process.env) => env.LAZUNOX_OBJETIVO_AFINADO !== "0"

export const REGLAS_REVISOR_AFINADAS = [
  "Qué merece ser un hallazgo (todas deben cumplirse):",
  "- Afecta de forma real a la exactitud, el rendimiento, la seguridad o el mantenimiento, y el autor lo arreglaría si lo supiera.",
  "- Es discreto y accionable: UN problema por hallazgo (no juntes varios) y no es una queja general sobre el proyecto.",
  "- Lo introdujo este cambio (no uno anterior) y no es un cambio claramente intencional del autor.",
  "- No depende de suposiciones sin respaldo sobre el resto del código ni sobre la intención del autor. Si dices que afecta a otras partes, nómbralas y comprueba que existen; no especules.",
  "- Arreglarlo no exige un rigor que el resto del proyecto no tiene (formato, documentación o estilo no cuentan).",
  "Un hallazgo debe señalar las líneas exactas donde está el error, no el archivo entero.",
].join("\n")

const MARCA_FORMATO = "Formato de la respuesta final"

/** Las reglas van ANTES del formato de salida (el formato debe seguir siendo lo último que el modelo lee). */
export const promptRevisor = (base: string, env: NodeJS.ProcessEnv = process.env) => {
  if (!afinado(env)) return base
  const i = base.indexOf(MARCA_FORMATO)
  if (i < 0) return `${base.trimEnd()}\n\n${REGLAS_REVISOR_AFINADAS}\n`
  return `${base.slice(0, i)}${REGLAS_REVISOR_AFINADAS}\n\n${base.slice(i)}`
}
