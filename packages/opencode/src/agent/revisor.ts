/**
 * Lazunox (3C, P18 + P21): piezas puras de los agentes nativos `verificador` y `revisor`. Sin dependencias del motor.
 *
 *  - `ESQUEMA_HALLAZGOS`: contrato de salida del revisor (`findings[]`). Se manda al motor como `format: json_schema` y además se
 *    valida aquí (`comprobarHallazgos`), porque el SDK de IA no valida los argumentos de `StructuredOutput`.
 *  - `leerVeredicto` / `acotarEvidencia`: el verificador contesta PASA o FALLA con evidencia de como mucho 2 KB.
 */
import { jsonDeTexto, validarEsquema } from "@/cli/cmd/run-banderas"

export const AGENTE_VERIFICADOR = "verificador"
export const AGENTE_REVISOR = "revisor"

/** Evidencia máxima del verificador (bytes UTF-8). */
export const EVIDENCIA_MAX_BYTES = 2048
/** Tope de hallazgos por revisión: una lista más larga es ruido, no revisión. */
export const HALLAZGOS_MAX = 50

export const PRIORIDADES = ["P0", "P1", "P2", "P3"] as const
export type Prioridad = (typeof PRIORIDADES)[number]

export const ESQUEMA_HALLAZGOS = {
  type: "object",
  additionalProperties: false,
  required: ["findings", "overall_correctness", "overall_explanation"],
  properties: {
    findings: {
      type: "array",
      maxItems: HALLAZGOS_MAX,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "body", "priority", "confidence", "file", "line"],
        properties: {
          title: { type: "string", minLength: 1, maxLength: 120 },
          body: { type: "string", minLength: 1, maxLength: 2000 },
          priority: { type: "string", enum: [...PRIORIDADES] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          file: { type: "string", minLength: 1, maxLength: 500 },
          line: { type: "integer", minimum: 1 },
          line_end: { type: "integer", minimum: 1 },
        },
      },
    },
    overall_correctness: { type: "string", enum: ["correct", "incorrect"] },
    overall_explanation: { type: "string", maxLength: 1000 },
  },
} as const

export type Hallazgo = {
  title: string
  body: string
  priority: Prioridad
  confidence: number
  file: string
  line: number
  line_end?: number
}
export type Revision = { findings: Hallazgo[]; overall_correctness: "correct" | "incorrect"; overall_explanation: string }

export type ResultadoRevision = { valido: true; revision: Revision } | { valido: false; errores: string[] }

/** Valida la salida del revisor (JSON tal cual o dentro de un bloque ```json). Solo cuenta lo que cumple el esquema. */
export function comprobarHallazgos(texto: string | undefined): ResultadoRevision {
  if (!texto || !texto.trim()) return { valido: false, errores: ["la respuesta está vacía"] }
  const j = jsonDeTexto(texto.trim())
  if (!j.ok) return { valido: false, errores: ["la respuesta no es JSON"] }
  const errores = validarEsquema(ESQUEMA_HALLAZGOS as unknown as Record<string, unknown>, j.valor)
  if (errores.length) return { valido: false, errores }
  const revision = j.valor as Revision
  // Coherencia que el esquema no expresa: una línea final nunca va antes que la inicial.
  const mal = revision.findings.findIndex((f) => f.line_end !== undefined && f.line_end < f.line)
  if (mal !== -1) return { valido: false, errores: [`findings[${mal}]: line_end es menor que line`] }
  return { valido: true, revision }
}

export type Veredicto = "PASA" | "FALLA" | "NO_VERIFICABLE"

/** Corta `texto` a `max` bytes UTF-8 sin partir un carácter. */
export function acotarEvidencia(texto: string, max = EVIDENCIA_MAX_BYTES): string {
  const bytes = new TextEncoder().encode(texto)
  if (bytes.length <= max) return texto
  const marca = "\n[…recortado]"
  const limite = Math.max(0, max - new TextEncoder().encode(marca).length)
  let fin = limite
  // retroceder hasta un inicio de carácter (los bytes de continuación son 10xxxxxx)
  while (fin > 0 && (bytes[fin]! & 0xc0) === 0x80) fin--
  return new TextDecoder().decode(bytes.slice(0, fin)) + marca
}

/** Primera línea con el veredicto (`PASA`, `FALLA` o `NO VERIFICABLE`) y el resto como evidencia acotada a 2 KB. */
export function leerVeredicto(texto: string | undefined): { veredicto: Veredicto; evidencia: string } | undefined {
  if (!texto) return undefined
  const m = /^\s*(PASA|FALLA|NO[ _]VERIFICABLE)\b[:\s-]*([\s\S]*)$/.exec(texto)
  if (!m) return undefined
  const veredicto = m[1]!.startsWith("NO") ? "NO_VERIFICABLE" : (m[1] as "PASA" | "FALLA")
  return { veredicto, evidencia: acotarEvidencia(m[2]!.trim()) }
}
