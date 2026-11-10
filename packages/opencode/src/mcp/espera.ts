// Lazunox (Q1.1): plazo corto para los conectores MCP en el primer mensaje.
// Antes, la primera petición de una conversación esperaba a que TODOS los conectores terminaran de conectar (tope de 30 s cada uno):
// uno lento o caído frenaba la primera respuesta. Ahora se espera solo `plazoMs` y se sigue con los ya listos; los demás terminan en
// segundo plano y sus herramientas aparecen en el siguiente paso. `undefined` = comportamiento anterior (esperar todo).

/** Plazo por defecto (ms). */
export const PLAZO_POR_DEFECTO_MS = 2000

/** Lee `LAZUNOX_MCP_ESPERA_MS`. Sin variable: 2000. `0`, negativo, no numérico o infinito: `undefined` (esperar todo, como antes). */
export function plazoMs(env: Record<string, string | undefined> = process.env): number | undefined {
  const raw = env.LAZUNOX_MCP_ESPERA_MS
  if (raw === undefined || raw.trim() === "") return PLAZO_POR_DEFECTO_MS
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.floor(n)
}

/** Nota corta para el modelo mientras haya conectores conectando. Va en el mensaje de la persona, no en el sistema fijo (caché). */
export function nota(nombres: readonly string[]): string | undefined {
  if (nombres.length === 0) return undefined
  const lista = [...nombres].sort((a, b) => a.localeCompare(b)).join(", ")
  return `<mcp_conectando>Conectores MCP todavía conectando: ${lista}. Sus herramientas aún no están en la lista y aparecerán en cuanto terminen; no digas que no existen.</mcp_conectando>`
}
