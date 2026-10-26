import type { Config } from "@/config/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"

const COMPACTION_BUFFER = 20_000

export function usable(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  const reserved =
    input.cfg.compaction?.reserved ??
    Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
  return input.model.limit.input
    ? Math.max(0, input.model.limit.input - reserved)
    : Math.max(0, context - ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
}

export function isOverflow(input: {
  cfg: ConfigV1.Info
  tokens: SessionV1.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
  /** Lazunox (6.2): umbral anticipado ya resuelto en tokens (de `resolverUmbral`). Sin él, nada cambia. */
  umbral?: number
  /** Lazunox (6.2): tokens del prefijo fijo (sistema + herramientas), que no cuentan para el umbral. */
  prefijo?: number
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  if (count >= usable(input)) return true
  return input.umbral !== undefined && count - Math.max(0, input.prefijo ?? 0) >= input.umbral
}

// ---------------------------------------------------------------------------------------------------------------------
// Lazunox (6.2): umbral de compactación anticipado y valores por modelo.
//
// SOLO se lee de la configuración GLOBAL de la app/usuario (`Config.getGlobal`), nunca del `opencode.json` del proyecto:
// un repositorio hostil no puede bajar el umbral para quemar la cuota ni subirlo para evitar compactar. Apagado por
// defecto: sin `compaction.umbral` ni `compaction.por_modelo` global, `resolverUmbral` devuelve `undefined`.
// ---------------------------------------------------------------------------------------------------------------------

export const UMBRAL_MINIMO = 16_000
/** Pasos del asistente que deben pasar tras un resumen antes de volver a compactar de forma anticipada. */
export const PASOS_MINIMOS_TRAS_RESUMEN = 2

/** Entero (tokens) o «NN%» de lo usable, con mínimo de 16 000 y sin superar lo usable. Valor no válido: `undefined`. */
export function interpretarUmbral(valor: unknown, usableTokens: number): number | undefined {
  if (usableTokens <= 0) return undefined
  let bruto: number | undefined
  if (typeof valor === "number") {
    if (Number.isFinite(valor) && valor > 0) bruto = Math.floor(valor)
  } else if (typeof valor === "string") {
    const m = /^\s*(\d{1,3})\s*%\s*$/.exec(valor)
    if (m) {
      const pct = Number(m[1])
      if (pct >= 1 && pct <= 100) bruto = Math.floor((usableTokens * pct) / 100)
    } else if (/^\s*\d{1,12}\s*$/.test(valor)) {
      bruto = Number(valor)
      if (!(bruto > 0)) bruto = undefined
    }
  }
  if (bruto === undefined) return undefined
  return Math.min(usableTokens, Math.max(UMBRAL_MINIMO, bruto))
}

function entradaPorModelo(global: ConfigV1.Info | undefined, model: Pick<Provider.Model, "id" | "providerID">) {
  const tabla = global?.compaction?.por_modelo
  if (!tabla) return undefined
  const clave = `${model.providerID}/${model.id}`
  return Object.prototype.hasOwnProperty.call(tabla, clave) ? tabla[clave] : undefined
}

/** Umbral anticipado en tokens para este modelo (gana `por_modelo` sobre el global), o `undefined` si está apagado. */
export function resolverUmbral(input: {
  global: ConfigV1.Info | undefined
  model: Pick<Provider.Model, "id" | "providerID">
  usable: number
}): number | undefined {
  const valor = entradaPorModelo(input.global, input.model)?.umbral ?? input.global?.compaction?.umbral
  if (valor === undefined) return undefined
  return interpretarUmbral(valor, input.usable)
}

/** `preserve_recent_tokens` del modelo (de la configuración global) o `undefined`. */
export function preservarPorModelo(global: ConfigV1.Info | undefined, model: Pick<Provider.Model, "id" | "providerID">) {
  return entradaPorModelo(global, model)?.preserve_recent_tokens
}

const tokensDelPrefijo = (t: SessionV1.Assistant["tokens"]) => t.input + t.cache.read + t.cache.write

const prefijos = new Map<string, number>()
const PREFIJOS_MAX = 256

/**
 * Prefijo fijo estimado de la sesión (alcance `body_after_prefix` de Codex): lo que envió la PRIMERA petición
 * (sistema + herramientas + primer mensaje). Se recuerda por sesión. Si la sesión ya se compactó y no se midió antes
 * (p. ej. tras reiniciar el motor) se usa 0: es lo más conservador hacia compactar antes, y el tope de pasos evita el bucle.
 */
export function prefijoDeSesion(sessionID: string, msgs: ReadonlyArray<SessionV1.WithParts>): number {
  const guardado = prefijos.get(sessionID)
  if (guardado !== undefined) return guardado
  if (msgs.some((m) => m.info.role === "assistant" && m.info.summary === true)) return 0
  const primero = msgs.find((m) => m.info.role === "assistant" && m.info.finish && !m.info.error)
  if (!primero || primero.info.role !== "assistant") return 0
  const valor = tokensDelPrefijo(primero.info.tokens)
  if (valor <= 0) return 0
  if (prefijos.size >= PREFIJOS_MAX) prefijos.delete(prefijos.keys().next().value as string)
  prefijos.set(sessionID, valor)
  return valor
}

export function olvidarPrefijos() {
  prefijos.clear()
}

export type PermisoAnticipado = { permitido: true } | { permitido: false; motivo: string }

/**
 * Tope contra bucles de compactación: tras un resumen exige al menos 2 pasos nuevos del asistente, y no compacta si el
 * resumen más la cola ya superan por sí solos el umbral (compactar de nuevo no ayudaría).
 */
export function anticipadoPermitido(input: {
  msgs: ReadonlyArray<SessionV1.WithParts>
  umbral: number
  prefijo: number
}): PermisoAnticipado {
  let ultimoResumen = -1
  input.msgs.forEach((m, i) => {
    if (m.info.role === "assistant" && m.info.summary === true) ultimoResumen = i
  })
  if (ultimoResumen < 0) return { permitido: true }
  const pasos = input.msgs
    .slice(ultimoResumen + 1)
    .filter((m) => m.info.role === "assistant" && m.info.finish && !m.info.error && m.info.summary !== true)
  if (pasos.length < PASOS_MINIMOS_TRAS_RESUMEN)
    return { permitido: false, motivo: `solo ${pasos.length} paso(s) desde el último resumen (mínimo ${PASOS_MINIMOS_TRAS_RESUMEN})` }
  const primero = pasos[0]!.info
  if (primero.role === "assistant") {
    const cuerpo = tokensDelPrefijo(primero.tokens) - input.prefijo
    if (cuerpo >= input.umbral)
      return { permitido: false, motivo: `el resumen y la cola (${cuerpo} tokens) ya superan el umbral ${input.umbral}` }
  }
  return { permitido: true }
}
