import { permisoDeHerramienta } from "@opencode-ai/core/v1/config/agent"

/**
 * Lazunox (2A, P06): traduce el frontmatter de un agente de Claude Code (`.claude/agents/*.md`) al formato de Lazunox.
 *
 *  - `tools: Read, Grep` (cadena o lista) -> lista blanca: `permission: {"*": "deny", read: "allow", grep: "allow"}`.
 *    Sin `tools` hereda todo (como en Claude). Los nombres de MCP (`mcp__servidor__herramienta`) pasan a `servidor_herramienta`.
 *  - `disallowedTools` -> `disallowed_tools` (va primero y gana siempre).
 *  - `maxTurns` -> `max_turns`.
 *  - `model`: `inherit` y los alias de Claude `sonnet`/`opus` -> hereda el modelo del padre (no se asume una cuenta de Anthropic);
 *    `haiku` -> `small` (el modelo pequeño del mismo proveedor que el padre); `proveedor/modelo` se respeta; un ID suelto
 *    (`claude-3-5-sonnet-...`) se ignora y hereda.
 *  - `skills` y `background` pasan tal cual; `omitClaudeMd: true` pasa a `contexto: "minimo"`.
 *  - Se IGNORAN siempre `permissionMode`, `hooks`, `mcpServers`, `memory`, `permission` y cualquier clave desconocida: un archivo
 *    de la carpeta no puede cambiar el modo de permisos ni añadir servidores ni ejecutar comandos propios.
 *  - `color` solo si es un color válido (hex o de tema); los nombres de Claude (`blue`) se descartan.
 */

export const NOMBRE_VALIDO = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Nombres de agentes nativos: un archivo de `.claude/agents` no puede sustituirlos. */
export const NOMBRES_RESERVADOS = new Set([
  "build", "plan", "general", "explore", "compaction", "title", "summary",
  // agentes primarios y ayudantes de la app (Lazunox): un archivo de la carpeta no puede ocupar ni ampliar estos nombres
  "chat", "tasks", "computer", "lazunox-helper", "lazunox-chat-helper",
  // agentes nativos de solo lectura de Lazunox (3C)
  "verificador", "revisor",
])
export const esNombreReservado = (name: string) => NOMBRES_RESERVADOS.has(name.trim().toLowerCase())

function lista(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : []
  return items.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean)
}

/** `mcp__servidor__herramienta` -> `servidor_herramienta`; `mcp__servidor` o `mcp__servidor__*` -> `servidor_*`. */
export function permisoDeNombreClaude(name: string): string {
  const mcp = /^mcp__([^_].*?)(?:__(.+))?$/.exec(name.trim())
  if (mcp) {
    const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_")
    const tool = mcp[2]
    return !tool || tool === "*" ? `${clean(mcp[1])}_*` : `${clean(mcp[1])}_${clean(tool)}`
  }
  return permisoDeHerramienta(name)
}

export function traducirModelo(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const model = value.trim()
  if (!model) return undefined
  const lower = model.toLowerCase()
  if (lower === "inherit" || lower === "sonnet" || lower === "opus") return "inherit"
  if (lower === "haiku" || lower === "small") return "small"
  if (model.includes("/")) return model
  return "inherit"
}

export function pareceClaude(data: Record<string, unknown>): boolean {
  return (
    typeof data.tools === "string" ||
    Array.isArray(data.tools) ||
    "disallowedTools" in data ||
    "maxTurns" in data ||
    "permissionMode" in data
  )
}

const COLOR = /^(#[0-9a-fA-F]{6}|primary|secondary|accent|success|warning|error|info)$/

export function traducirClaude(data: Record<string, unknown>, opts: { soloClaude: boolean }): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (typeof data.description === "string") out.description = data.description
  if (typeof data.color === "string" && COLOR.test(data.color)) out.color = data.color
  if (typeof data.hidden === "boolean") out.hidden = data.hidden

  const tools = Array.isArray(data.tools) || typeof data.tools === "string" ? lista(data.tools) : undefined
  if (tools && tools.length) {
    const permission: Record<string, string> = { "*": "deny" }
    for (const tool of tools) permission[permisoDeNombreClaude(tool)] = "allow"
    out.permission = permission
  } else if (data.tools && typeof data.tools === "object" && !Array.isArray(data.tools) && !opts.soloClaude) {
    // Formato propio de Lazunox/OpenCode (mapa herramienta -> booleano): se deja pasar.
    out.tools = data.tools
  }

  const disallowed = lista(data.disallowedTools ?? data.disallowed_tools)
  if (disallowed.length) out.disallowed_tools = disallowed.map(permisoDeNombreClaude)

  const turns = Number(data.maxTurns ?? data.max_turns)
  if (Number.isInteger(turns) && turns > 0) out.max_turns = turns

  const model = traducirModelo(data.model)
  if (model) out.model = model

  const skills = lista(data.skills)
  if (skills.length) out.skills = skills
  if (typeof data.background === "boolean") out.background = data.background
  // Lazunox (6.3): `omitClaudeMd: true` de Claude Code equivale a contexto mínimo (solo surte efecto con la bandera y sin permiso de editar).
  if (data.omitClaudeMd === true) out.contexto = "minimo"

  out.mode = "subagent"
  return out
}

/** Cada tramo de un nombre derivado de la ruta (`sub/agente`) debe ser ASCII válido: rechaza homógrafos (una «а» cirílica) y similares. */
export const nombreDeRutaValido = (name: string) => name.split("/").every((tramo) => NOMBRE_VALIDO.test(tramo))

const RIGOR: Record<string, number> = { deny: 0, ask: 1, allow: 2 }

/**
 * Lazunox (revisión de seguridad H3, variante): el agente de `.claude/agents` (`def`) y uno que la persona ya ajustó en
 * `opencode.json` / `.opencode/agents` (`existente`, manda en todo) se fusionan SIN que el resultado amplíe permisos respecto de `def`:
 *  - con lista blanca de herramientas en `def` (`"*": deny`) se conserva: lo que `existente` añada fuera de la lista no entra;
 *  - donde ambos opinan sobre la misma herramienta gana el más estricto (deny < ask < allow);
 *  - `disallowed_tools` se unen; `tools` (formato antiguo) de `existente` se descarta si hay lista blanca.
 * El resto de campos (modelo, prompt, temperatura…) los decide `existente`. Los nombres reservados NO pasan por aquí.
 */
export function fusionarConClaude(def: Record<string, any>, existente: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...def, ...existente }
  const base = def.permission && typeof def.permission === "object" ? (def.permission as Record<string, any>) : undefined
  const propio = existente.permission && typeof existente.permission === "object" ? (existente.permission as Record<string, any>) : {}
  const listaBlanca = base?.["*"] === "deny"
  if (base) {
    const permission: Record<string, any> = { ...base }
    for (const [key, valor] of Object.entries(propio)) {
      if (!(key in base)) {
        if (!listaBlanca) permission[key] = valor
        continue
      }
      const a = base[key]
      // Solo se estrecha cuando ambos son acciones simples; con patrones por medio manda la base de Claude.
      if (typeof a === "string" && typeof valor === "string" && (RIGOR[valor] ?? 2) < (RIGOR[a] ?? 2)) permission[key] = valor
    }
    out.permission = permission
  }
  if (listaBlanca) delete out.tools
  const prohibidas = [...(def.disallowed_tools ?? []), ...(existente.disallowed_tools ?? [])]
  if (prohibidas.length) out.disallowed_tools = Array.from(new Set(prohibidas))
  return out
}
