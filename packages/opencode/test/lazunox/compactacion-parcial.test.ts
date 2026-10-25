import { describe, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionCompaction } from "../../src/session/compaction"
import { MessageV2 } from "../../src/session/message-v2"
import { Session as SessionNs } from "@/session/session"
import { MessageID } from "../../src/session/schema"
import {
  assistantMsg,
  cfg,
  compactionMarker,
  itCompaction,
  llm,
  plano,
  reply,
  userMsg,
  wide,
  withCompaction,
} from "./compactacion-util"

// Plan PLAN-REBOBINAR-Y-COMPACTACION.md, C1: «compactar hasta aquí» (upTo) en la ruta manual, métricas y cola elegida por la persona.

/** Sesión con 4 turnos: u1 a1 u2 a2 u3 a3 u4 a4. El último asistente informa 5000 tokens reales. */
const sesionConCuatroTurnos = (relleno = "") =>
  Effect.gen(function* () {
    const ssn = yield* SessionNs.Service
    const session = yield* ssn.create({})
    const u: Array<{ id: MessageID }> = []
    for (let i = 1; i <= 4; i++) {
      const um = yield* userMsg(session.id, `TURNO-${i} ${relleno}`)
      u.push(um)
      yield* assistantMsg(session.id, um.id, { text: `RESPUESTA-${i}`, tokens: i === 4 ? 5000 : 100 })
    }
    return { session, u }
  })

