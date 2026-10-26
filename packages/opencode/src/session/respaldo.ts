// Lazunox (Ola 6, paquete 6.10, H13): respaldo de modelo gratuito.
//
// Cuando el modelo del turno cae (sobrecarga/5xx que ya agotó los reintentos) o su cuota gratuita se agota («Free usage
// exceeded»), el procesador reintenta UN solo paso con un modelo de respaldo. Reglas, todas comprobadas en CADA conmutación:
//  (a) el respaldo es de coste cero (`cost.input === 0 && cost.output === 0`); nunca uno de pago;
//  (b) del mismo proveedor, o de otro solo si la persona lo consintió (`respaldo.otro_proveedor: true`): el texto de la
//      conversación saldría hacia otro servicio;
//  (c) la lista se lee SOLO de la configuración GLOBAL (`Config.getGlobal`), jamás del `opencode.json` del proyecto: un
//      repositorio hostil no puede redirigir la conversación a su servidor;
//  (d) como mucho un cambio por turno de la persona y sin bucles; se avisa con una parte de texto.
// Apagado por defecto (sin `respaldo.modelos` global no hace nada) y con el interruptor `LAZUNOX_RESPALDO=0`.
// No cambia permisos ni reglas: solo cambia el modelo con el que se llama.
import { Effect } from "effect"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import type { Config } from "@/config/config"
import type { Provider } from "@/provider/provider"
import { SessionRetry } from "./retry"

export const MAX_MODELOS = 3
export const activo = (env: NodeJS.ProcessEnv = process.env) => env.LAZUNOX_RESPALDO !== "0"

export type Motivo = "cuota" | "sobrecarga"
export type Ajustes = { modelos: { providerID: string; modelID: string }[]; otroProveedor: boolean }
type ModeloRef = Pick<Provider.Model, "id" | "providerID">

/** Lista de respaldo de la configuración GLOBAL (hasta 3, sin repetidos). Sin ella, `undefined` (apagado). */
export function leer(global: ConfigV1.Info | undefined): Ajustes | undefined {
  const bruto = global?.respaldo?.modelos
  if (!Array.isArray(bruto)) return undefined
  const modelos: Ajustes["modelos"] = []
  for (const valor of bruto) {
    if (typeof valor !== "string") continue
    const i = valor.indexOf("/")
    if (i <= 0 || i === valor.length - 1) continue
    const ref = { providerID: valor.slice(0, i).trim(), modelID: valor.slice(i + 1).trim() }
    if (!ref.providerID || !ref.modelID) continue
    if (modelos.some((m) => m.providerID === ref.providerID && m.modelID === ref.modelID)) continue
    modelos.push(ref)
    if (modelos.length >= MAX_MODELOS) break
  }
  if (!modelos.length) return undefined
  return { modelos, otroProveedor: global?.respaldo?.otro_proveedor === true }
}

/** Por qué falló el modelo: «cuota» (límite gratuito/de uso agotado), «sobrecarga» (5xx, saturado, red) o `undefined` (no aplica). */
export function motivoDe(error: SessionRetry.Err, provider: string): Motivo | undefined {
  const r = SessionRetry.retryable(error, provider)
  if (!r) return undefined
  if (r.action) return "cuota"
  if (/free usage exceeded|FreeUsageLimitError/i.test(r.message)) return "cuota"
  return "sobrecarga"
}

export const esCuota = (error: SessionRetry.Err, provider: string) => motivoDe(error, provider) === "cuota"

export type Veredicto = { ok: true } | { ok: false; razon: "pago" | "otro-proveedor" | "mismo-modelo" }

/** Reglas (a) y (b). Se comprueba en cada conmutación, no solo al leer la configuración. */
export function admitido(input: { candidato: Provider.Model; actual: ModeloRef; ajustes: Ajustes }): Veredicto {
  const { candidato, actual, ajustes } = input
  if (candidato.providerID === actual.providerID && candidato.id === actual.id) return { ok: false, razon: "mismo-modelo" }
  const c = candidato.cost
  if (!c || c.input !== 0 || c.output !== 0) return { ok: false, razon: "pago" }
  if (candidato.providerID !== actual.providerID && !ajustes.otroProveedor) return { ok: false, razon: "otro-proveedor" }
  return { ok: true }
}

export type Candidatos = { modelos: Provider.Model[]; otroProveedor: boolean }
const VACIO: Candidatos = { modelos: [], otroProveedor: false }

/**
 * Resolutor para el procesador: lee SOLO la configuración global y devuelve, en orden, los respaldos válidos para `actual`.
 * Un modelo que no existe, no está conectado, es de pago o es de otro proveedor sin consentimiento se omite.
 */
export function resolutor(deps: {
  config: Pick<Config.Interface, "getGlobal">
  provider: Pick<Provider.Interface, "getModel">
}) {
  return (actual: ModeloRef): Effect.Effect<Candidatos> =>
    Effect.gen(function* () {
      if (!activo()) return VACIO
      const ajustes = leer(yield* deps.config.getGlobal())
      if (!ajustes) return VACIO
      const salida: Provider.Model[] = []
      for (const ref of ajustes.modelos) {
        const modelo = yield* deps.provider
          .getModel(ProviderV2.ID.make(ref.providerID), ModelV2.ID.make(ref.modelID))
          .pipe(Effect.orElseSucceed(() => undefined))
        if (!modelo) continue
        if (admitido({ candidato: modelo, actual, ajustes }).ok) salida.push(modelo)
      }
      return { modelos: salida, otroProveedor: ajustes.otroProveedor }
    }).pipe(Effect.orElseSucceed(() => VACIO))
}

/** Candidatos ya validados y con `otro_proveedor` aplicado: el procesador los vuelve a comprobar con `admitir`. */
export type Resolutor = ReturnType<typeof resolutor>

/** Segunda comprobación en el momento de conmutar (defensa en profundidad): coste cero y, si cambia de proveedor, consentimiento. */
export function admitir(candidato: Provider.Model, actual: ModeloRef, otroProveedor: boolean): boolean {
  return admitido({ candidato, actual, ajustes: { modelos: [], otroProveedor } }).ok
}

// Un cambio por turno de la persona: se recuerda por (sesión, mensaje de usuario) para que los pasos siguientes del mismo
// turno sigan con el respaldo sin volver a esperar al modelo caído, y para no encadenar un segundo cambio.
const vigentes = new Map<string, string>()
const VIGENTES_MAX = 256
const clave = (sessionID: string, userID: string) => `${sessionID}:${userID}`
export const modeloVigente = (sessionID: string, userID: string) => vigentes.get(clave(sessionID, userID))
export function recordar(sessionID: string, userID: string, modelo: ModeloRef) {
  if (vigentes.size >= VIGENTES_MAX) vigentes.delete(vigentes.keys().next().value as string)
  vigentes.set(clave(sessionID, userID), `${modelo.providerID}/${modelo.id}`)
}
export const olvidar = () => vigentes.clear()

export const textoAviso = (de: ModeloRef, a: ModeloRef) =>
  `El modelo ${de.providerID}/${de.id} no respondió; este turno se hizo con ${a.providerID}/${a.id}.`
