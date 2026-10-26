import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { InstanceState } from "@/effect/instance-state"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Deferred, Effect, Layer, Context } from "effect"
import os from "os"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Plugin } from "@/plugin"
import * as SiempreDisco from "./siempre-disco"
import * as RutasProtegidas from "./rutas-protegidas"
import * as Sugerencia from "./sugerencia"

export const Event = PermissionV1.Event

export interface Interface {
  readonly ask: (input: PermissionV1.AskInput) => Effect.Effect<void, PermissionV1.Error>
  readonly reply: (input: PermissionV1.ReplyInput) => Effect.Effect<void, PermissionV1.NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<PermissionV1.Request>>
}

interface PendingEntry {
  info: PermissionV1.Request
  deferred: Deferred.Deferred<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>
}

interface State {
  pending: Map<PermissionV1.ID, PendingEntry>
  approved: PermissionV1.Rule[]
  directory: string
  worktree: string
}

export function evaluate(permission: string, pattern: string, ...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern)) ?? {
      action: "ask",
      permission,
      pattern: "*",
    }
  )
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const plugin = yield* Plugin.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Permission.state")(function* (ctx) {
        // Lazunox: los «siempre» guardados de esta carpeta (si la app lo encendió) arrancan ya aprobados.
        const state: State = {
          pending: new Map<PermissionV1.ID, PendingEntry>(),
          approved: SiempreDisco.cargar(ctx.directory).map((r) => ({ ...r, action: "allow" as const })),
          directory: ctx.directory,
          worktree: ctx.worktree && ctx.worktree !== "/" ? ctx.worktree : ctx.directory,
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    const ask = Effect.fn("Permission.ask")(function* (input: PermissionV1.AskInput) {
      const { approved, pending, worktree } = yield* InstanceState.get(state)
      const { ruleset, ...request } = input
      const agente = typeof request.metadata?.["lazunox_agente"] === "string" ? request.metadata["lazunox_agente"] : undefined
      let needsAsk = false
      // Lazunox (6.8): aviso `permission.denied` a los plugins (solo informa; sin argumentos de la llamada) y el error de siempre.
      const negar = (ruleset: PermissionV1.Ruleset, origen: "regla" | "plugin") =>
        Effect.gen(function* () {
          const reglas = ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission))
          yield* plugin
            .trigger(
              "permission.denied",
              {
                sessionID: String(request.sessionID),
                ...(request.tool?.callID ? { callID: request.tool.callID } : {}),
                permission: request.permission,
                origen,
                reglas: reglas.slice(0, 20).map((r) => ({ permission: r.permission, pattern: r.pattern, action: r.action })),
              },
              {},
            )
            .pipe(Effect.ignore)
          return yield* new PermissionV1.DeniedError({ ruleset: reglas })
        })
      // Lazunox: ediciones en rutas protegidas (.git, .opencode, .claude, .mcp.json…) siempre se preguntan, salvo `deny`.
      let protegido = false

      for (const pattern of request.patterns) {
        if (request.permission === "edit" && RutasProtegidas.activo() && RutasProtegidas.esProtegida(pattern, process.env, { agente, raiz: worktree })) {
          if (evaluate(request.permission, pattern, ruleset).action === "deny") {
            return yield* negar(ruleset, "regla")
          }
          protegido = true
          needsAsk = true
          continue
        }
        // Lazunox: un «siempre» (de esta sesión o guardado en disco) nunca levanta un `deny` vigente de las reglas de la llamada.
        const rule =
          evaluate(request.permission, pattern, ruleset).action === "deny"
            ? evaluate(request.permission, pattern, ruleset)
            : evaluate(request.permission, pattern, ruleset, approved)
        yield* Effect.logInfo("evaluated", { permission: request.permission, pattern, action: rule })
        if (rule.action === "deny") {
          return yield* negar(ruleset, "regla")
        }
        if (rule.action === "allow") continue
        needsAsk = true
      }

      if (!needsAsk) return

      const id = request.id ?? PermissionV1.ID.ascending()

      // Lazunox: el gancho de plugin `permission.ask` (tipado en OpenCode pero nunca disparado) decide antes de preguntar a la persona:
      // `deny` rechaza, `allow` aprueba, `ask` (por defecto) sigue el camino normal. Solo lo usan plugins propios de confianza.
      const decision = yield* plugin.trigger(
        "permission.ask",
        {
          id,
          type: request.permission,
          pattern: request.patterns.length === 1 ? request.patterns[0] : request.patterns,
          sessionID: request.sessionID,
          messageID: request.tool?.messageID ?? "",
          ...(request.tool?.callID ? { callID: request.tool.callID } : {}),
          title: request.permission,
          metadata: request.metadata ?? {},
          time: { created: Date.now() },
        },
        { status: "ask" as "ask" | "deny" | "allow" },
      )
      if (decision.status === "deny") {
        return yield* negar(ruleset, "plugin")
      }
      if (decision.status === "allow" && !protegido) return

      // Lazunox (5A): sugerencia del modelo pequeño como DATO adjunto. No toca `needsAsk`, `always` ni la decisión: solo informa a la persona.
      // Falla cerrado (error/plazo/basura = sin sugerencia). Una clave con ese nombre que venga de la herramienta se descarta.
      const { [Sugerencia.CLAVE_METADATA]: _ajena, ...metaLimpia } = (request.metadata ?? {}) as Record<string, unknown>
      const sugerencia = yield* Sugerencia.sugerir({
        sessionID: String(request.sessionID),
        permiso: request.permission,
        patrones: request.patterns,
        regla: request.patterns
          .slice(0, 5)
          .map((p) => {
            const r = evaluate(request.permission, p, ruleset, approved)
            return `${r.action} (${r.permission}: ${r.pattern})`
          })
          .join("; "),
      })

      const info: PermissionV1.Request = {
        id,
        sessionID: request.sessionID,
        permission: request.permission,
        patterns: request.patterns,
        metadata:
          protegido || sugerencia || Sugerencia.CLAVE_METADATA in (request.metadata ?? {})
            ? {
                ...metaLimpia,
                ...(protegido ? { lazunoxProtegido: true } : {}),
                ...(sugerencia ? { [Sugerencia.CLAVE_METADATA]: sugerencia } : {}),
              }
            : request.metadata,
        // Una ruta protegida no se puede aprobar con «siempre» (el «siempre» de un archivo no debe cubrir los demás).
        always: protegido ? [] : request.always,
        tool: request.tool,
      }
      yield* Effect.logInfo("asking", { id, permission: info.permission, patterns: info.patterns })

      const deferred = yield* Deferred.make<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>()
      pending.set(id, { info, deferred })
      yield* events.publish(Event.Asked, info)
      return yield* Effect.ensuring(
        Deferred.await(deferred),
        Effect.sync(() => {
          pending.delete(id)
        }),
      )
    })

    const reply = Effect.fn("Permission.reply")(function* (input: PermissionV1.ReplyInput) {
      const state_ = yield* InstanceState.get(state)
      const { approved, pending } = state_
      const existing = pending.get(input.requestID)
      if (!existing) return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })

      pending.delete(input.requestID)
      yield* events.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: input.reply,
      })

      if (input.reply === "reject") {
        yield* Deferred.fail(
          existing.deferred,
          input.message
            ? new PermissionV1.CorrectedError({ feedback: input.message })
            : new PermissionV1.RejectedError(),
        )

        for (const [id, item] of pending.entries()) {
          if (item.info.sessionID !== existing.info.sessionID) continue
          pending.delete(id)
          yield* events.publish(Event.Replied, {
            sessionID: item.info.sessionID,
            requestID: item.info.id,
            reply: "reject",
          })
          yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
        }
        return
      }

      yield* Deferred.succeed(existing.deferred, undefined)
      if (input.reply === "once") return

      for (const pattern of existing.info.always) {
        approved.push({
          permission: existing.info.permission,
          pattern,
          action: "allow",
        })
      }
      SiempreDisco.guardar(
        state_.directory,
        existing.info.always.map((pattern) => ({ permission: existing.info.permission, pattern })),
      )

      for (const [id, item] of pending.entries()) {
        if (item.info.sessionID !== existing.info.sessionID) continue
        if (item.info.metadata?.lazunoxProtegido) continue
        const ok = item.info.patterns.every(
          (pattern) => evaluate(item.info.permission, pattern, approved).action === "allow",
        )
        if (!ok) continue
        pending.delete(id)
        yield* events.publish(Event.Replied, {
          sessionID: item.info.sessionID,
          requestID: item.info.id,
          reply: "always",
        })
        yield* Deferred.succeed(item.deferred, undefined)
      }
    })

    const list = Effect.fn("Permission.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (item) => item.info)
    })

    return Service.of({ ask, reply, list })
  }),
)

