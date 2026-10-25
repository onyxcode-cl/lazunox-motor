export * as ConfigAgent from "./agent"

import path from "path"
import { Exit, Schema } from "effect"
import { Glob } from "@opencode-ai/core/util/glob"
import { ConfigAgentV1 } from "@opencode-ai/core/v1/config/agent"
import { configEntryNameFromPath } from "./entry-name"
import * as ConfigMarkdown from "./markdown"
import { ConfigParse } from "./parse"
import { esNombreReservado, pareceClaude, traducirClaude } from "./agent-claude"
export { esNombreReservado }

export async function load(dir: string) {
  const result: Record<string, ConfigAgentV1.Info> = {}
  for (const item of await Glob.scan("{agent,agents}/**/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    const md = await ConfigMarkdown.parse(item).catch(() => undefined)
    if (!md) continue

    const name = configEntryNameFromPath(path.relative(dir, item), ["agent/", "agents/"])

    // Un .md de Claude Code copiado aquí (tools como cadena, disallowedTools, maxTurns...) también funciona.
    const data = md.data as Record<string, unknown>
    const config = {
      name,
      ...(pareceClaude(data) ? traducirClaude(data, { soloClaude: false }) : data),
      prompt: md.content.trim(),
    }
    result[config.name] = ConfigParse.schema(ConfigAgentV1.Info, config, item)
  }
  return result
}

/**
 * Lazunox (2A): agentes de Claude Code en `<raíz>/.claude/agents/**.md` (proyecto o `~/.claude`).
 * Solo subagentes; los permisos se traducen desde `tools`/`disallowedTools` y NUNCA pueden ampliar los del padre
 * (ver `agent/restringir-permisos.ts`). No pisan a los agentes nativos. Un archivo roto se omite sin romper la configuración.
 * `LAZUNOX_SIN_AGENTES_CLAUDE=1` lo apaga.
 */
export async function loadClaude(root: string, env: NodeJS.ProcessEnv = process.env) {
  const result: Record<string, ConfigAgentV1.Info> = {}
  if (env.LAZUNOX_SIN_AGENTES_CLAUDE === "1") return result
  const cwd = path.join(root, ".claude", "agents")
  for (const item of await Glob.scan("**/*.md", { cwd, absolute: true, dot: false, symlink: false }).catch(() => [])) {
    const md = await ConfigMarkdown.parse(item).catch(() => undefined)
    if (!md) continue
    const data = md.data as Record<string, unknown>
    const name = typeof data.name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(data.name)
      ? data.name
      : configEntryNameFromPath(path.relative(cwd, item), [])
    if (esNombreReservado(name)) continue
    try {
      result[name] = ConfigParse.schema(
        ConfigAgentV1.Info,
        { ...traducirClaude(data, { soloClaude: true }), name, prompt: md.content.trim() },
        item,
      )
    } catch {
      continue
    }
  }
  return result
}

export async function loadMode(dir: string) {
  const result: Record<string, ConfigAgentV1.Info> = {}
  for (const item of await Glob.scan("{mode,modes}/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    const md = await ConfigMarkdown.parse(item).catch(() => undefined)
    if (!md) continue

    const config = {
      name: configEntryNameFromPath(path.relative(dir, item), ["mode/", "modes/"]),
      ...md.data,
      prompt: md.content.trim(),
    }
    const parsed = Schema.decodeUnknownExit(ConfigAgentV1.Info)(config, { errors: "all", propertyOrder: "original" })
    if (Exit.isSuccess(parsed)) {
      result[config.name] = {
        ...parsed.value,
        mode: "primary" as const,
      }
    }
  }
  return result
}
