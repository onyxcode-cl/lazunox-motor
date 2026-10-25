import { AccountID, OrgID } from "@/account/schema"
import { MCP } from "@/mcp"

import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { Worktree } from "@/worktree"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"
import { QueryBoolean } from "./query"
import { ApiNotFoundError } from "../errors"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const ConsoleStateResponse = Schema.Struct({
  consoleManagedProviders: Schema.mutable(Schema.Array(Schema.String)),
  activeOrgName: Schema.optionalKey(Schema.String),
  switchableOrgCount: NonNegativeInt,
}).annotate({ identifier: "ConsoleState" })

const CapabilitiesResponse = Schema.Struct({
  backgroundSubagents: Schema.Boolean,
}).annotate({ identifier: "ExperimentalCapabilities" })

const ConsoleOrgOption = Schema.Struct({
  accountID: Schema.String,
  accountEmail: Schema.String,
  accountUrl: Schema.String,
  orgID: Schema.String,
  orgName: Schema.String,
  active: Schema.Boolean,
})

const ConsoleOrgList = Schema.Struct({
  orgs: Schema.Array(ConsoleOrgOption),
})

export const ConsoleSwitchPayload = Schema.Struct({
  accountID: AccountID,
  orgID: OrgID,
})

const ToolIDs = Schema.Array(Schema.String).annotate({ identifier: "ToolIDs" })
const ToolListItem = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  parameters: Schema.Unknown,
}).annotate({ identifier: "ToolListItem" })
const ToolList = Schema.Array(ToolListItem).annotate({ identifier: "ToolList" })
export const ToolListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  provider: ProviderV2.ID,
  model: ModelV2.ID,
})

const WorktreeList = Schema.Array(Schema.String)
const WorktreeErrorName = Schema.Union([
  Schema.Literal("WorktreeNotGitError"),
  Schema.Literal("WorktreeNameGenerationFailedError"),
  Schema.Literal("WorktreeCreateFailedError"),
  Schema.Literal("WorktreeStartCommandFailedError"),
  Schema.Literal("WorktreeRemoveFailedError"),
  Schema.Literal("WorktreeResetFailedError"),
  Schema.Literal("WorktreeListFailedError"),
])
export class WorktreeApiError extends Schema.ErrorClass<WorktreeApiError>("WorktreeError")(
  {
    name: WorktreeErrorName,
    data: Schema.Struct({ message: Schema.String }),
  },
  { httpApiStatus: 400 },
) {}
export const SessionListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  roots: Schema.optional(QueryBoolean),
  start: Schema.optional(Schema.NumberFromString),
  cursor: Schema.optional(Schema.NumberFromString),
  search: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
  archived: Schema.optional(QueryBoolean),
})

// Lazunox: trabajos en segundo plano de una sesión (contrato motor-app, plan 1.7).
export const TrabajoInfo = Schema.Struct({
  id: Schema.String,
  tipo: Schema.Union([Schema.Literal("shell"), Schema.Literal("celda")]),
  titulo: Schema.String,
  estado: Schema.Union([
    Schema.Literal("en_curso"),
    Schema.Literal("terminado"),
    Schema.Literal("terminado_por_ti"),
    Schema.Literal("tope_de_vida"),
    Schema.Literal("perdido"),
  ]),
  codigo: Schema.NullOr(Schema.Number),
  inicio: Schema.Number,
  fin: Schema.NullOr(Schema.Number),
}).annotate({ identifier: "TrabajoInfo" })
export const TrabajosResponse = Schema.Struct({ trabajos: Schema.Array(TrabajoInfo) }).annotate({
  identifier: "TrabajosResponse",
})
export const TrabajoTerminarResponse = Schema.Struct({ ok: Schema.Boolean }).annotate({
  identifier: "TrabajoTerminarResponse",
})

// Lazunox: rebobinar por turno (plan PLAN-REBOBINAR-Y-COMPACTACION.md, 2.A). Solo rutas y cifras, nunca contenido salvo el diff bajo demanda.
export const TurnoArchivo = Schema.Struct({
  file: Schema.String,
  status: Schema.Union([Schema.Literal("added"), Schema.Literal("deleted"), Schema.Literal("modified")]),
  additions: Schema.Number,
  deletions: Schema.Number,
  origen: Schema.Union([Schema.Literal("herramienta"), Schema.Literal("comando"), Schema.Literal("otro")]),
}).annotate({ identifier: "TurnoArchivo" })
export const TurnoInfo = Schema.Struct({
  messageID: Schema.String,
  time: Schema.Number,
  files: Schema.Array(TurnoArchivo),
  truncated: Schema.Boolean,
  restaurable: Schema.Boolean,
  motivo: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "TurnoInfo" })
