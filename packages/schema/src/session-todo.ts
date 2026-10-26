export * as SessionTodo from "./session-todo"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { SessionID } from "./session-id"

export const Info = Schema.Struct({
  content: Schema.String.annotate({ description: "Brief description of the task" }),
  status: Schema.String.annotate({
    description: "Current status of the task: pending, in_progress, completed, cancelled",
  }),
  priority: Schema.String.annotate({
    description: "Priority level of the task: high, medium, low",
  }),
  // Lazunox (2D, P09): criterio para dar la tarea por hecha. Si empieza con `$ ` es un comando que se corre con la herramienta shell
  // (con su permiso normal); si no, es texto que el modelo debe comprobar él mismo.
  verificar: Schema.optional(Schema.String).annotate({
    description:
      'Optional check for completion. If it starts with "$ " the rest is a shell command run with normal permissions when you mark the task completed; if it fails the task stays in_progress.',
  }),
  bloqueado: Schema.optional(Schema.Boolean).annotate({
    description: "Optional. true when the task is blocked (waiting for the user or something that cannot be solved now).",
  }),
}).annotate({ identifier: "Todo" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

const Updated = define({
  type: "todo.updated",
  schema: {
    sessionID: SessionID,
    todos: Schema.Array(Info),
  },
})
export const Event = { Updated, Definitions: inventory(Updated) }
