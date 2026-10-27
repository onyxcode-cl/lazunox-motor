// Ola 7, 7.9: casos de borde de la compactación (Codex y OpenCode 2.x): un resumen vacío es un error (no queda un resumen parcial),
// si la petición de resumen desborda el contexto se reintenta con una conversación más corta, y un resumen cortado por el límite de
// salida se marca como incompleto. `LAZUNOX_COMPACTACION_SEGURA=0` documenta el comportamiento de antes.
import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import * as Stream from "effect/Stream"
import { APICallError } from "ai"
import { LLMEvent, Usage } from "@opencode-ai/llm"
import { SessionCompaction } from "../../src/session/compaction"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { assistantMsg, itCompaction, llm, plano, reply, userMsg, withCompaction } from "./compactacion-util"

const model = { providerID: "test" as never, modelID: "test-model" as never }
const usage = () => new Usage({ inputTokens: 1, outputTokens: 1, totalTokens: 2 })

afterEach(() => {
  delete process.env.LAZUNOX_COMPACTACION_SEGURA
})

/** Respuesta que termina sin ningún texto. */
const vacia = () => () =>
  Stream.make(LLMEvent.stepFinish({ index: 0, reason: "stop", usage: usage() }), LLMEvent.finish({ reason: "stop", usage: usage() }))

/** Respuesta con texto cortada por el límite de salida. */
const cortadaPorLongitud = (text: string) => () =>
  Stream.make(
    LLMEvent.textStart({ id: "txt-0" }),
    LLMEvent.textDelta({ id: "txt-0", text }),
    LLMEvent.textEnd({ id: "txt-0" }),
    LLMEvent.stepFinish({ index: 0, reason: "length", usage: usage() }),
    LLMEvent.finish({ reason: "length", usage: usage() }),
  )

/** El proveedor rechaza la petición por tamaño (413). */
const desborda = () => () => {
  throw new APICallError({ message: "prompt is too long: 300000 tokens > 200000 maximum", url: "http://x", requestBodyValues: {}, statusCode: 413, responseBody: "{}" })
}

const compactar = (sessionID: any) =>
  Effect.gen(function* () {
    const ssn = yield* SessionNs.Service
    yield* SessionCompaction.use.create({ sessionID, agent: "build", model, auto: false })
    const msgs = yield* ssn.messages({ sessionID })
    const parent = msgs.at(-1)!
    const res = yield* SessionCompaction.use.process({ parentID: parent.info.id, messages: msgs, sessionID, auto: false })
    const despues = yield* ssn.messages({ sessionID })
    const resumenes = despues.filter((m) => m.info.role === "assistant" && (m.info as any).summary)
    // Lo que vería el modelo en el turno siguiente.
    const visibles = yield* MessageV2.filterCompactedEffect(sessionID)
    return { res, resumenes, visibles }
  })

const sesion = (turnos = 3, relleno = "") =>
  Effect.gen(function* () {
    const ssn = yield* SessionNs.Service
    const session = yield* ssn.create({})
    for (let i = 1; i <= turnos; i++) {
      const u = yield* userMsg(session.id, `TURNO-${i} ${relleno}`)
      yield* assistantMsg(session.id, u.id, { text: `RESPUESTA-${i}`, tokens: 100 })
    }
    return session
  })

const textoDe = (m: any) => m.parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("")