export const TurnosResponse = Schema.Array(TurnoInfo).annotate({ identifier: "TurnosResponse" })
export const TurnosQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  antesDe: Schema.optional(MessageID),
  limite: Schema.optional(Schema.NumberFromString),
})
export const TurnoDiffQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  file: Schema.String,
})
export const TurnoDiffResponse = Schema.Struct({
  file: Schema.String,
  status: Schema.Union([Schema.Literal("added"), Schema.Literal("deleted"), Schema.Literal("modified")]),
  additions: Schema.Number,
  deletions: Schema.Number,
  patch: Schema.String,
  binary: Schema.Boolean,
  truncated: Schema.Boolean,
}).annotate({ identifier: "TurnoDiffResponse" })
/** 409 de rebobinar: `motivo` dice por qué (ocupada, hija-ocupada, trabajo-vivo, pendiente, caducado, sin-git…). */
export class RebobinarConflictoError extends Schema.TaggedErrorClass<RebobinarConflictoError>()(
  "RebobinarConflicto",
  { motivo: Schema.String, message: Schema.String },
  { httpApiStatus: 409 },
) {}

export const ExperimentalPaths = {
  capabilities: "/experimental/capabilities",
  console: "/experimental/console",
  consoleOrgs: "/experimental/console/orgs",
  consoleSwitch: "/experimental/console/switch",
  tool: "/experimental/tool",
  toolIDs: "/experimental/tool/ids",
  worktree: "/experimental/worktree",
  worktreeReset: "/experimental/worktree/reset",
  session: "/experimental/session",
  sessionBackground: "/experimental/session/:sessionID/background",
  sessionTrabajos: "/experimental/session/:sessionID/trabajos",
  sessionTrabajoTerminar: "/experimental/session/:sessionID/trabajos/:id/terminar",
  sessionTurnos: "/experimental/session/:sessionID/turnos",
  sessionTurnoDiff: "/experimental/session/:sessionID/turnos/:messageID/diff",
  resource: "/experimental/resource",
} as const