describe("compactar hasta aquí (upTo)", () => {
  itCompaction.instance(
    "resume exactamente lo anterior a upTo y conserva la cola intacta, sin llamar a select",
    () => {
      const stub = llm()
      stub.push(reply("RESUMEN-PARCIAL"))
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const { session, u } = yield* sesionConCuatroTurnos()
        yield* SessionCompaction.use.validateUpTo({ sessionID: session.id, upTo: u[2]!.id, model: { providerID: "test" as never, modelID: "test-model" as never } })
        yield* SessionCompaction.use.create({ sessionID: session.id, agent: "build", model: { providerID: "test" as never, modelID: "test-model" as never }, auto: false, tail: u[2]!.id })
        const msgs = yield* ssn.messages({ sessionID: session.id })
        const parent = msgs.at(-1)!
        const res = yield* SessionCompaction.use.process({ parentID: parent.info.id, messages: msgs, sessionID: session.id, auto: false })
        expect(res).toBe("continue")

        // La petición de resumen lleva SOLO los dos primeros turnos.
        const pedido = plano(stub.peticiones[0]!)
        for (const x of ["TURNO-1", "RESPUESTA-1", "TURNO-2", "RESPUESTA-2"]) expect(pedido).toContain(x)
        for (const x of ["TURNO-3", "RESPUESTA-3", "TURNO-4", "RESPUESTA-4"]) expect(pedido).not.toContain(x)

        // La parte guarda la cola elegida y la marca manual.
        const marcador = (yield* ssn.messages({ sessionID: session.id })).find((m) => m.info.id === parent.info.id)!
        const parte = marcador.parts.find((p) => p.type === "compaction")!
        expect(parte.type === "compaction" && parte.tail_start_id).toBe(u[2]!.id)
        expect(parte.type === "compaction" && parte.manual_tail).toBe(true)

        // Lo que verá el modelo después: [compaction, resumen, u3, a3, u4, a4] (la cola íntegra y en orden).
        const visibles = yield* MessageV2.filterCompactedEffect(session.id)
        const texto = visibles.map((m) => m.parts.map((p) => (p.type === "text" ? p.text : p.type)).join("|"))
        expect(visibles[0]!.info.id).toBe(parent.info.id)
        expect(texto[1]).toContain("RESUMEN-PARCIAL")
        expect(texto.slice(2).join("\n")).toContain("TURNO-3")
        expect(texto.slice(2).join("\n")).toContain("RESPUESTA-4")
        expect(texto.join("\n")).not.toContain("TURNO-1")
      }).pipe(withCompaction({ llm: stub.llmLayer }))
    },
    { git: true },
  )

  itCompaction.instance(
    "upTo inválido: inexistente, de un asistente, el primero o un marcador → error invalido",
    () => {
      const stub = llm()
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const { session, u } = yield* sesionConCuatroTurnos()
        const modelo = { providerID: "test" as never, modelID: "test-model" as never }
        const validar = (upTo: MessageID) => Effect.exit(SessionCompaction.use.validateUpTo({ sessionID: session.id, upTo, model: modelo }))
        const razon = (exit: Exit.Exit<void, SessionCompaction.UpToError>) =>
          Exit.isFailure(exit) ? (JSON.stringify(exit.cause).match(/"razon":"([a-z-]+)"/)?.[1] ?? "?") : "ok"

        expect(razon(yield* validar(MessageID.ascending()))).toBe("invalido")
        const asistente = (yield* ssn.messages({ sessionID: session.id })).find((m) => m.info.role === "assistant")!
        expect(razon(yield* validar(asistente.info.id))).toBe("invalido")
        expect(razon(yield* validar(u[0]!.id))).toBe("invalido")
        const marcador = yield* compactionMarker(session.id)
        expect(razon(yield* validar(marcador.id))).toBe("invalido")
        // Uno válido sigue pasando.
        expect(razon(yield* validar(u[1]!.id))).toBe("ok")
      }).pipe(withCompaction({ llm: stub.llmLayer }))
    },
    { git: true },
  )

  itCompaction.instance(
    "una cola que pasa del 60 % de lo usable se rechaza con un error claro (cola-grande)",
    () => {
      const stub = llm()
      return Effect.gen(function* () {
        const { session, u } = yield* sesionConCuatroTurnos("x".repeat(8_000))
        const modelo = { providerID: "test" as never, modelID: "test-model" as never }
        const dos = yield* Effect.exit(SessionCompaction.use.validateUpTo({ sessionID: session.id, upTo: u[1]!.id, model: modelo }))
        expect(Exit.isFailure(dos)).toBe(true)
        expect(JSON.stringify(dos)).toContain("cola-grande")
        expect(JSON.stringify(dos)).toContain("elige un mensaje más reciente")
        // Con solo el último turno sí cabe (~2000 tokens < 60 % de 8000).
        const uno = yield* Effect.exit(SessionCompaction.use.validateUpTo({ sessionID: session.id, upTo: u[3]!.id, model: modelo }))
        expect(Exit.isSuccess(uno)).toBe(true)
      }).pipe(withCompaction({ llm: stub.llmLayer, provider: wide(10_000, 2_000) }))
    },
    { git: true },
  )

  itCompaction.instance(
    "el evento y la parte compaction llevan las métricas (tokensAntes > tokensDespues) y ninguna lleva contenido",
    () => {
      const stub = llm()
      stub.push(reply("RESUMEN-CORTO"))
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const events = yield* EventV2Bridge.Service
        const visto: Array<Record<string, unknown>> = []
        const off = yield* events.listen((evt) => {
          if (evt.type === SessionCompaction.Event.Compacted.type) visto.push(evt.data as Record<string, unknown>)
          return Effect.void
        })
        yield* Effect.addFinalizer(() => off)
        const { session, u } = yield* sesionConCuatroTurnos()
        yield* SessionCompaction.use.create({ sessionID: session.id, agent: "build", model: { providerID: "test" as never, modelID: "test-model" as never }, auto: false, tail: u[2]!.id })
        const msgs = yield* ssn.messages({ sessionID: session.id })
        yield* SessionCompaction.use.process({ parentID: msgs.at(-1)!.info.id, messages: msgs, sessionID: session.id, auto: false })

        expect(visto.length).toBe(1)
        const e = visto[0]!
        expect(e.sessionID).toBe(session.id)
        expect(e).toMatchObject({ auto: false, parcial: true, mensajes: 4, tokensAntes: 5000 })
        expect(e.tokensDespues as number).toBeGreaterThan(0)
        expect(e.tokensDespues as number).toBeLessThan(e.tokensAntes as number)
        expect(e.reinyectado).toEqual([])
        expect(JSON.stringify(e)).not.toContain("TURNO-")
        expect(JSON.stringify(e)).not.toContain("RESUMEN-CORTO")

        const parte = (yield* ssn.messages({ sessionID: session.id })).find((m) => m.info.id === msgs.at(-1)!.info.id)!.parts.find((p) => p.type === "compaction")
        expect(parte && parte.type === "compaction" && parte.lazunox).toEqual({
          auto: false,
          parcial: true,
          mensajes: 4,
          tokensAntes: 5000,
          tokensDespues: e.tokensDespues as number,
          reinyectado: [],
        })
      }).pipe(withCompaction({ llm: stub.llmLayer }))
    },
    { git: true },
  )

  itCompaction.instance(
    "sin upTo el comportamiento es el de siempre: no hay manual_tail y la cola sale del presupuesto",
    () => {
      const stub = llm()
      stub.push(reply("RESUMEN"))
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const { session } = yield* sesionConCuatroTurnos()
        yield* SessionCompaction.use.create({ sessionID: session.id, agent: "build", model: { providerID: "test" as never, modelID: "test-model" as never }, auto: false })
        const msgs = yield* ssn.messages({ sessionID: session.id })
        yield* SessionCompaction.use.process({ parentID: msgs.at(-1)!.info.id, messages: msgs, sessionID: session.id, auto: false })
        const parte = (yield* ssn.messages({ sessionID: session.id })).find((m) => m.info.id === msgs.at(-1)!.info.id)!.parts.find((p) => p.type === "compaction")!
        expect(parte.type === "compaction" && parte.manual_tail).toBeUndefined()
        expect(parte.type === "compaction" && parte.lazunox?.parcial).toBe(false)
      }).pipe(withCompaction({ llm: stub.llmLayer, config: cfg({ tail_turns: 2, preserve_recent_tokens: 10_000 }) }))
    },
    { git: true },
  )

  itCompaction.instance(
    "dos compactaciones parciales seguidas: la segunda no vuelve a resumir lo ya resumido",
    () => {
      const stub = llm()
      stub.push(reply("RESUMEN-UNO"))
      stub.push(reply("RESUMEN-DOS"))
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const modelo = { providerID: "test" as never, modelID: "test-model" as never }
        const { session, u } = yield* sesionConCuatroTurnos()
        yield* SessionCompaction.use.create({ sessionID: session.id, agent: "build", model: modelo, auto: false, tail: u[1]!.id })
        let msgs = yield* ssn.messages({ sessionID: session.id })
        yield* SessionCompaction.use.process({ parentID: msgs.at(-1)!.info.id, messages: msgs, sessionID: session.id, auto: false })

        // Ahora u3 sigue siendo visible: «hasta aquí» sobre u3 resume (resumen 1 + u2/a2) y conserva u3 en adelante.
        yield* SessionCompaction.use.validateUpTo({ sessionID: session.id, upTo: u[2]!.id, model: modelo })
        yield* SessionCompaction.use.create({ sessionID: session.id, agent: "build", model: modelo, auto: false, tail: u[2]!.id })
        msgs = yield* MessageV2.filterCompactedEffect(session.id)
        yield* SessionCompaction.use.process({ parentID: msgs.at(-1)!.info.id, messages: msgs, sessionID: session.id, auto: false })

        const segundo = plano(stub.peticiones[1]!)
        expect(segundo).toContain("RESUMEN-UNO")
        expect(segundo).toContain("TURNO-2")
        expect(segundo).not.toContain("TURNO-3")
        const vistos = (yield* MessageV2.filterCompactedEffect(session.id)).map((m) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ")).join("\n")
        expect(vistos).toContain("RESUMEN-DOS")
        expect(vistos).toContain("TURNO-3")
        expect(vistos).not.toContain("TURNO-1")
      }).pipe(withCompaction({ llm: stub.llmLayer }))
    },
    { git: true },
  )
})
