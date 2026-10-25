import { Account } from "@/account/account"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { Project } from "@/project/project"
import { Session } from "@/session/session"
import type { Snapshot } from "@/snapshot"
import { SessionRebobinar } from "@/session/rebobinar"
import { SessionTurnos } from "@/session/turnos"
import * as ApiError from "../errors"
import type { SessionID } from "@/session/schema"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Worktree } from "@/worktree"
import { Trabajos } from "@/tool/trabajos"
import { TaskGestion } from "@/tool/task-gestion"
import { SessionPrompt } from "@/session/prompt"
import { Effect, Option, Scope } from "effect"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import {
  ConsoleSwitchPayload,
  RebobinarConflictoError,
  RebobinarDeshacerPayload,
  RebobinarPayload,
  SessionListQuery,
  ToolListQuery,
  TurnoDiffQuery,
  TurnosQuery,
  WorktreeApiError,
} from "../groups/experimental"
import type { MessageID } from "@/session/schema"

function mapWorktreeError<A, R>(self: Effect.Effect<A, Worktree.Error, R>) {
  return self.pipe(
    Effect.mapError((error) => new WorktreeApiError({ name: error._tag, data: { message: error.message } })),
  )
}

export const experimentalHandlers = HttpApiBuilder.group(InstanceHttpApi, "experimental", (handlers) =>
  Effect.gen(function* () {
    const account = yield* Account.Service
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    const project = yield* Project.Service
    const registry = yield* ToolRegistry.Service
    const worktreeSvc = yield* Worktree.Service
    const sessions = yield* Session.Service
    const background = yield* BackgroundJob.Service
    const flags = yield* RuntimeFlags.Service
    const promptSvc = yield* SessionPrompt.Service
    const scope = yield* Scope.Scope

    const capabilities = Effect.fn("ExperimentalHttpApi.capabilities")(function* () {
      return { backgroundSubagents: flags.experimentalBackgroundSubagents }
    })

    const getConsole = Effect.fn("ExperimentalHttpApi.console")(function* () {
      const [state, groups] = yield* Effect.all(
        [
          config.getConsoleState(),
          account.orgsByAccount().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
        ],
        {
          concurrency: "unbounded",
        },
      )
      return {
        consoleManagedProviders: state.consoleManagedProviders,
        ...(state.activeOrgName ? { activeOrgName: state.activeOrgName } : {}),
        switchableOrgCount: groups.reduce((count, group) => count + group.orgs.length, 0),
      }
    })

    const listConsoleOrgs = Effect.fn("ExperimentalHttpApi.consoleOrgs")(function* () {
      const [groups, active] = yield* Effect.all(
        [
          account.orgsByAccount().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
          account.active().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
        ],
        {
          concurrency: "unbounded",
        },
      )
      const info = Option.getOrUndefined(active)
      return {
        orgs: groups.flatMap((group) =>
          group.orgs.map((org) => ({
            accountID: group.account.id,
            accountEmail: group.account.email,
            accountUrl: group.account.url,
            orgID: org.id,
            orgName: org.name,
            active: !!info && info.id === group.account.id && info.active_org_id === org.id,
          })),
        ),
      }
    })

    const switchConsole = Effect.fn("ExperimentalHttpApi.consoleSwitch")(function* (ctx: {
      payload: typeof ConsoleSwitchPayload.Type
    }) {
      yield* account
        .use(ctx.payload.accountID, Option.some(ctx.payload.orgID))
        .pipe(Effect.catch(() => Effect.fail(new HttpApiError.BadRequest({}))))
      return true
    })

    const tool = Effect.fn("ExperimentalHttpApi.tool")(function* (ctx: { query: typeof ToolListQuery.Type }) {
      const list = yield* registry.tools({
        providerID: ctx.query.provider,
        modelID: ctx.query.model,
        agent: yield* agents.defaultInfo(),
      })
      return list.map((item) => ({
        id: item.id,
        description: item.description,
        parameters: ToolJsonSchema.fromTool(item),
      }))
    })

    const toolIDs = Effect.fn("ExperimentalHttpApi.toolIDs")(function* () {
      return yield* registry.ids()
    })

    const worktree = Effect.fn("ExperimentalHttpApi.worktree")(function* () {
      const ctx = yield* InstanceState.context
      return yield* project.sandboxes(ctx.project.id)
    })

    const worktreeCreate = Effect.fn("ExperimentalHttpApi.worktreeCreate")(function* (ctx: {
      payload: typeof Worktree.CreateInput.Type | void
    }) {
      return yield* mapWorktreeError(worktreeSvc.create(ctx.payload ?? undefined))
    })

    const worktreeRemove = Effect.fn("ExperimentalHttpApi.worktreeRemove")(function* (input: {
      payload: Worktree.RemoveInput
    }) {
      const ctx = yield* InstanceState.context
      yield* mapWorktreeError(worktreeSvc.remove(input.payload))
      yield* project.removeSandbox(ctx.project.id, input.payload.directory)
      return true
    })

    const worktreeReset = Effect.fn("ExperimentalHttpApi.worktreeReset")(function* (ctx: {
      payload: Worktree.ResetInput
    }) {
      yield* mapWorktreeError(worktreeSvc.reset(ctx.payload))
      return true
    })

    const session = Effect.fn("ExperimentalHttpApi.session")(function* (ctx: { query: typeof SessionListQuery.Type }) {
      const limit = ctx.query.limit ?? 100
      const directory = ctx.query.directory ? yield* InstanceState.directory : undefined
      const all = yield* sessions.listGlobal({
        directory,
        roots: ctx.query.roots,
        start: ctx.query.start,
        cursor: ctx.query.cursor,
        search: ctx.query.search,
        limit: limit + 1,
        archived: ctx.query.archived,
      })
      const list = all.length > limit ? all.slice(0, limit) : all
      return HttpServerResponse.jsonUnsafe(list, {
        headers:
          all.length > limit && list.length > 0
            ? { "x-next-cursor": String(list[list.length - 1].time.updated) }
            : undefined,
      })
    })

    const sessionBackground = Effect.fn("ExperimentalHttpApi.sessionBackground")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      if (!flags.experimentalBackgroundSubagents) return false
      const jobs = (yield* background.list()).filter(
        (job) =>
          job.type === "task" &&
          job.status === "running" &&
          job.metadata?.parentSessionId === ctx.params.sessionID &&
          job.metadata.background !== true,
      )
      const promoted = yield* Effect.forEach(jobs, (job) => background.promote(job.id), { concurrency: "unbounded" })
      return promoted.some((job) => job !== undefined)
    })

    const sessionTrabajos = Effect.fn("ExperimentalHttpApi.sessionTrabajos")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      const directory = yield* InstanceState.directory
      return { trabajos: yield* Trabajos.listar(background, ctx.params.sessionID, directory) }
    })

    const sessionTrabajoTerminar = Effect.fn("ExperimentalHttpApi.sessionTrabajoTerminar")(function* (ctx: {
      params: { sessionID: SessionID; id: string }
    }) {
      return { ok: yield* Trabajos.terminar(background, ctx.params.sessionID, ctx.params.id) }
    })

    const sessionTrabajoReanudar = Effect.fn("ExperimentalHttpApi.sessionTrabajoReanudar")(function* (ctx: {
      params: { sessionID: SessionID; id: string }
    }) {
      return yield* TaskGestion.reanudarAyudante({
        sessionID: ctx.params.sessionID,
        id: ctx.params.id,
        prompt: promptSvc,
        scope,
      })
    })

    const turnosSvc = yield* SessionTurnos.Service

    const apagado = () => ApiError.notFound("Rebobinar por turno está desactivado (LAZUNOX_REBOBINAR=0)")

    const sessionTurnos = Effect.fn("ExperimentalHttpApi.sessionTurnos")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof TurnosQuery.Type
    }) {
      if (!SessionTurnos.activo()) return yield* Effect.fail(apagado())
      return yield* turnosSvc
        .listar({ sessionID: ctx.params.sessionID, antesDe: ctx.query.antesDe, limite: ctx.query.limite })
        .pipe(
          Effect.catchTag("TurnoNoEncontrado", (error) => Effect.fail(ApiError.notFound(error.message))),
          Effect.catchTag("NotFoundError", (error) => Effect.fail(ApiError.notFound(error.message))),
        )
    })

    const sessionTurnoDiff = Effect.fn("ExperimentalHttpApi.sessionTurnoDiff")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
      query: typeof TurnoDiffQuery.Type
    }) {
      if (!SessionTurnos.activo()) return yield* Effect.fail(apagado())
      return yield* turnosSvc
        .diff({ sessionID: ctx.params.sessionID, messageID: ctx.params.messageID, file: ctx.query.file })
        .pipe(
          Effect.catchTag("TurnoNoEncontrado", (error) => Effect.fail(ApiError.notFound(error.message))),
          Effect.catchTag("NotFoundError", (error) => Effect.fail(ApiError.notFound(error.message))),
          Effect.catchTag("SnapshotExpiredError", (error) =>
            Effect.fail(new RebobinarConflictoError({ motivo: "caducado", message: error.message })),
          ),
        )
    })

    const rebobinarSvc = yield* SessionRebobinar.Service

    const mapRebobinar = <A, R>(
      self: Effect.Effect<
        A,
        | InstanceType<typeof SessionTurnos.NoEncontrado>
        | InstanceType<typeof SessionRebobinar.Invalido>
        | InstanceType<typeof SessionRebobinar.Conflicto>
        | Session.NotFound
        | Snapshot.ExpiredError,
        R
      >,
    ) =>
      self.pipe(
        Effect.catchTag("TurnoNoEncontrado", (error) => Effect.fail(ApiError.notFound(error.message))),
        Effect.catchTag("NotFoundError", (error) => Effect.fail(ApiError.notFound(error.message))),
        Effect.catchTag("RebobinarInvalido", (error) =>
          Effect.fail(new ApiError.InvalidRequestError({ message: error.message, kind: "rebobinar" })),
        ),
        Effect.catchTag("RebobinarConflictoInterno", (error) =>
          Effect.fail(new RebobinarConflictoError({ motivo: error.motivo, message: error.message })),
        ),
        Effect.catchTag("SnapshotExpiredError", (error) =>
          Effect.fail(new RebobinarConflictoError({ motivo: "caducado", message: error.message })),
        ),
      )

    const sessionRebobinarRevision = Effect.fn("ExperimentalHttpApi.sessionRebobinarRevision")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
    }) {
      return yield* mapRebobinar(
        rebobinarSvc.revision({ sessionID: ctx.params.sessionID, messageID: ctx.params.messageID }),
      )
    })

    const sessionRebobinar = Effect.fn("ExperimentalHttpApi.sessionRebobinar")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof RebobinarPayload.Type
    }) {
      return yield* mapRebobinar(
        rebobinarSvc.rebobinar({
          sessionID: ctx.params.sessionID,
          messageID: ctx.payload.messageID,
          modo: ctx.payload.modo,
          sobrescribir: ctx.payload.sobrescribir,
        }),
      )
    })

    const sessionRebobinarDeshacer = Effect.fn("ExperimentalHttpApi.sessionRebobinarDeshacer")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof RebobinarDeshacerPayload.Type
    }) {
      return yield* mapRebobinar(
        rebobinarSvc.deshacer({ sessionID: ctx.params.sessionID, sobrescribir: ctx.payload.sobrescribir }),
      )
    })

    const resource = Effect.fn("ExperimentalHttpApi.resource")(function* () {
      return yield* mcp.resources()
    })

    return handlers
      .handle("capabilities", capabilities)
      .handle("console", getConsole)
      .handle("consoleOrgs", listConsoleOrgs)
      .handle("consoleSwitch", switchConsole)
      .handle("tool", tool)
      .handle("toolIDs", toolIDs)
      .handle("worktree", worktree)
      .handle("worktreeCreate", worktreeCreate)
      .handle("worktreeRemove", worktreeRemove)
      .handle("worktreeReset", worktreeReset)
      .handle("session", session)
      .handle("sessionBackground", sessionBackground)
      .handle("sessionTrabajos", sessionTrabajos)
      .handle("sessionTrabajoTerminar", sessionTrabajoTerminar)
      .handle("sessionTrabajoReanudar", sessionTrabajoReanudar)
      .handle("sessionTurnos", sessionTurnos)
      .handle("sessionTurnoDiff", sessionTurnoDiff)
      .handle("sessionRebobinarRevision", sessionRebobinarRevision)
      .handle("sessionRebobinar", sessionRebobinar)
      .handle("sessionRebobinarDeshacer", sessionRebobinarDeshacer)
      .handle("resource", resource)
  }),
)
