// Lazunox (Ola 7, 7.4): respuesta cortada por el límite de salida (`finish = "length"`). Código puro; las llamadas están en
// `processor.ts` (cierra las llamadas a herramienta con argumentos incompletos) y `prompt.ts` (aviso sintético y tope de racha).
//
// Diseño (el de OpenCode 2.x, no un reintento a ciegas):
//  - Una llamada a herramienta con argumentos incompletos FALLA con un mensaje que pide dividir el trabajo y muestra un extracto
//    (2048 caracteres) de lo recibido. Nunca se reejecuta nada: una llamada cortada no tiene argumentos completos y no se ejecutó.
//  - Si la respuesta se cortó sin llamadas a herramienta, se inyecta un aviso sintético en el turno siguiente.
//  - Tras 3 respuestas seguidas cortadas la sesión falla con un error propio.
// Interruptor: `LAZUNOX_SALIDA_CORTADA=0` apaga todo (comportamiento anterior).

export const EXTRACTO_MAX = 2048
export const MAX_RACHA = 3

/** Marca en `metadata` del mensaje sintético para que la app lo pinte y para contar la racha. */
export const MARCA = "lazunox_salida_cortada"

export const AVISO_SINTETICO =
  "Tu última respuesta llegó al límite de salida y quedó cortada. Divide el trabajo en pasos más pequeños (por ejemplo, un archivo o una sección por vez) y continúa sin repetir lo ya hecho."

export function activo(env: Record<string, string | undefined> = process.env): boolean {
  return env.LAZUNOX_SALIDA_CORTADA !== "0"
}

/** ¿Los argumentos recibidos (texto acumulado de la transmisión) están cortados? Vacío no se considera cortado. */
export function argumentosIncompletos(crudo: string): boolean {
  if (!crudo.trim()) return false
  try {
    JSON.parse(crudo)
    return false
  } catch {
    return true
  }
}

export function mensajeHerramienta(tool: string, crudo: string): string {
  const extracto = crudo.slice(0, EXTRACTO_MAX)
  const cortado = crudo.length > extracto.length ? "\n[recortado]" : ""
  const base =
    `La llamada a ${tool} NO se ejecutó: la respuesta llegó al límite de salida (finish: length) antes de que terminaras los argumentos. ` +
    "Divide el trabajo en llamadas más pequeñas (menos contenido por llamada) y vuelve a emitirlas con los argumentos completos."
  if (!extracto) return base
  return `${base}\n\nExtracto de lo recibido (primeros ${extracto.length} de ${crudo.length} caracteres):\n${extracto}${cortado}`
}

export const ERROR_RACHA =
  "La respuesta del modelo se cortó por el límite de salida 3 veces seguidas, incluso tras pedirle que dividiera el trabajo. " +
  "Pide una tarea más pequeña o usa un modelo con más margen de salida."

type MensajeMinimo = {
  info: { role: string; finish?: string }
  parts: ReadonlyArray<{ type: string; metadata?: Record<string, unknown> }>
}

/**
 * Respuestas del asistente cortadas por longitud, seguidas y contando desde la última. Solo la interrumpen otro tipo de cierre o un mensaje
 * de la persona; los avisos sintéticos propios (con `MARCA`) no la interrumpen.
 */
export function racha(msgs: ReadonlyArray<MensajeMinimo>): number {
  let n = 0
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.info.role === "assistant") {
      if (m.info.finish !== "length") break
      n++
      continue
    }
    if (m.info.role === "user" && m.parts.length > 0 && m.parts.every((p) => p.type === "text" && p.metadata?.[MARCA] !== undefined)) continue
    break
  }
  return n
}
