// Lazunox: búsqueda diferida de herramientas MCP (`tool_search` + `mcp_call`).
//
// Cuando los conectores MCP aportan muchas definiciones (descripción + esquema), mandarlas todas en cada petición
// gasta miles de tokens y no deja usar bien el caché del prompt. Con la búsqueda diferida salen de la lista y entran
// DOS herramientas fijas: `tool_search` (devuelve nombre, descripción y esquema de las coincidencias, como resultado
// de herramienta, es decir dentro de los mensajes) y `mcp_call` (ejecuta por el mismo camino que la llamada directa,
// `mcp/invocar.ts`). La lista de herramientas no cambia entre pasos, así que el caché se conserva.
//
// Este archivo es PURO (sin Effect ni permisos): configuración, decisión de umbral, índice, búsqueda y validación.
// El cableado (permisos, ganchos, ejecución) vive en `session/tools.ts`.
//
// La puntuación léxica está copiada de `packages/codemode/src/tool-runtime.ts` (`tokenize`, `termForms`,
// `makeSearchTool`, MIT, mismo repositorio) con los mismos pesos: ruta exacta o segmento 20 > subcadena de ruta 8 >
// descripción 4 > cualquier texto (parámetros) 2.
import type { Tool as MCPToolDef } from "@modelcontextprotocol/sdk/types.js"

export const TOOL_SEARCH = "tool_search"
export const MCP_CALL = "mcp_call"
/** Nombres que el motor reserva; los usa `Permission.disabled` para no ocultarlos por un `*: deny` genérico. */
export const DEFERRED_TOOL_NAMES: readonly string[] = [TOOL_SEARCH, MCP_CALL]

export const DEFAULT_MIN_TOKENS = 4000
export const DEFAULT_LIMIT = 5
export const MAX_LIMIT = 10
export const MAX_RESULT_BYTES = 16 * 1024
const MAX_INDEX_CHARS = 6000

export type Mode = "auto" | "on" | "off"

export interface Config {
  readonly mode: Mode
  readonly minTokens: number
  /** Servidores (saneados, en minúsculas) cuyas herramientas nunca se difieren. */
  readonly keep: ReadonlySet<string>
}

const sanear = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase()

export function config(env: Record<string, string | undefined> = process.env): Config {
  // Variable ausente o desconocida = off: la app pide `auto` explícitamente solo en Chat y Code.
  const raw = (env.LAZUNOX_TOOL_SEARCH ?? "off").trim().toLowerCase()
  const mode: Mode = raw === "on" || raw === "auto" ? raw : "off"
  const min = Number.parseInt(env.LAZUNOX_TOOL_SEARCH_MIN_TOKENS ?? "", 10)
  const keep = (env.LAZUNOX_TOOL_SEARCH_KEEP ?? "")
    .split(",")
    .map((item) => sanear(item.trim()))
    .filter((item) => item.length > 0)
  return {
    mode,
    minTokens: Number.isFinite(min) && min >= 0 ? min : DEFAULT_MIN_TOKENS,
    keep: new Set(keep),
  }
}

/** Una herramienta MCP con su servidor ya resuelto. `def` es la definición nativa del servidor. */
export interface Entry<T = unknown> {
  readonly key: string
  readonly server: string
  readonly def: Pick<MCPToolDef, "name" | "description" | "inputSchema">
  readonly source: T
}

/** Tokens aproximados (caracteres/4) de lo que costaría mandar la herramienta suelta. */
export function estimateTokens(def: Entry["def"], key: string): number {
  return Math.ceil(
    JSON.stringify({ name: key, description: def.description ?? "", inputSchema: def.inputSchema }).length / 4,
  )
}

export interface Decision<T> {
  readonly deferred: Entry<T>[]
  readonly direct: Entry<T>[]
}

/**
 * Decide qué herramientas se difieren. `visible` = las que el agente/sesión/mensaje dejan ver; las ocultas siguen el
 * camino directo de siempre (el filtro de `llm/request.ts` las quita). Determinista: mismo catálogo → mismo resultado.
 */
export function decide<T>(entries: Entry<T>[], visible: ReadonlySet<string>, cfg: Config, codeMode: boolean): Decision<T> {
  const none = { deferred: [], direct: entries }
  if (codeMode || cfg.mode === "off") return none
  const candidates = entries.filter((entry) => visible.has(entry.key) && !cfg.keep.has(sanear(entry.server)))
  if (candidates.length === 0) return none
  if (cfg.mode === "auto") {
    const total = candidates.reduce((sum, entry) => sum + estimateTokens(entry.def, entry.key), 0)
    if (total < cfg.minTokens) return none
  }
  const chosen = new Set(candidates.map((entry) => entry.key))
  return { deferred: candidates, direct: entries.filter((entry) => !chosen.has(entry.key)) }
}

