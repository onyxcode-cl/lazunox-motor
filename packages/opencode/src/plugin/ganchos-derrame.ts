// Lazunox (Ola 7, 7.6): derrame a disco de la salida grande de un gancho. En vez de cortar en silencio, el texto completo (con tope) se
// guarda en la carpeta de salidas del motor (misma retención de 7 días) y al modelo llega el principio y el final más la ruta, dentro del
// MISMO tope de antes (no gasta más tokens). `LAZUNOX_GANCHOS_DERRAME=0` vuelve al corte silencioso.
import fs from "node:fs"
import path from "node:path"
import { ToolID } from "@/tool/schema"
import { TRUNCATION_DIR } from "@/tool/truncation-dir"

/** Bytes que se capturan de la salida de un gancho cuando el derrame está activo (sin derrame: 8 KB como antes). */
export const TOPE_CAPTURA = 1024 * 1024
/** Tope del archivo derramado. */
export const TOPE_ARCHIVO = 1024 * 1024

export const derrameActivo = (env: Record<string, string | undefined> = process.env) => env.LAZUNOX_GANCHOS_DERRAME !== "0"

/** Texto acotado a `tope` caracteres. Si se pasa y el derrame está activo, el original completo queda en un archivo. */
export function acotar(texto: string, tope: number, etiqueta: string, registrar?: (m: string) => void): string {
  if (texto.length <= tope) return texto
  if (!derrameActivo()) return texto.slice(0, tope)
  let ruta: string
  try {
    fs.mkdirSync(TRUNCATION_DIR, { recursive: true })
    ruta = path.join(TRUNCATION_DIR, ToolID.ascending())
    fs.writeFileSync(ruta, texto.slice(0, TOPE_ARCHIVO))
  } catch (e) {
    registrar?.(`${etiqueta}: no se pudo derramar a disco (${e instanceof Error ? e.message : String(e)}); se corta`)
    return texto.slice(0, tope)
  }
  const nota = `\n[... ${texto.length - Math.min(texto.length, TOPE_ARCHIVO) > 0 ? `más de ${TOPE_ARCHIVO} caracteres` : `${texto.length} caracteres`} en total de ${etiqueta}; completo en ${ruta} (léelo con read si hace falta) ...]\n`
  const util = Math.max(0, tope - nota.length)
  const cabeza = Math.ceil(util * 0.6)
  return texto.slice(0, cabeza) + nota + texto.slice(texto.length - (util - cabeza))
}
