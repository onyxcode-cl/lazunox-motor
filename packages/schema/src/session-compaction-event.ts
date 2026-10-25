export * as SessionCompactionEvent from "./session-compaction-event"

import { Event } from "./event"
import { SessionID } from "./session-id"
import { Schema } from "effect"

export const Compacted = Event.define({
  type: "session.compacted",
  schema: {
    sessionID: SessionID,
    // Lazunox: métricas opcionales (solo cifras y etiquetas, nunca contenido). Un motor sin ellas emite solo sessionID.
    auto: Schema.optional(Schema.Boolean),
    parcial: Schema.optional(Schema.Boolean),
    mensajes: Schema.optional(Schema.Number),
    tokensAntes: Schema.optional(Schema.Number),
    tokensDespues: Schema.optional(Schema.Number),
    reinyectado: Schema.optional(Schema.Array(Schema.String)),
  },
})

export const Definitions = Event.inventory(Compacted)
