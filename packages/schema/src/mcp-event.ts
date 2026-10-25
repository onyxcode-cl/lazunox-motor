export * as McpEvent from "./mcp-event"

import { Schema } from "effect"
import { Event } from "./event"
import { ascending } from "./identifier"
import { SessionID } from "./session-id"
import { statics } from "./schema"

export const ToolsChanged = Event.define({
  type: "mcp.tools.changed",
  schema: {
    server: Schema.String,
  },
})

export const BrowserOpenFailed = Event.define({
  type: "mcp.browser.open.failed",
  schema: {
    mcpName: Schema.String,
    url: Schema.String,
  },
})

// Formularios MCP (elicitation/create, modo formulario). Contrato fijo con la app (plan de herramientas diferidas y
// formularios MCP, tarea T4). Los VALORES que escribe la persona nunca viajan en eventos: solo los nombres de campo.
export const ElicitationID = Schema.String.check(Schema.isStartsWith("eli")).pipe(
  Schema.brand("McpElicitationID"),
  statics((schema) => ({ ascending: (id?: string) => schema.make(id ?? "eli_" + ascending()) })),
)
export type ElicitationID = typeof ElicitationID.Type

export const ElicitationOption = Schema.Struct({ value: Schema.String, label: Schema.String }).annotate({
  identifier: "McpElicitationOption",
})

/** Campo ya normalizado y acotado por el motor (la app no recibe el esquema JSON crudo del servidor). */
export const ElicitationField = Schema.Struct({
  name: Schema.String,
  type: Schema.Literals(["string", "number", "integer", "boolean", "enum"]),
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  required: Schema.Boolean,
  format: Schema.optional(Schema.Literals(["email", "uri", "date", "date-time"])),
  minLength: Schema.optional(Schema.Number),
  maxLength: Schema.optional(Schema.Number),
  minimum: Schema.optional(Schema.Number),
  maximum: Schema.optional(Schema.Number),
  options: Schema.optional(Schema.Array(ElicitationOption)),
  default: Schema.optional(Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
}).annotate({ identifier: "McpElicitationField" })
export type ElicitationField = typeof ElicitationField.Type

export const ElicitationAction = Schema.Literals(["accept", "decline", "cancel"])
export type ElicitationAction = typeof ElicitationAction.Type

export const ElicitationRejectReason = Schema.Literals([
  "timeout",
  "abort",
  "server-cancel",
  "secret",
  "schema",
  "ambiguous",
])
export type ElicitationRejectReason = typeof ElicitationRejectReason.Type

export const ElicitationRequest = Schema.Struct({
  id: ElicitationID,
  sessionID: SessionID,
  server: Schema.String,
  callID: Schema.optional(Schema.String),
  message: Schema.String,
  fields: Schema.Array(ElicitationField),
  expiresAt: Schema.Number.annotate({ description: "Milisegundos desde epoch en que el formulario caduca" }),
}).annotate({ identifier: "McpElicitationRequest" })
export type ElicitationRequest = typeof ElicitationRequest.Type

export const ElicitationAsked = Event.define({
  type: "mcp.elicitation.asked",
  schema: ElicitationRequest.fields,
})

export const ElicitationReplied = Event.define({
  type: "mcp.elicitation.replied",
  schema: { id: ElicitationID, sessionID: SessionID, action: ElicitationAction },
})

export const ElicitationRejected = Event.define({
  type: "mcp.elicitation.rejected",
  schema: { id: ElicitationID, sessionID: SessionID, reason: ElicitationRejectReason },
})

export const Definitions = Event.inventory(
  ToolsChanged,
  BrowserOpenFailed,
  ElicitationAsked,
  ElicitationReplied,
  ElicitationRejected,
)
