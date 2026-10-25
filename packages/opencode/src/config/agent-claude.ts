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
 *  - `skills` y `background` pasan tal cual.
 *  - Se IGNORAN siempre `permissionMode`, `hooks`, `mcpServers`, `memory`, `permission` y cualquier clave desconocida: un archivo
 *    de la carpeta no puede cambiar el modo de permisos ni añadir servidores ni ejecutar comandos propios.
 *  - `color` solo si es un color válido (hex o de tema); los nombres de Claude (`blue`) se descartan.
 */

const NOMBRE_VALIDO = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Nombres de agentes nativos: un archivo de `.claude/agents` no puede sustituirlos. */
export const NOMBRES_RESERVADOS = new Set([
  "build", "plan", "general", "explore", "compaction", "title", "summary",
  // agentes primarios y ayudantes de la app (Lazunox): un archivo de la carpeta no puede ocupar ni ampliar estos nombres
  "chat", "tasks", "computer", "lazunox-helper", "lazunox-chat-helper",
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

  out.mode = "subagent"
  return out
}
