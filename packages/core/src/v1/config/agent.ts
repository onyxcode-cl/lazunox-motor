export * as ConfigAgentV1 from "./agent"

import { Schema, SchemaGetter } from "effect"
import { PositiveInt } from "../../schema"
import { ConfigPermissionV1 } from "./permission"

const Color = Schema.Union([
  Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)),
  Schema.Literals(["primary", "secondary", "accent", "success", "warning", "error", "info"]),
])

const AgentSchema = Schema.StructWithRest(
  Schema.Struct({
    model: Schema.optional(Schema.String).annotate({
      description:
        'Model for this agent: "provider/model", "small" (the small model of the same provider as the parent) or "inherit" (the parent\'s model, default).',
    }),
    variant: Schema.optional(Schema.String).annotate({
      description: "Default model variant for this agent (applies only when using the agent's configured model).",
    }),
    temperature: Schema.optional(Schema.Finite),
    top_p: Schema.optional(Schema.Finite),
    prompt: Schema.optional(Schema.String),
    tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)).annotate({
      description: "@deprecated Use 'permission' field instead",
    }),
    disable: Schema.optional(Schema.Boolean),
    description: Schema.optional(Schema.String).annotate({ description: "Description of when to use the agent" }),
    mode: Schema.optional(Schema.Literals(["subagent", "primary", "all"])),
    hidden: Schema.optional(Schema.Boolean).annotate({
      description: "Hide this subagent from the @ autocomplete menu (default: false, only applies to mode: subagent)",
    }),
    options: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
    color: Schema.optional(Color).annotate({
      description: "Hex color code (e.g., #FF5733) or theme color (e.g., primary)",
    }),
    steps: Schema.optional(PositiveInt).annotate({
      description: "Maximum number of agentic iterations before forcing text-only response",
    }),
    maxSteps: Schema.optional(PositiveInt).annotate({ description: "@deprecated Use 'steps' field instead." }),
    permission: Schema.optional(ConfigPermissionV1.Info),
    disallowed_tools: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
      description: "Tools this agent can never use. Applied last: it wins over 'tools' and 'permission'.",
    }),
    max_turns: Schema.optional(PositiveInt).annotate({
      description: "Maximum agentic turns. When reached, the agent answers with what it has and the result is marked partial.",
    }),
    background: Schema.optional(Schema.Boolean).annotate({
      description: "Run this agent in the background by default when launched as a subagent.",
    }),
    skills: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
      description: "Skills this agent may use (the rest are denied). Absent means the usual skills.",
    }),
  }),
  [Schema.Record(Schema.String, Schema.Any)],
)

const KNOWN_KEYS = new Set([
  "name",
  "model",
  "variant",
  "prompt",
  "description",
  "temperature",
  "top_p",
  "mode",
  "hidden",
  "color",
  "steps",
  "maxSteps",
  "options",
  "permission",
  "disable",
  "tools",
  "disallowed_tools",
  "max_turns",
  "background",
  "skills",
])

/** Nombre de herramienta (opencode o de Claude Code) -> clave de permiso. `write`, `edit` y `patch` comparten `edit`. */
const CLAUDE_A_PERMISO: Record<string, string> = {
  read: "read",
  write: "edit",
  edit: "edit",
  multiedit: "edit",
  notebookedit: "edit",
  patch: "edit",
  apply_patch: "edit",
  bash: "bash",
  glob: "glob",
  grep: "grep",
  ls: "list",
  list: "list",
  webfetch: "webfetch",
  websearch: "websearch",
  todowrite: "todowrite",
  task: "task",
  agent: "task",
  skill: "skill",
  lsp: "lsp",
}
export function permisoDeHerramienta(name: string): string {
  const limpio = name.trim()
  const clave = limpio.replace(/\(.*\)$/, "").toLowerCase()
  return CLAUDE_A_PERMISO[clave] ?? limpio.replace(/\(.*\)$/, "")
}

const normalize = (agent: Schema.Schema.Type<typeof AgentSchema>): Schema.Schema.Type<typeof AgentSchema> => {
  const options: Record<string, unknown> = { ...agent.options }
  for (const [key, value] of Object.entries(agent)) {
    if (!KNOWN_KEYS.has(key)) options[key] = value
  }

  const permission: ConfigPermissionV1.Info = {}
  for (const [tool, enabled] of Object.entries(agent.tools ?? {})) {
    const action = enabled ? "allow" : "deny"
    if (tool === "write" || tool === "edit" || tool === "patch") {
      permission.edit = action
      continue
    }
    permission[tool] = action
  }
  if (agent.skills) {
    // Lista blanca de skills: el resto, denegado. Un `permission.skill` explícito se aplica después.
    permission.skill = { "*": "deny", ...globalThis.Object.fromEntries(agent.skills.map((name) => [name, "allow"])) }
  }
  globalThis.Object.assign(permission, agent.permission)
  // `disallowed_tools` va al final y por encima de todo: se borra la clave previa para que quede la última.
  for (const tool of agent.disallowed_tools ?? []) {
    const key = permisoDeHerramienta(tool)
    delete permission[key]
    permission[key] = "deny"
  }

  // Con ambos topes manda el más bajo.
  const candidatos = [agent.steps ?? agent.maxSteps, agent.max_turns].filter((n): n is number => n !== undefined)
  const steps = candidatos.length ? Math.min(...candidatos) : undefined
  return { ...agent, options, permission, ...(steps !== undefined ? { steps } : {}) }
}

export const Info = AgentSchema.pipe(
  Schema.decodeTo(AgentSchema, {
    decode: SchemaGetter.transform(normalize),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
).annotate({ identifier: "AgentConfig" })
export type Info = Schema.Schema.Type<typeof Info>
