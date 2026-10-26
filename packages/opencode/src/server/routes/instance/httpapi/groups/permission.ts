import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Permission } from "@/permission"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { PermissionNotFoundError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/permission"
const ReplyPayload = Schema.Struct({
  reply: PermissionV1.Reply,
  message: Schema.optional(Schema.String),
})

// Lazunox (Ola 7, 7.22): gestionar los «siempre» guardados en disco de la carpeta del proyecto.
const SiempreRegla = Schema.Struct({ id: Schema.String, permission: Schema.String, pattern: Schema.String })
const SiempreLista = Schema.Struct({
  activo: Schema.Boolean,
  reglas: Schema.Array(SiempreRegla),
  aviso: Schema.optional(Schema.String),
}).annotate({ identifier: "PermissionSiempreList" })

export const PermissionApi = HttpApi.make("permission")
  .add(
    HttpApiGroup.make("permission")
      .add(
        HttpApiEndpoint.get("list", root, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(PermissionV1.Request), "List of pending permissions"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "permission.list",
            summary: "List pending permissions",
            description: "Get all pending permission requests across all sessions.",
          }),
        ),
        HttpApiEndpoint.post("reply", `${root}/:requestID/reply`, {
          params: { requestID: PermissionV1.ID },
          query: WorkspaceRoutingQuery,
          payload: ReplyPayload,
          success: described(Schema.Boolean, "Permission processed successfully"),
          error: [HttpApiError.BadRequest, PermissionNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "permission.reply",
            summary: "Respond to permission request",
            description: "Approve or deny a permission request from the AI assistant.",
          }),
        ),
        HttpApiEndpoint.get("siempreList", `${root}/siempre`, {
          query: WorkspaceRoutingQuery,
          success: described(SiempreLista, "Saved always-allow rules of this project folder"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "permission.siempre.list",
            summary: "List saved always-allow rules",
            description: "List the saved 'always' permissions of this folder (works even if persistence is off).",
          }),
        ),
        HttpApiEndpoint.delete("siempreRemoveAll", `${root}/siempre`, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Struct({ borradas: Schema.Number }), "How many saved rules were removed"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "permission.siempre.removeAll",
            summary: "Remove all saved always-allow rules",
            description: "Forget every saved 'always' permission of this folder, on disk and in memory.",
          }),
        ),
        HttpApiEndpoint.delete("siempreRemove", `${root}/siempre/:id`, {
          params: { id: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Saved rule removed"),
          error: [PermissionNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "permission.siempre.remove",
            summary: "Remove one saved always-allow rule",
            description: "Forget one saved 'always' permission by its stable id; the others are untouched.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "permission",
          description: "Experimental HttpApi permission routes.",
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
