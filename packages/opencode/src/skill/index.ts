import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { Effect, Layer, Context, Schema } from "effect"
import { NamedError } from "@opencode-ai/core/util/error"
import type { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { Global } from "@opencode-ai/core/global"
import { SkillPlugin } from "@opencode-ai/core/plugin/skill"
import { Permission } from "@/permission"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Config } from "@/config/config"
import { FrontmatterError } from "@opencode-ai/core/v1/config/error"
import { ConfigMarkdown } from "@/config/markdown"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Glob } from "@opencode-ai/core/util/glob"
import { Discovery } from "./discovery"
import { isRecord } from "@/util/record"
import { escapeHtml } from "@/util/html"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import {
  ajustarAlPresupuesto,
  archivosDeHerramienta,
  coincideRuta,
  descripcionAcotada,
  LISTA_PRESUPUESTO_BYTES,
  leerMeta,
  META_VACIA,
  relativaDentroDelProyecto,
  type SkillMeta,
} from "./frontmatter"

const CLAUDE_EXTERNAL_DIR = ".claude"
const AGENTS_EXTERNAL_DIR = ".agents"
const EXTERNAL_SKILL_PATTERN = "skills/**/SKILL.md"
const OPENCODE_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"
const SKILL_PATTERN = "**/SKILL.md"

// Built-in skill that ships with opencode. The model's intuition for what an
// opencode.json should look like is often wrong, and opencode hard-fails on
// invalid config, so users hit cryptic startup errors. Loading this skill
// when the model is asked to touch opencode's own config files gives it the
// actual schemas instead of guesses.
const CUSTOMIZE_OPENCODE_SKILL_NAME = "customize-opencode"
const CUSTOMIZE_OPENCODE_SKILL_DESCRIPTION =
  "Use ONLY when the user is editing or creating opencode's own configuration: opencode.json, opencode.jsonc, files under .opencode/, or files under ~/.config/opencode/. Also use when creating or fixing opencode agents, subagents, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring opencode itself."
const CUSTOMIZE_OPENCODE_SKILL_BODY = SkillPlugin.CustomizeOpencodeContent

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  location: Schema.String,
  content: Schema.String,
})
export type Info = Schema.Schema.Type<typeof Info>