function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

export function fromConfig(permission: ConfigPermissionV1.Info) {
  const ruleset: PermissionV1.Rule[] = []
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      ruleset.push({ permission: key, action: value, pattern: "*" })
      continue
    }
    ruleset.push(
      ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
    )
  }
  return ruleset
}

export function merge(...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule[] {
  return rulesets.flat()
}

// Nombres reservados de la búsqueda diferida (ver tool/tool-search.ts; se repiten aquí para no importar la herramienta).
const DEFERRED_TOOL_NAMES = ["tool_search", "mcp_call"]

export function disabled(tools: string[], ruleset: PermissionV1.Ruleset): Set<string> {
  const edits = ["edit", "write", "apply_patch"]
  const reads = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]
  return new Set(
    tools.filter((tool) => {
      // Lazunox: tool_search y mcp_call no se ocultan por un `*: deny` genérico (su contenido ya viene filtrado por
      // permisos), solo por una regla que los nombre exactamente.
      if (DEFERRED_TOOL_NAMES.includes(tool)) {
        const exact = ruleset.findLast((rule) => rule.permission === tool)
        return exact?.pattern === "*" && exact.action === "deny"
      }
      const permission = edits.includes(tool) ? "edit" : reads.includes(tool) ? "read" : tool
      const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
      return rule?.pattern === "*" && rule.action === "deny"
    }),
  )
}

export function visibleTools<T>(tools: Record<string, T>, ruleset: PermissionV1.Ruleset): Record<string, T> {
  const hidden = disabled(Object.keys(tools), ruleset)
  return Object.fromEntries(Object.entries(tools).filter(([name]) => !hidden.has(name)))
}

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node, Plugin.node] })

export * as Permission from "."
