// Lazunox (Ola 7, 7.20): políticas duras de nivel superior. Un archivo que fija la APP (`LAZUNOX_POLICY_FILE`, ruta absoluta; como el de ganchos)
// con listas `deny` de proveedores, modelos, servidores MCP, herramientas, habilidades y agentes. **Gana a cualquier regla y un proyecto no puede
// aflojarlo**: se aplica DESPUÉS de mezclar la configuración (la del repo incluida) y no existe ninguna regla `allow` que lo contradiga.
//
// Formato (JSON):
//   { "version": 1, "deny": { "providers": ["openai", "*-free"], "models": ["anthropic/claude-3-haiku*"], "mcp": ["evil*"],
//                             "tools": ["webfetch", "websearch", "github_*"], "skills": ["*"], "agents": ["general"] } }
// Los patrones usan comodines (`*`, `?`), sin distinguir mayúsculas. `models` compara contra `proveedor/modelo`.
//
// Estados: sin variable o archivo ausente = SIN política (todo como antes). Archivo ilegible, demasiado grande, JSON roto, con tipos o claves que
// no se conocen, o ruta no absoluta = ROTA: **falla cerrado**, se deniega TODO (proveedores, MCP, herramientas, habilidades y agentes) y el motivo
// queda disponible en `descripcion()`. Una política rota nunca se interpreta «a medias».
import fs from "node:fs"
import path from "node:path"
import { Wildcard } from "@opencode-ai/core/util/wildcard"

export const MAX_ARCHIVO = 256 * 1024
const MAX_PATRONES = 500
const MAX_LARGO = 200
const CLAVES_DENY = ["providers", "models", "mcp", "tools", "skills", "agents"] as const
type Clave = (typeof CLAVES_DENY)[number]
export type Deny = Record<Clave, string[]>

export type Politica =
  | { estado: "ninguna" }
  | { estado: "ok"; deny: Deny; archivo: string }
  | { estado: "rota"; motivo: string; archivo: string }

/** Interpreta el contenido del archivo. Estricto: cualquier cosa que no se entienda lo deja ROTO (nunca a medias). */
export function interpretar(texto: string, archivo: string): Politica {
  const rota = (motivo: string): Politica => ({ estado: "rota", motivo, archivo })
  let j: unknown
  try {
    j = JSON.parse(texto)
  } catch (e) {
    return rota(`JSON inválido (${e instanceof Error ? e.message : String(e)})`.slice(0, 200))
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return rota("la raíz debe ser un objeto")
  const raiz = j as Record<string, unknown>
  for (const k of Object.keys(raiz)) if (k !== "version" && k !== "deny") return rota(`clave desconocida «${k.slice(0, 40)}»`)
  if (raiz.version !== undefined && raiz.version !== 1) return rota("version no soportada (se esperaba 1)")
  const deny: Deny = { providers: [], models: [], mcp: [], tools: [], skills: [], agents: [] }
  if (raiz.deny !== undefined) {
    if (!raiz.deny || typeof raiz.deny !== "object" || Array.isArray(raiz.deny)) return rota("«deny» debe ser un objeto")
    for (const [k, v] of Object.entries(raiz.deny as Record<string, unknown>)) {
      if (!(CLAVES_DENY as readonly string[]).includes(k)) return rota(`«deny.${k.slice(0, 40)}» no existe`)
      if (!Array.isArray(v) || v.length > MAX_PATRONES) return rota(`«deny.${k}» debe ser una lista de hasta ${MAX_PATRONES} patrones`)
      for (const p of v) {
        if (typeof p !== "string" || !p.trim() || p.length > MAX_LARGO) return rota(`«deny.${k}» tiene un patrón inválido`)
      }
      deny[k as Clave] = (v as string[]).map((p) => p.trim().toLowerCase())
    }
  }
  return { estado: "ok", deny, archivo }
}

/** Lee la política del entorno. Ausente = ninguna; todo lo demás que falle = rota. */
export function leer(env: Record<string, string | undefined> = process.env): Politica {
  const archivo = env.LAZUNOX_POLICY_FILE
  // Interruptor de emergencia (solo lo puede poner quien lanza el motor, es decir, la app; un repositorio no toca el entorno del proceso).
  if (env.LAZUNOX_POLITICAS === "0") return { estado: "ninguna" }
  if (archivo === undefined || archivo === "") return { estado: "ninguna" }
  if (!path.isAbsolute(archivo)) return { estado: "rota", motivo: "LAZUNOX_POLICY_FILE debe ser una ruta absoluta", archivo }
  let st: fs.Stats
  try {
    st = fs.statSync(archivo)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") return { estado: "ninguna" }
    return { estado: "rota", motivo: `no se pudo leer (${(e as NodeJS.ErrnoException).code ?? "error"})`, archivo }
  }
  if (!st.isFile()) return { estado: "rota", motivo: "no es un archivo", archivo }
  if (st.size > MAX_ARCHIVO) return { estado: "rota", motivo: `pasa de ${MAX_ARCHIVO / 1024} KB`, archivo }
  try {
    return interpretar(fs.readFileSync(archivo, "utf-8"), archivo)
  } catch (e) {
    return { estado: "rota", motivo: `no se pudo leer (${(e as NodeJS.ErrnoException).code ?? "error"})`, archivo }
  }
}

// Caché por (archivo, fecha, tamaño) con una vigencia corta: la app puede cambiar la política con el motor en marcha y se nota en segundos.
let cache: { clave: string; hasta: number; politica: Politica } | undefined
const VIGENCIA_MS = 1000

export function actual(env: Record<string, string | undefined> = process.env): Politica {
  const archivo = `${env.LAZUNOX_POLICY_FILE ?? ""}|${env.LAZUNOX_POLITICAS ?? ""}`
  const ahora = Date.now()
  if (cache && cache.clave === archivo && cache.hasta > ahora) return cache.politica
  const politica = leer(env)
  cache = { clave: archivo, hasta: ahora + VIGENCIA_MS, politica }
  return politica
}

/** Solo para pruebas. */
export function olvidar() {
  cache = undefined
}

function coincide(nombre: string, patrones: string[]) {
  const n = nombre.toLowerCase()
  return patrones.some((p) => Wildcard.match(n, p))
}

function denegado(clave: Clave, nombres: string[]): boolean {
  const p = actual()
  if (p.estado === "ninguna") return false
  if (p.estado === "rota") return true
  return nombres.some((n) => coincide(n, p.deny[clave]))
}

/** Nombre tal como lo escriben las herramientas MCP (`server_tool`): todo lo que no es alfanumérico, `_` o `-` pasa a `_`. */
const saneado = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_")

export const hayPolitica = () => actual().estado !== "ninguna"
export const proveedorDenegado = (id: string) => denegado("providers", [id])
export const modeloDenegado = (proveedor: string, modelo: string) => denegado("models", [`${proveedor}/${modelo}`])
export const mcpDenegado = (nombre: string) => denegado("mcp", [nombre, saneado(nombre)])
export const herramientaDenegada = (id: string) => denegado("tools", [id])
export const habilidadDenegada = (nombre: string) => denegado("skills", [nombre])
export const agenteDenegado = (nombre: string) => denegado("agents", [nombre])

/** Texto para mensajes de error y registros; nunca incluye el contenido del archivo. */
export function descripcion(): string {
  const p = actual()
  if (p.estado === "rota") return `La política de la organización (${path.basename(p.archivo)}) no se pudo aplicar: ${p.motivo}. Por seguridad se deniega todo hasta que se corrija.`
  return "Bloqueado por la política de la organización."
}

export * as Politica from "./politica"