const byKey = (a: { key: string }, b: { key: string }) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)

/** Índice compacto y estable: `servidor (N): nombre1, nombre2…`, servidores y nombres ordenados. */
export function buildIndex(entries: Entry[]): string {
  const servers = new Map<string, string[]>()
  for (const entry of entries.toSorted(byKey)) {
    const list = servers.get(entry.server) ?? []
    list.push(entry.key)
    servers.set(entry.server, list)
  }
  const lines = [...servers.entries()]
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([server, keys]) => `${server} (${keys.length}): ${keys.join(", ")}`)
  const text = lines.join("\n")
  if (text.length <= MAX_INDEX_CHARS) return text
  const cut = text.slice(0, MAX_INDEX_CHARS)
  return `${cut.slice(0, cut.lastIndexOf(","))}, … (índice recortado: busca por texto)`
}

export function describeSearch(entries: Entry[]): string {
  return [
    "Busca herramientas de conectores MCP cuya definición completa NO está cargada. Devuelve nombre, descripción y esquema JSON de cada coincidencia; después llámalas con `mcp_call`.",
    "Consulta: texto libre (p. ej. `crear ticket`) o `select:nombre1,nombre2` con nombres exactos. `limit` 1-10 (por defecto 5).",
    "Herramientas disponibles (`servidor (cantidad): nombres`):",
    buildIndex(entries),
  ].join("\n")
}

export const describeCall = () =>
  "Ejecuta una herramienta de conector MCP del índice de `tool_search`. `tool` es el nombre exacto (sensible a mayúsculas) y `arguments` un objeto con los argumentos según el esquema que devolvió `tool_search`. Pide los mismos permisos que la llamada directa. Si no conoces el esquema, usa antes `tool_search`."

const tokenize = (query: string): string[] =>
  query
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 0 && term !== "*")

const termForms = (term: string): string[] => {
  const forms = [term]
  if (term.endsWith("es") && term.length > 3) forms.push(term.slice(0, -2))
  if (term.endsWith("s") && term.length > 2) forms.push(term.slice(0, -1))
  return forms
}

function searchText(entry: Entry): string {
  const schema = entry.def.inputSchema as { properties?: Record<string, { description?: unknown }> } | undefined
  const props = Object.entries(schema?.properties ?? {}).map(
    ([name, value]) => `${name} ${typeof value?.description === "string" ? value.description : ""}`,
  )
  return [entry.key, entry.def.description ?? "", ...props].join(" ").toLowerCase()
}

export interface SearchResult {
  /** Coincidencias en orden de relevancia (ya recortadas por `limit`). */
  readonly matches: Entry[]
  /** Solo con `select:`: nombres pedidos que no existen (con sugerencias). */
  readonly missing: { name: string; suggestions: string[] }[]
  readonly total: number
}

export function clampLimit(limit: unknown): number {
  const n = typeof limit === "number" && Number.isFinite(limit) ? Math.trunc(limit) : DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.max(1, n))
}

/** Parte de `rank` que sirve también para sugerir nombres parecidos. */
function rank(entries: Entry[], query: string): Entry[] {
  const terms = tokenize(query).map(termForms)
  return entries
    .map((entry) => {
      const path = entry.key.toLowerCase()
      const description = (entry.def.description ?? "").toLowerCase()
      const text = searchText(entry)
      const score = terms.reduce(
        (total, forms) =>
          total +
          (forms.some((form) => path === form || path.endsWith(`_${form}`) || path.endsWith(`.${form}`)) ? 20 : 0) +
          (forms.some((form) => path.includes(form)) ? 8 : 0) +
          (forms.some((form) => description.includes(form)) ? 4 : 0) +
          (forms.some((form) => text.includes(form)) ? 2 : 0),
        0,
      )
      return { entry, score }
    })
    .filter(({ score }) => terms.length === 0 || score > 0)
    .toSorted((a, b) => b.score - a.score || byKey(a.entry, b.entry))
    .map(({ entry }) => entry)
}

export function suggest(entries: Entry[], name: string, max = 3): string[] {
  return rank(entries, name)
    .slice(0, max)
    .map((entry) => entry.key)
}

export function search(entries: Entry[], query: string, limit?: unknown): SearchResult {
  const max = clampLimit(limit)
  const trimmed = query.trim()
  if (trimmed.toLowerCase().startsWith("select:")) {
    const names = trimmed
      .slice("select:".length)
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
    const index = new Map(entries.map((entry) => [entry.key, entry]))
    const seen = new Set<string>()
    const matches: Entry[] = []
    const missing: SearchResult["missing"] = []
    for (const name of names) {
      const entry = index.get(name)
      if (entry) {
        if (!seen.has(name)) matches.push(entry)
        seen.add(name)
      } else missing.push({ name, suggestions: suggest(entries, name) })
    }
    return { matches: matches.slice(0, max), missing, total: matches.length }
  }
  const exact = entries.find((entry) => entry.key === trimmed)
  const ranked = exact ? [exact] : rank(entries, trimmed)
  return { matches: ranked.slice(0, max), missing: [], total: ranked.length }
}

