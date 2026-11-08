// Lazunox (lazunox.15): tope de tamaño a los archivos de instrucciones (AGENTS.md, CLAUDE.md, CONTEXT.md, la global, las de
// `instructions` y las de URL). Sin tope, un archivo enorme (o uno que crece por `@imports`) se manda entero al modelo en cada
// paso: cuesta tokens y deja sin sitio a la conversación. 32 KiB por archivo, contados DESPUÉS de expandir los `@imports`.
// Apagable con `LAZUNOX_TOPE_INSTRUCCIONES=0`. No cambia permisos: solo recorta lo que se manda al modelo, no el archivo en disco.

export const TOPE_BYTES = 32 * 1024
export const AVISO = "[Lazunox: este archivo de instrucciones se recortó a 32 KB; el resto no se cargó]"

export const activo = (env: NodeJS.ProcessEnv = process.env) => env.LAZUNOX_TOPE_INSTRUCCIONES !== "0"

/**
 * Si `texto` pasa de 32 KiB (UTF-8), lo corta en un límite de línea (nunca a media letra) y añade `AVISO` en su propia línea.
 * El resultado sin el aviso mide como mucho `TOPE_BYTES`. Si no pasa del tope, o está apagado, lo devuelve igual.
 */
export function aplicar(texto: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!texto || !activo(env)) return texto
  const buf = Buffer.from(texto, "utf-8")
  if (buf.length <= TOPE_BYTES) return texto
  // Retrocede hasta no partir un carácter UTF-8 de varios bytes (los de continuación son 10xxxxxx).
  let fin = TOPE_BYTES
  while (fin > 0 && (buf[fin]! & 0xc0) === 0x80) fin--
  let corte = buf.subarray(0, fin).toString("utf-8")
  // Límite de línea: si el corte cayó a media línea, quita esa línea incompleta (si no hay saltos, se queda el trozo).
  // Solo si se conserva una parte razonable (la mitad del tope o más): una línea enorme tras una corta no debe tirar casi todo.
  const salto = Math.max(corte.lastIndexOf("\n"), corte.lastIndexOf("\r"))
  if (buf[fin] !== 0x0a && buf[fin] !== 0x0d && salto > 0 && Buffer.byteLength(corte.slice(0, salto), "utf-8") >= TOPE_BYTES / 2)
    corte = corte.slice(0, salto)
  return `${corte.replace(/[\r\n]+$/, "")}\n${AVISO}`
}