const Issue = Schema.StructWithRest(
  Schema.Struct({
    message: Schema.String,
    path: Schema.Array(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)

function isSkillFrontmatter(data: unknown): data is { name: string; description?: string } {
  return (
    isRecord(data) &&
    typeof data.name === "string" &&
    (data.description === undefined || typeof data.description === "string")
  )
}

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("SkillInvalidError", {
  path: Schema.String,
  message: Schema.optional(Schema.String),
  issues: Schema.optional(Schema.Array(Issue)),
}) {}

export class NameMismatchError extends Schema.TaggedErrorClass<NameMismatchError>()("SkillNameMismatchError", {
  path: Schema.String,
  expected: Schema.String,
  actual: Schema.String,
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Skill.NotFoundError", {
  name: Schema.String,
  available: Schema.Array(Schema.String),
}) {
  override get message() {
    return `Skill "${this.name}" not found. Available skills: ${this.available.join(", ") || "none"}`
  }
}

type State = {
  skills: Record<string, Info>
  /** Lazunox (4A): frontmatter ampliado de cada skill (aparte de `Info`, que sale por la API HTTP). */
  meta: Record<string, SkillMeta>
  /** Lazunox (4A): skills con `paths` que ya se activaron al tocar un archivo que coincide. */
  activas: Set<string>
  dirs: Set<string>
}

type DiscoveryState = {
  matches: string[]
  dirs: string[]
}

type ScanState = {
  matches: Set<string>
  dirs: Set<string>
}

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly require: (name: string) => Effect.Effect<Info, NotFoundError>
  readonly all: () => Effect.Effect<Info[]>
  readonly dirs: () => Effect.Effect<string[]>
  /** `paraModelo: true` = lo que se ofrece al modelo: sin `disable-model-invocation` y sin las de `paths` aún sin activar. */
  readonly available: (agent?: Agent.Info, opts?: { paraModelo?: boolean }) => Effect.Effect<Info[]>
  /** Lazunox (4A): frontmatter ampliado. */
  readonly meta: (name: string) => Effect.Effect<SkillMeta>
  /** Lazunox (4A): ¿puede el modelo cargar esta skill ahora? (`disable-model-invocation` y `paths` sin activar lo impiden). */
  readonly invocable: (name: string) => Effect.Effect<{ ok: true } | { ok: false; motivo: string }>
  /** Lazunox (4A): un archivo del proyecto fue tocado: activa las skills con `paths` que lo cubren. Devuelve las nuevas. */
  readonly tocar: (archivo: string) => Effect.Effect<string[]>
}

const add = Effect.fnUntraced(function* (state: State, match: string, events: EventV2Bridge.Service["Service"]) {
  const md = yield* Effect.tryPromise({
    try: () => ConfigMarkdown.parse(match),
    catch: (err) => err,
  }).pipe(
    Effect.catch(
      Effect.fnUntraced(function* (err) {
        const message = FrontmatterError.isInstance(err) ? err.data.message : `Failed to parse skill ${match}`
        const { Session } = yield* Effect.promise(() => import("@/session/session"))
        yield* events.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        yield* Effect.logError("failed to load skill", { skill: match, error: err })
        return undefined
      }),
    ),
  )

  if (!md) return

  if (!isSkillFrontmatter(md.data)) return

  if (state.skills[md.data.name]) {
    yield* Effect.logWarning("duplicate skill name", {
      name: md.data.name,
      existing: state.skills[md.data.name].location,
      duplicate: match,
    })
  }

  state.dirs.add(path.dirname(match))
  state.skills[md.data.name] = {
    name: md.data.name,
    description: md.data.description,
    location: match,
    content: md.content,
  }
  const meta = leerMeta(md.data)
  state.meta[md.data.name] = meta
  for (const aviso of meta.avisos) yield* Effect.logWarning("skill: frontmatter ignorado", { skill: md.data.name, aviso })
})

/**
 * Lazunox (4A): un archivo fue tocado. Activa las skills con `paths` que lo cubren. El archivo se resuelve con realpath y debe
 * quedar DENTRO del proyecto (un enlace simbólico hacia fuera, o `../`, no activa nada).
 */
function activarPorArchivo(s: State, archivo: string, directory: string, worktree: string): string[] {
  const conPaths = Object.entries(s.meta).filter(([name, m]) => m.paths.length > 0 && !s.activas.has(name) && s.skills[name])
  if (conPaths.length === 0) return []
  const raiz = worktree && worktree !== "/" ? worktree : directory
  const rel = relativaDentroDelProyecto(archivo, raiz, directory)
  if (!rel) return []
  const nuevas: string[] = []
  for (const [name, m] of conPaths) {
    if (!coincideRuta(rel, m.paths)) continue
    s.activas.add(name)
    nuevas.push(name)
  }
  return nuevas
}

const scan = Effect.fnUntraced(function* (
  state: ScanState,
  root: string,
  pattern: string,
  opts?: { dot?: boolean; scope?: string },
) {
  const matches = yield* Effect.tryPromise({
    try: () =>
      Glob.scan(pattern, {
        cwd: root,
        absolute: true,
        include: "file",
        symlink: true,
        dot: opts?.dot,
      }),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) => {
      if (!opts?.scope) return Effect.die(error)
      return Effect.logError(`failed to scan ${opts.scope} skills`, { dir: root, error: error }).pipe(
        Effect.as([] as string[]),
      )
    }),
  )

  for (const match of matches) {
    state.matches.add(match)
    state.dirs.add(path.dirname(match))
  }
})

const discoverSkills = Effect.fnUntraced(function* (
  config: Config.Interface,
  discovery: Discovery.Interface,
  fsys: FSUtil.Interface,
  global: Global.Interface,
  disableExternalSkills: boolean,
  disableClaudeCodeSkills: boolean,
  directory: string,
  worktree: string,
) {
  const state: ScanState = { matches: new Set(), dirs: new Set() }

  const externalDirs: string[] = []
  if (!disableExternalSkills) {
    if (!disableClaudeCodeSkills) externalDirs.push(CLAUDE_EXTERNAL_DIR)
    externalDirs.push(AGENTS_EXTERNAL_DIR)

    for (const dir of externalDirs) {
      const root = path.join(global.home, dir)
      if (!(yield* fsys.isDir(root))) continue
      yield* scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "global" })
    }

    const upDirs = yield* fsys
      .up({ targets: externalDirs, start: directory, stop: worktree })
      .pipe(Effect.catch(() => Effect.succeed([] as string[])))

    for (const root of upDirs) {
      yield* scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "project" })
    }
  }

  const configDirs = yield* config.directories()
  for (const dir of configDirs) {
    yield* scan(state, dir, OPENCODE_SKILL_PATTERN)
  }

  const cfg = yield* config.get()
  for (const item of cfg.skills?.paths ?? []) {
    const expanded = item.startsWith("~/") ? path.join(global.home, item.slice(2)) : item
    const dir = path.isAbsolute(expanded) ? expanded : path.join(directory, expanded)
    if (!(yield* fsys.isDir(dir))) {
      yield* Effect.logWarning("skill path not found", { path: dir })
      continue
    }

    yield* scan(state, dir, SKILL_PATTERN)
  }

  for (const url of cfg.skills?.urls ?? []) {
    const pulledDirs = yield* discovery.pull(url)
    for (const dir of pulledDirs) {
      yield* scan(state, dir, SKILL_PATTERN)
    }
  }

  return {
    matches: Array.from(state.matches),
    dirs: Array.from(state.dirs),
  }
})

