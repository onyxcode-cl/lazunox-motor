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
      "Optional. \"$ cmd\" runs a shell command when marked completed; other text is a note.",
  }),
  bloqueado: Schema.optional(Schema.Boolean).annotate({
    description: "Optional. true when blocked.",
  }),
  // Lazunox (6.6, H11): dependencias entre tareas de la MISMA lista. `id` es opcional y solo hace falta en las tareas de las que otras dependen.
  id: Schema.optional(Schema.String).annotate({
    description: "Optional. Short unique id, only if another todo depends on this one.",
  }),
  depende_de: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Optional. ids (max 10) of todos in this list to complete first.",
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
