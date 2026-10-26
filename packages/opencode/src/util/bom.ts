import { Effect } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"

const BOM_CODE = 0xfeff
const BOM = String.fromCharCode(BOM_CODE)

export function split(text: string) {
  if (text.charCodeAt(0) !== BOM_CODE) return { bom: false, text }
  return { bom: true, text: text.slice(1) }
}

export function join(text: string, bom: boolean) {
  const stripped = split(text).text
  if (!bom) return stripped
  return BOM + stripped
}

/** Lazunox (Ola 7, 7.8): `LAZUNOX_EDICION_SEGURA=0` vuelve a decodificar sin rechazar y a los finales de línea de antes. */
export function edicionSegura() {
  return process.env.LAZUNOX_EDICION_SEGURA !== "0"
}

export function mensajeNoUtf8(filePath: string) {
  return (
    `${filePath} no es UTF-8 válido (parece Latin-1 u otra codificación, o un binario). El archivo NO se tocó: ` +
    `reescribirlo con edit/write/apply_patch lo degradaría y perdería datos. Para cambiarlo usa un comando de shell ` +
    `que conserve la codificación (por ejemplo sed -i, perl -pi o iconv) o pídele a la persona que lo convierta antes.`
  )
}

const esUtf16le = (bytes: Uint8Array) => bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe

/** Decodifica con el comportamiento de siempre: los bytes inválidos pasan a U+FFFD (pérdida de datos si se reescribe). */
export const readFileLossy = Effect.fn("Bom.readFileLossy")(function* (fs: FSUtil.Interface, filePath: string) {
  return split(new TextDecoder("utf-8", { ignoreBOM: true }).decode(yield* fs.readFile(filePath)))
})

/**
 * Lee un archivo para editarlo. Con la edición segura, rechaza lo que no es UTF-8 válido (salvo UTF-16 LE con BOM, que se
 * decodifica y se marca `utf16` para reescribirlo igual).
 */
export const readFile = Effect.fn("Bom.readFile")(function* (fs: FSUtil.Interface, filePath: string) {
  const bytes = yield* fs.readFile(filePath)
  if (!edicionSegura()) return { ...split(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)), utf16: false }
  if (esUtf16le(bytes)) {
    try {
      return { ...split(new TextDecoder("utf-16le", { ignoreBOM: true, fatal: true }).decode(bytes)), utf16: true }
    } catch {
      return yield* Effect.fail(new Error(mensajeNoUtf8(filePath)))
    }
  }
  try {
    return { ...split(new TextDecoder("utf-8", { ignoreBOM: true, fatal: true }).decode(bytes)), utf16: false }
  } catch {
    return yield* Effect.fail(new Error(mensajeNoUtf8(filePath)))
  }
})

/** Lo que se escribe: texto UTF-8, o bytes UTF-16 LE si el archivo original lo era. */
export function salida(text: string, bom: boolean, utf16 = false): string | Uint8Array {
  const out = join(text, bom || utf16)
  return utf16 ? Buffer.from(out, "utf16le") : out
}

export const syncFile = Effect.fn("Bom.syncFile")(function* (fs: FSUtil.Interface, filePath: string, bom: boolean) {
  const current = yield* readFileLossy(fs, filePath)
  if (current.bom === bom) return current.text
  yield* fs.writeWithDirs(filePath, join(current.text, bom))
  return current.text
})