const loadSkills = Effect.fnUntraced(function* (
  state: State,
  discovered: DiscoveryState,
  events: EventV2Bridge.Service["Service"],
) {
  yield* Effect.forEach(discovered.matches, (match) => add(state, match, events), {
    concurrency: "unbounded",
    discard: true,
  })

  yield* Effect.logInfo("init", { count: Object.keys(state.skills).length })
})

export class Service extends Context.Service<Service, Interface>()("@opencode/Skill") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* Discovery.Service
    const config = yield* Config.Service
    const events = yield* EventV2Bridge.Service
    const fsys = yield* FSUtil.Service
    const global = yield* Global.Service
    const flags = yield* RuntimeFlags.Service
    const discovered = yield* InstanceState.make(
      Effect.fn("Skill.discovery")(function* (ctx) {
        return yield* discoverSkills(
          config,
          discovery,
          fsys,
          global,
          flags.disableExternalSkills,
          flags.disableClaudeCodeSkills,
          ctx.directory,
          ctx.worktree,
        )
      }),
    )
    const state = yield* InstanceState.make(
      Effect.fn("Skill.state")(function* (ctx) {
        const s: State = { skills: {}, meta: {}, activas: new Set(), dirs: new Set() }
        // Register the built-in skill BEFORE disk discovery so a user-disk
        // skill with the same name can override it.
        s.skills[CUSTOMIZE_OPENCODE_SKILL_NAME] = {
          name: CUSTOMIZE_OPENCODE_SKILL_NAME,
          description: CUSTOMIZE_OPENCODE_SKILL_DESCRIPTION,
          location: "<built-in>",
          content: CUSTOMIZE_OPENCODE_SKILL_BODY,
        }
        yield* loadSkills(s, yield* InstanceState.get(discovered), events)
        // Lazunox (4A): las skills con `paths` se activan cuando una herramienta de archivos termina sobre un archivo que coincide.
        if (Object.values(s.meta).some((m) => m.paths.length > 0)) {
          const unsubscribe = yield* events.listen((event) => {
            if (event.type !== SessionV1.Event.PartUpdated.type) return Effect.void
            if (event.location?.directory !== ctx.directory) return Effect.void
            return Effect.sync(() => {
              const part = (event.data as { part?: any }).part
              if (!part || part.type !== "tool" || part.state?.status !== "completed") return
              for (const f of archivosDeHerramienta(String(part.tool), part.state.input))
                activarPorArchivo(s, f, ctx.directory, ctx.worktree)
            })
          })
          yield* Effect.addFinalizer(() => unsubscribe)
        }
        return s
      }),
    )

    const get = Effect.fn("Skill.get")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      return s.skills[name]
    })

    const require = Effect.fn("Skill.require")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      const info = s.skills[name]
      if (info) return info
      return yield* new NotFoundError({ name, available: Object.keys(s.skills).toSorted() })
    })

    const all = Effect.fn("Skill.all")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.values(s.skills)
    })

    const dirs = Effect.fn("Skill.dirs")(function* () {
      return (yield* InstanceState.get(discovered)).dirs
    })

    const metaDe = (s: State, name: string) => s.meta[name] ?? META_VACIA
    const invocableEn = (s: State, name: string): { ok: true } | { ok: false; motivo: string } => {
      const m = metaDe(s, name)
      if (m.disableModelInvocation)
        return { ok: false, motivo: `La skill "${name}" tiene disable-model-invocation: solo la persona puede invocarla.` }
      if (m.paths.length > 0 && !s.activas.has(name))
        return { ok: false, motivo: `La skill "${name}" solo se activa al tocar archivos que coincidan con sus paths y todavía no se ha activado.` }
      return { ok: true }
    }

    const available = Effect.fn("Skill.available")(function* (agent?: Agent.Info, opts?: { paraModelo?: boolean }) {
      const s = yield* InstanceState.get(state)
      let list = Object.values(s.skills).toSorted((a, b) => a.name.localeCompare(b.name))
      if (opts?.paraModelo) list = list.filter((skill) => invocableEn(s, skill.name).ok)
      if (!agent) return list
      return list.filter((skill) => Permission.evaluate("skill", skill.name, agent.permission).action !== "deny")
    })

    const meta = Effect.fn("Skill.meta")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      return metaDe(s, name)
    })

    const invocable = Effect.fn("Skill.invocable")(function* (name: string) {
      return invocableEn(yield* InstanceState.get(state), name)
    })

    const tocar = Effect.fn("Skill.tocar")(function* (archivo: string) {
      const s = yield* InstanceState.get(state)
      const ctx = yield* InstanceState.context
      return activarPorArchivo(s, archivo, ctx.directory, ctx.worktree)
    })

    return Service.of({ get, require, all, dirs, available, meta, invocable, tocar })
  }),
)