export const ExperimentalApi = HttpApi.make("experimental")
  .add(
    HttpApiGroup.make("experimental")
      .add(
        HttpApiEndpoint.get("capabilities", ExperimentalPaths.capabilities, {
          query: WorkspaceRoutingQuery,
          success: described(CapabilitiesResponse, "Experimental capabilities"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.capabilities.get",
            summary: "Get experimental capabilities",
            description: "Get experimental features enabled on the OpenCode server.",
          }),
        ),
        HttpApiEndpoint.get("console", ExperimentalPaths.console, {
          query: WorkspaceRoutingQuery,
          success: described(ConsoleStateResponse, "Active Console provider metadata"),
          error: HttpApiError.InternalServerError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.get",
            summary: "Get active Console provider metadata",
            description: "Get the active Console org name and the set of provider IDs managed by that Console org.",
          }),
        ),
        HttpApiEndpoint.get("consoleOrgs", ExperimentalPaths.consoleOrgs, {
          query: WorkspaceRoutingQuery,
          success: described(ConsoleOrgList, "Switchable Console orgs"),
          error: HttpApiError.InternalServerError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.listOrgs",
            summary: "List switchable Console orgs",
            description: "Get the available Console orgs across logged-in accounts, including the current active org.",
          }),
        ),
        HttpApiEndpoint.post("consoleSwitch", ExperimentalPaths.consoleSwitch, {
          query: WorkspaceRoutingQuery,
          payload: ConsoleSwitchPayload,
          success: described(Schema.Boolean, "Switch success"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.switchOrg",
            summary: "Switch active Console org",
            description: "Persist a new active Console account/org selection for the current local OpenCode state.",
          }),
        ),
        HttpApiEndpoint.get("tool", ExperimentalPaths.tool, {
          query: ToolListQuery,
          success: described(ToolList, "Tools"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tool.list",
            summary: "List tools",
            description:
              "Get a list of available tools with their JSON schema parameters for a specific provider and model combination.",
          }),
        ),
        HttpApiEndpoint.get("toolIDs", ExperimentalPaths.toolIDs, {
          query: WorkspaceRoutingQuery,
          success: described(ToolIDs, "Tool IDs"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tool.ids",
            summary: "List tool IDs",
            description:
              "Get a list of all available tool IDs, including both built-in tools and dynamically registered tools.",
          }),
        ),
        HttpApiEndpoint.get("worktree", ExperimentalPaths.worktree, {
          query: WorkspaceRoutingQuery,
          success: described(WorktreeList, "List of worktree directories"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.list",
            summary: "List worktrees",
            description: "List all sandbox worktrees for the current project.",
          }),
        ),
        HttpApiEndpoint.post("worktreeCreate", ExperimentalPaths.worktree, {
          disableCodecs: true,
          query: WorkspaceRoutingQuery,
          payload: [HttpApiSchema.NoContent, Worktree.CreateInput],
          success: described(Worktree.Info, "Worktree created"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.create",
            summary: "Create worktree",
            description: "Create a new git worktree for the current project and run any configured startup scripts.",
          }),
        ),
        HttpApiEndpoint.delete("worktreeRemove", ExperimentalPaths.worktree, {
          query: WorkspaceRoutingQuery,
          payload: Worktree.RemoveInput,
          success: described(Schema.Boolean, "Worktree removed"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.remove",
            summary: "Remove worktree",
            description: "Remove a git worktree and delete its branch.",
          }),
        ),
        HttpApiEndpoint.post("worktreeReset", ExperimentalPaths.worktreeReset, {
          query: WorkspaceRoutingQuery,
          payload: Worktree.ResetInput,
          success: described(Schema.Boolean, "Worktree reset"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.reset",
            summary: "Reset worktree",
            description: "Reset a worktree branch to the primary default branch.",
          }),
        ),
        HttpApiEndpoint.get("session", ExperimentalPaths.session, {
          query: SessionListQuery,
          success: described(Schema.Array(Session.GlobalInfo), "List of sessions"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.list",
            summary: "List sessions",
            description:
              "Get a list of all OpenCode sessions across projects, sorted by most recently updated. Archived sessions are excluded by default.",
          }),
        ),
        HttpApiEndpoint.post("sessionBackground", ExperimentalPaths.sessionBackground, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Backgrounded subagents"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.background",
            summary: "Background subagents",
            description:
              "Detach any synchronous subagents currently blocking the session and continue them in the background.",
          }),
        ),
        HttpApiEndpoint.get("sessionTrabajos", ExperimentalPaths.sessionTrabajos, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(TrabajosResponse, "Background jobs of the session"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.trabajos",
            summary: "List background jobs",
            description:
              "List the background shells and Code Mode cells of one session (live and recently finished, at most 50, newest first).",
          }),
        ),
        HttpApiEndpoint.post("sessionTrabajoTerminar", ExperimentalPaths.sessionTrabajoTerminar, {
          params: { sessionID: SessionID, id: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(TrabajoTerminarResponse, "Whether the job was terminated"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.trabajos.terminar",
            summary: "Terminate a background job",
            description:
              "Kill the process group of a background shell or interrupt a Code Mode cell of this session. ok is false if it does not exist, already finished or belongs to another session.",
          }),
        ),
        HttpApiEndpoint.get("sessionTurnos", ExperimentalPaths.sessionTurnos, {
          params: { sessionID: SessionID },
          query: TurnosQuery,
          success: described(TurnosResponse, "Turns of the session with the files each one changed"),
          error: [ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.turnos",
            summary: "List turns with their changed files",
            description:
              "Lightweight per-turn summary (paths, +/- counts and origin; never contents): the last 100 turns before antesDe (oldest first), at most 500 files per turn. restaurable tells whether the code of that turn can still be restored.",
          }),
        ),
        HttpApiEndpoint.get("sessionTurnoDiff", ExperimentalPaths.sessionTurnoDiff, {
          params: { sessionID: SessionID, messageID: MessageID },
          query: TurnoDiffQuery,
          success: described(TurnoDiffResponse, "Patch of one file changed by the turn"),
          error: [ApiNotFoundError, RebobinarConflictoError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.turnos.diff",
            summary: "Get the patch of one file of a turn",
            description: "Patch with 3 lines of context, cut at 1 MB. 409 caducado if the checkpoint no longer exists.",
          }),
        ),
        HttpApiEndpoint.get("resource", ExperimentalPaths.resource, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Record(Schema.String, MCP.Resource), "MCP resources"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.resource.list",
            summary: "Get MCP resources",
            description: "Get all available MCP resources from connected servers. Optionally filter by name.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "experimental",
          description: "Experimental HttpApi read-only routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
