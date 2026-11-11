export * as SinCodigo from "./sin-codigo"

// Lazunox (motor-18, D): `LAZUNOX_PROYECTO_SIN_CODIGO=1`, alternativa fina a OPENCODE_DISABLE_PROJECT_CONFIG.
//
// Fuentes NO confiables (con la bandera): la config del PROYECTO (opencode.json(c) de la carpeta y de las carpetas madre hasta el tope,
// sus `.opencode/`, sus `.claude/agents`) y la config global del motor (`Global.Path.config`, que en Tareas es la carpeta privada y la jaula
// la puede escribir). Confiables: OPENCODE_CONFIG_DIR y OPENCODE_CONFIG_CONTENT (los pone la app), OPENCODE_CONFIG y `~/.opencode` y
// `~/.claude/agents` de la persona.
//
// De una fuente no confiable se usa SOLO lo que es texto:
//  - de su opencode.json: `instructions`, `skills.paths`, `agent`/`mode` (limpios), `command` (limpios), `default_agent`, `username`,
//    `layout`, `$schema`. Todo lo demás se descarta (plugin, mcp, formatter, lsp, permission, tools, model, small_model, provider,
//    shell, share, experimental, references…) y NO se resuelven `{env:…}` ni `{file:…}`;
//  - agentes y modos (.md): se quitan `model`, `variant` y `options`; de `permission` y `tools` solo queda lo que RESTRINGE (deny / false):
//    nada que amplíe;
//  - comandos (.md): cargan, pero `` !`cmd` `` no se ejecuta (se deja como texto entre comillas invertidas); sin `model`/`variant`;
//  - complementos `.opencode/plugin(s)` y herramientas `.opencode/tool(s)`: no se cargan; tampoco se instala npm en esas carpetas.
// Además, con la bandera, formateadores y LSP quedan apagados (los incluidos ejecutan binarios del proyecto, p. ej. node_modules/.bin).
// AGENTS.md (de la carpeta y de las madre), reglas por ruta y skills siguen igual: son texto.

import path from "path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"

export const activo = () => Flag.LAZUNOX_PROYECTO_SIN_CODIGO

/** Carpetas de config que siguen siendo confiables con la bandera (las de la app y las de la persona). */
export function carpetaConfiable(dir: string): boolean {
  const d = path.resolve(dir)
  if (Flag.OPENCODE_CONFIG_DIR && d === path.resolve(Flag.OPENCODE_CONFIG_DIR)) return true
  return d === path.resolve(Global.Path.home, ".opencode")
}

/** ¿Hay que tratar esta carpeta de config como no confiable? (solo con la bandera) */
export const carpetaSinCodigo = (dir: string) => activo() && !carpetaConfiable(dir)

/** Claves de opencode.json que se conservan de una fuente no confiable. */
export const CLAVES_DE_TEXTO = new Set([
  "$schema",
  "instructions",
  "skills",
  "agent",
  "mode",
  "command",
  "default_agent",
  "username",
  "layout",
])

const esObjeto = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

/** Solo lo que restringe: acción "deny" (como texto o dentro de un objeto patrón → acción). `undefined` si no queda nada. */
export function soloRestricciones(permission: unknown): unknown {
  if (permission === "deny") return "deny"
  if (!esObjeto(permission)) return undefined
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(permission)) {
    if (v === "deny") out[k] = "deny"
    else if (esObjeto(v)) {
      const sub: Record<string, string> = {}
      for (const [p, a] of Object.entries(v)) if (a === "deny") sub[p] = "deny"
      if (Object.keys(sub).length) out[k] = sub
    }
  }
  return Object.keys(out).length ? out : undefined
}

/** Agente o modo de una fuente no confiable: sin modelo ni opciones del servicio; permisos y herramientas solo restrictivos. */
export function limpiarAgente<T>(agente: T): T {
  if (!esObjeto(agente)) return agente
  const { model: _m, variant: _v, options: _o, permission, tools, ...resto } = agente as Record<string, unknown>
  const out: Record<string, unknown> = { ...resto }
  const p = soloRestricciones(permission)
  if (p !== undefined) out.permission = p
  if (esObjeto(tools)) {
    const t: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(tools)) if (v === false) t[k] = false
    if (Object.keys(t).length) out.tools = t
  }
  return out as T
}

/** `` !`cmd` `` → `` `cmd` ``: el texto queda, la ejecución no. */
export const sinEjecucion = (template: string) => template.replace(/!`([^`]+)`/g, "`$1`")

/** Comando de una fuente no confiable: sin `!cmd` ejecutable ni modelo propio. */
export function limpiarComando<T>(comando: T): T {
  if (!esObjeto(comando)) return comando
  const { model: _m, variant: _v, ...resto } = comando as Record<string, unknown>
  if (typeof resto.template === "string") resto.template = sinEjecucion(resto.template)
  return resto as T
}

export function limpiarAgentes<T extends Record<string, unknown>>(agentes: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(agentes ?? {})) out[k] = limpiarAgente(v)
  return out as T
}

export function limpiarComandos<T extends Record<string, unknown>>(comandos: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(comandos ?? {})) out[k] = limpiarComando(v)
  return out as T
}

/** opencode.json de una fuente no confiable, ya leído como JSON: solo las claves de texto, limpias. */
export function limpiarInfo(data: unknown): Record<string, unknown> {
  if (!esObjeto(data)) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) {
    if (!CLAVES_DE_TEXTO.has(k)) continue
    if (k === "agent" || k === "mode") out[k] = esObjeto(v) ? limpiarAgentes(v) : v
    else if (k === "command") out[k] = esObjeto(v) ? limpiarComandos(v) : v
    else if (k === "skills") {
      if (esObjeto(v) && Array.isArray(v.paths)) out[k] = { paths: v.paths }
    } else out[k] = v
  }
  return out
}