describe("7.9 compactación: casos de borde", () => {
  itCompaction.instance(
    "resumen VACÍO: es un error, no reemplaza el historial y el modelo sigue viendo la conversación",
    () => {
      const stub = llm()
      stub.push(vacia())
      return Effect.gen(function* () {
        const session = yield* sesion()
        const { res, resumenes, visibles } = yield* compactar(session.id)
        expect(res).toBe("stop")
        expect(resumenes).toHaveLength(1)
        const info = resumenes[0]!.info as any
        expect(info.finish).toBe("error")
        expect(JSON.stringify(info.error)).toContain("resumen vacío")
        // El historial anterior sigue visible (la compactación no cortó nada).
        expect(JSON.stringify(visibles)).toContain("RESPUESTA-1")
      }).pipe(withCompaction({ llm: stub.llmLayer }))
    },
    { git: true },
  )

  itCompaction.instance(
    "HOY (LAZUNOX_COMPACTACION_SEGURA=0): un resumen vacío cuenta como éxito y corta el historial",
    () => {
      process.env.LAZUNOX_COMPACTACION_SEGURA = "0"
      const stub = llm()
      stub.push(vacia())
      return Effect.gen(function* () {
        const session = yield* sesion()
        const { res, visibles } = yield* compactar(session.id)
        expect(res).toBe("continue")
        expect(JSON.stringify(visibles)).not.toContain("RESPUESTA-1")
      }).pipe(withCompaction({ llm: stub.llmLayer }))
    },
    { git: true },
  )

  itCompaction.instance(
    "resumen solo con espacios también es vacío",
    () => {
      const stub = llm()
      stub.push(reply("   \n  "))
      return Effect.gen(function* () {
        const session = yield* sesion()
        const { res, resumenes } = yield* compactar(session.id)
        expect(res).toBe("stop")
        expect((resumenes[0]!.info as any).finish).toBe("error")
      }).pipe(withCompaction({ llm: stub.llmLayer }))
    },
    { git: true },
  )

  itCompaction.instance(
    "la petición de resumen desborda el contexto: reintenta con una conversación MÁS CORTA y termina bien",
    () => {
      const stub = llm()
      stub.push(desborda())
      stub.push(reply("## Objective\nok"))
      return Effect.gen(function* () {
        const session = yield* sesion(8, "palabra ".repeat(300))
        const { res, resumenes, visibles } = yield* compactar(session.id)
        expect(res).toBe("continue")
        expect(stub.peticiones.length).toBe(2)
        // La segunda petición lleva menos conversación que la primera y ya no incluye lo más antiguo.
        expect(plano(stub.peticiones[1]!).length).toBeLessThan(plano(stub.peticiones[0]!).length)
        expect(plano(stub.peticiones[0]!)).toContain("TURNO-1")
        expect(plano(stub.peticiones[1]!)).not.toContain("TURNO-1 ")
        // Queda UN solo resumen válido (el del primer intento se retira).
        expect(resumenes).toHaveLength(1)
        expect(textoDe(resumenes[0])).toContain("## Objective")
        expect((resumenes[0]!.info as any).error).toBeUndefined()
        expect(visibles.length).toBeGreaterThan(0)
      }).pipe(withCompaction({ llm: stub.llmLayer }))
    },
    { git: true },
  )

  itCompaction.instance(
    "desborda siempre: tras 3 reintentos se rinde con el error de siempre y nada se pierde",
    () => {
      const stub = llm()
      for (let i = 0; i < 6; i++) stub.push(desborda())
      return Effect.gen(function* () {
        const session = yield* sesion(8, "palabra ".repeat(300))
        const { res, resumenes, visibles } = yield* compactar(session.id)
        expect(res).toBe("stop")
        expect(stub.peticiones.length).toBe(4)
        expect(resumenes).toHaveLength(1)
        expect(JSON.stringify((resumenes[0]!.info as any).error)).toContain("too large to compact")
        expect(JSON.stringify(visibles)).toContain("RESPUESTA-1")
      }).pipe(withCompaction({ llm: stub.llmLayer }))
    },
    { git: true },
  )

  itCompaction.instance(
    "HOY (interruptor apagado): el desbordamiento del resumen no se reintenta",
    () => {
      process.env.LAZUNOX_COMPACTACION_SEGURA = "0"
      const stub = llm()
      stub.push(desborda())
      stub.push(reply("## Objective\nok"))
      return Effect.gen(function* () {
        const session = yield* sesion(8, "palabra ".repeat(300))
        const { res } = yield* compactar(session.id)
        expect(res).toBe("stop")
        expect(stub.peticiones.length).toBe(1)
      }).pipe(withCompaction({ llm: stub.llmLayer }))
    },
    { git: true },
  )

  itCompaction.instance(
    "resumen cortado por el límite de salida: se acepta (mejor que dejar la sesión atascada) pero se marca incompleto",
    () => {
      const stub = llm()
      stub.push(cortadaPorLongitud("## Objective\nmitad del resumen"))
      return Effect.gen(function* () {
        const session = yield* sesion()
        const { res, resumenes } = yield* compactar(session.id)
        expect(res).toBe("continue")
        const t = resumenes[0]!.parts.find((p) => p.type === "text") as any
        expect(t.metadata?.lazunox_resumen).toBe("incompleto")
        expect(t.text).toContain("mitad del resumen")
      }).pipe(withCompaction({ llm: stub.llmLayer }))
    },
    { git: true },
  )

  itCompaction.instance(
    "un resumen normal no cambia: una petición, sin marca",
    () => {
      const stub = llm()
      stub.push(reply("## Objective\nbien"))
      return Effect.gen(function* () {
        const session = yield* sesion()
        const { res, resumenes } = yield* compactar(session.id)
        expect(res).toBe("continue")
        expect(stub.peticiones.length).toBe(1)
        const t = resumenes[0]!.parts.find((p) => p.type === "text") as any
        expect(t.metadata?.lazunox_resumen).toBeUndefined()
      }).pipe(withCompaction({ llm: stub.llmLayer }))
    },
    { git: true },
  )
})
