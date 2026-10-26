// Lazunox (Ola 7, 7.21): resultados binarios de MCP (imagen, audio, recursos blob) → archivo en la carpeta de salidas del motor.
// El nombre lo genera el motor (`tool_<id>.<ext>`: así entra en la misma limpieza de 7 días de `Truncate.cleanup`), NUNCA el que
// diga el servidor; la extensión sale de una lista cerrada según el tipo declarado, y el tipo se comprueba contra los primeros
// bytes. Nada se ejecuta. Interruptor `LAZUNOX_MCP_BINARIOS=0`.
import fs from "fs/promises"
import path from "path"
import { ToolID } from "@/tool/schema"
import { TRUNCATION_DIR } from "@/tool/truncation-dir"

export const MAX_IMAGEN_ADJUNTA_POR_DEFECTO = 256 * 1024
/** Tope de lo que se guarda a disco por pieza (más grande: se omite con aviso). */
export const MAX_BINARIO_GUARDADO = 64 * 1024 * 1024

export function binariosActivos() {
  return process.env.LAZUNOX_MCP_BINARIOS !== "0"
}

/** `LAZUNOX_MCP_IMAGEN_MAX_BYTES`: tope de una imagen para adjuntarla al contexto (256 KiB por defecto; 0 = nunca adjuntar). */
export function topeImagen() {
  const raw = process.env.LAZUNOX_MCP_IMAGEN_MAX_BYTES
  if (raw === undefined || raw.trim() === "") return MAX_IMAGEN_ADJUNTA_POR_DEFECTO
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : MAX_IMAGEN_ADJUNTA_POR_DEFECTO
}

const EXTENSIONES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/mp4": "m4a",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/json": "json",
  "text/plain": "txt",
}

/** ¿Los primeros bytes coinciden con el tipo declarado? `undefined` = no sabemos comprobar ese tipo. */
export function coincideTipo(mime: string, b: Buffer): boolean | undefined {
  const empieza = (...bytes: number[]) => bytes.every((v, i) => b[i] === v)
  switch (mime) {
    case "image/png":
      return empieza(0x89, 0x50, 0x4e, 0x47)
    case "image/jpeg":
      return empieza(0xff, 0xd8, 0xff)
    case "image/gif":
      return empieza(0x47, 0x49, 0x46, 0x38)
    case "image/webp":
      return b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP"
    case "application/pdf":
      return b.subarray(0, 5).toString("latin1") === "%PDF-"
    default:
      return undefined
  }
}

export interface Guardado {
  readonly ok: true
  readonly ruta: string
  readonly mime: string
  readonly bytes: number
  /** `false` si los bytes no corresponden al tipo declarado (no se debe adjuntar como ese tipo). */
  readonly tipoVerificado: boolean
}
export interface NoGuardado {
  readonly ok: false
  readonly motivo: string
  readonly bytes: number
}

const MIME_VALIDO = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i

/** Guarda `base64` en la carpeta de salidas. El nombre es siempre `tool_<id>.<ext>`; `mimeDeclarado` solo elige la extensión. */
export async function guardar(base64: string, mimeDeclarado: string | undefined, dir = TRUNCATION_DIR): Promise<Guardado | NoGuardado> {
  const mime = (mimeDeclarado ?? "application/octet-stream").split(";")[0].trim().toLowerCase()
  const limpio = base64.replace(/\s/g, "")
  const estimado = Math.floor((limpio.length * 3) / 4)
  if (estimado > MAX_BINARIO_GUARDADO) return { ok: false, motivo: `supera ${MAX_BINARIO_GUARDADO / (1024 * 1024)} MB`, bytes: estimado }
  const datos = Buffer.from(limpio, "base64")
  const sniff = MIME_VALIDO.test(mime) ? coincideTipo(mime, datos) : undefined
  const verificado = sniff !== false
  const ext = (verificado && MIME_VALIDO.test(mime) && EXTENSIONES[mime]) || "bin"
  try {
    await fs.mkdir(dir, { recursive: true })
    const ruta = path.join(dir, `${ToolID.ascending()}.${ext}`)
    await fs.writeFile(ruta, datos, { mode: 0o600 })
    return { ok: true, ruta, mime: MIME_VALIDO.test(mime) ? mime : "application/octet-stream", bytes: datos.length, tipoVerificado: verificado }
  } catch (e) {
    return { ok: false, motivo: `no se pudo escribir (${e instanceof Error ? e.message : String(e)})`, bytes: datos.length }
  }
}