/** Texto del resultado de `tool_search`: tope de `MAX_RESULT_BYTES`; si no cabe, se omiten las últimas. */
export function formatResult(result: SearchResult, query: string): string {
  const blocks: string[] = []
  let used = 0
  let omitted = 0
  for (const entry of result.matches) {
    const block = [
      `## ${entry.key}  (servidor: ${entry.server})`,
      entry.def.description?.trim() || "(sin descripción)",
      "Esquema de `arguments`:",
      JSON.stringify(entry.def.inputSchema),
    ].join("\n")
    const size = Buffer.byteLength(block) + 2
    if (used + size > MAX_RESULT_BYTES && blocks.length > 0) {
      omitted++
      continue
    }
    if (used + size > MAX_RESULT_BYTES) {
      blocks.push(block.slice(0, MAX_RESULT_BYTES - 200) + "\n[recortado]")
      used = MAX_RESULT_BYTES
      continue
    }
    blocks.push(block)
    used += size
  }
  const notes: string[] = []
  if (omitted > 0) notes.push(`Se omitieron ${omitted} por tamaño: pídelas con \`select:nombre\`.`)
  if (result.total > result.matches.length)
    notes.push(`${result.total - result.matches.length} coincidencia(s) más: afina la consulta o sube \`limit\`.`)
  for (const miss of result.missing)
    notes.push(
      `No existe \`${miss.name}\`.${miss.suggestions.length ? ` ¿Quisiste decir: ${miss.suggestions.join(", ")}?` : ""}`,
    )
  if (blocks.length === 0) {
    return [`Sin coincidencias para \`${query}\`.`, ...notes, "Prueba otras palabras o `select:` con un nombre del índice."].join(
      "\n",
    )
  }
  return [...blocks, ...notes, "Usa `mcp_call { tool, arguments }` con el nombre exacto."].join("\n\n")
}

/** Comprobación mínima antes de llamar: `required` y tipos de primer nivel. El servidor sigue validando. */
export function validateArguments(def: Entry["def"], args: Record<string, unknown>): string | undefined {
  const schema = def.inputSchema as { required?: unknown; properties?: Record<string, { type?: unknown }> } | undefined
  const required = Array.isArray(schema?.required) ? schema.required.filter((x): x is string => typeof x === "string") : []
  const faltan = required.filter((name) => args[name] === undefined)
  if (faltan.length > 0) return `Faltan argumentos obligatorios: ${faltan.join(", ")}.`
  const mal: string[] = []
  for (const [name, spec] of Object.entries(schema?.properties ?? {})) {
    const value = args[name]
    if (value === undefined || value === null) continue
    const types = Array.isArray(spec?.type) ? spec.type : spec?.type === undefined ? [] : [spec.type]
    if (types.length === 0) continue
    const ok = types.some((type) => {
      if (type === "string") return typeof value === "string"
      if (type === "number") return typeof value === "number"
      if (type === "integer") return typeof value === "number" && Number.isInteger(value)
      if (type === "boolean") return typeof value === "boolean"
      if (type === "array") return Array.isArray(value)
      if (type === "object") return typeof value === "object" && !Array.isArray(value)
      if (type === "null") return value === null
      return true
    })
    if (!ok) mal.push(`${name} debe ser ${types.join("|")}`)
  }
  return mal.length > 0 ? `Argumentos con tipo incorrecto: ${mal.join("; ")}.` : undefined
}

/**
 * Reparación de llamada: el modelo llamó directo a una herramienta que no está en la lista (típico tras leer su
 * esquema con `tool_search`). Si `mcp_call` está disponible y la entrada es un objeto JSON, se reescribe a
 * `mcp_call { tool, arguments }`; `mcp_call` vuelve a comprobar catálogo y permisos, así que no abre nada nuevo.
 */
export function rewriteDirectCall(
  toolName: string,
  rawInput: string,
  available: (name: string) => boolean,
): { toolName: string; input: string } | undefined {
  if (!available(MCP_CALL) || available(toolName)) return undefined
  let parsed: unknown
  try {
    parsed = rawInput ? JSON.parse(rawInput) : {}
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  return { toolName: MCP_CALL, input: JSON.stringify({ tool: toolName, arguments: parsed }) }
}

export * as ToolSearch from "./tool-search"