export function fmt(list: Info[], opts: { verbose: boolean; presupuesto?: number }) {
  const described = list.filter((skill) => skill.description !== undefined)
  if (described.length === 0) return "No skills are currently available."
  const presupuesto = opts.presupuesto ?? LISTA_PRESUPUESTO_BYTES
  const orden = described.toSorted((a, b) => a.name.localeCompare(b.name))
  // Lazunox (4A): descripciones de una línea y de máx. 300 caracteres, y la lista entera dentro de un presupuesto de bytes.
  const nota = (n: number) =>
    opts.verbose
      ? `  <!-- ${n} skills más no se listan por el presupuesto de la lista (${presupuesto} bytes) -->`
      : `- (${n} skills más no se listan por el presupuesto de la lista)`
  if (opts.verbose) {
    return ajustarAlPresupuesto(
      ["<available_skills>"],
      orden.map((skill) => [
        "  <skill>",
        `    <name>${escapeHtml(skill.name)}</name>`,
        `    <description>${descripcionAcotada(skill.description ?? "")}</description>`,
        `    <location>${escapeHtml(skill.location)}</location>`,
        "  </skill>",
      ]),
      ["</available_skills>"],
      presupuesto,
      nota,
    )
  }

  return ajustarAlPresupuesto(
    ["## Available Skills"],
    orden.map((skill) => [`- **${escapeHtml(skill.name)}**: ${descripcionAcotada(skill.description ?? "")}`]),
    [],
    presupuesto,
    nota,
  )
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Discovery.node, Config.node, EventV2Bridge.node, FSUtil.node, Global.node, RuntimeFlags.node],
})

export * as Skill from "."
