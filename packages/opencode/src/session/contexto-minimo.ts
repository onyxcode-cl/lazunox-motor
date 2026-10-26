// Lazunox (Ola 6, 6.3 · H3): ayudantes de solo lectura con CONTEXTO MÍNIMO.
// Una sesión hija cuyo agente declara `contexto: "minimo"` no recibe AGENTS.md (`instruction.system()`), la lista de skills ni las
// instrucciones de MCP, y sin prompt propio usa uno corto. Se recorta CONTEXTO, nunca protecciones: los permisos, las rutas protegidas,
// las reglas por ruta (4D, se adjuntan al leer) y los topes de 2A no pasan por aquí. Apagado por defecto: `LAZUNOX_AYUDANTES_MINIMOS=1`.
import { Permission } from "@/permission"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import PROMPT_CORTO from "./prompt/contexto-minimo.txt"

/** Interruptor general (apagado por defecto). */
export const activo = (env: NodeJS.ProcessEnv = process.env) => env.LAZUNOX_AYUDANTES_MINIMOS === "1"

/** Agentes nativos que van con `minimo` por defecto. Nunca `general` ni `build`. */
export const NATIVOS_MINIMOS: ReadonlySet<string> = new Set(["explore", "verificador", "revisor"])
const NUNCA = new Set(["general", "build"])

export const promptCorto = PROMPT_CORTO

export type Motivo = "completo" | "minimo" | "rechazado-edita" | "rechazado-nunca"

/**
 * Decide el contexto efectivo de una petición. `minimo` solo si: la bandera está activa, la sesión es hija, el agente lo declara,
 * no es `general`/`build` y NO puede editar (`edit` denegado en el conjunto de permisos que de verdad aplica a la sesión).
 * Un agente que edita pierde reglas del proyecto si las omite: se niega (el llamador lo registra) y sigue con contexto completo.
 */
export function decidir(input: {
  agent: { name: string; contexto?: "completo" | "minimo" | undefined; permission: PermissionV1.Ruleset }
  esHija: boolean
  permissionSesion?: PermissionV1.Ruleset
  env?: NodeJS.ProcessEnv
}): Motivo {
  if (!activo(input.env) || !input.esHija || input.agent.contexto !== "minimo") return "completo"
  if (NUNCA.has(input.agent.name)) return "rechazado-nunca"
  const reglas = Permission.merge(input.agent.permission, input.permissionSesion ?? [])
  if (!Permission.disabled(["edit"], reglas).has("edit")) return "rechazado-edita"
  return "minimo"
}

export * as ContextoMinimo from "./contexto-minimo"
