export * as PlanEvent from "./plan-event"

import { Schema } from "effect"
import { Event } from "./event"
import { SessionID } from "./session-id"

// Modo plan para la app (Lazunox 2C, P08). Contrato fijo con la app: `session.plan.listo` llega cuando el agente pide salir
// del modo plan (`plan_exit`) y el motor queda ESPERANDO la decisión de la persona (una pregunta pendiente, con las dos
// opciones fijas de PLAN_OPCIONES); `session.plan.decidido` cierra ese ciclo.
export const Listo = Event.define({
  type: "session.plan.listo",
  schema: {
    sessionID: SessionID,
    messageID: Schema.optional(Schema.String),
    callID: Schema.optional(Schema.String),
    ruta: Schema.String.annotate({ description: "Ruta del plan relativa a la carpeta del proyecto (o absoluta si vive fuera)" }),
    rutaAbsoluta: Schema.String,
    contenido: Schema.String.annotate({ description: "Texto del plan, acotado a 48 KB" }),
    truncado: Schema.Boolean,
    bytes: Schema.Number,
  },
})

export const Decidido = Event.define({
  type: "session.plan.decidido",
  schema: {
    sessionID: SessionID,
    callID: Schema.optional(Schema.String),
    decision: Schema.Literals(["aprobado", "seguir"]),
    ruta: Schema.String,
  },
})

export const Definitions = Event.inventory(Listo, Decidido)
