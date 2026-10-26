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
  // Lazunox (6.6, H11): dependencias entre tareas de la MISMA lista. `id` es opcional y solo hace falta en las tareas de las que otras dependen.
  id: Schema.optional(Schema.String).annotate({
    description: "Optional. Short id (letters, digits, - _ .; max 40) so other todos can depend on this one. Unique within the list.",
  }),
  depende_de: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Optional. ids of todos in this same list that must be completed before this one can be in_progress or completed (max 10). Cycles and unknown ids reject the whole list.",
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
