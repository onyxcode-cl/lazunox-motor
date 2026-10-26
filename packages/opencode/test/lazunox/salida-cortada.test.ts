// Lazunox (Ola 7, 7.4): respuesta cortada por el límite de salida. Bucle real + AI SDK contra un proveedor HTTP falso que devuelve
// `finish_reason: "length"` a mitad de los argumentos de una llamada. Incluye la prueba que documenta lo que hace el motor SIN el mecanismo.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs"
import path from "path"
import { reply, type Item } from "../lib/llm-server"
import * as SalidaCortada from "../../src/session/salida-cortada"
import { conEntorno, it, sesionConPeticion, todasLasPartes, useServerConfig } from "./bucle-util"

// ---------------------------------------------------------------- núcleo puro
describe("salida cortada (núcleo)", () => {
  test("argumentos: vacío no cuenta, JSON completo no, JSON cortado sí", () => {
    expect(SalidaCortada.argumentosIncompletos("")).toBe(false)
    expect(SalidaCortada.argumentosIncompletos('{"a":1}')).toBe(false)
    expect(SalidaCortada.argumentosIncompletos('{"a":"x')).toBe(true)
  })
  test("el mensaje pide dividir y recorta el extracto a 2048", () => {
    const crudo = '{"content":"' + "x".repeat(5000)
    const m = SalidaCortada.mensajeHerramienta("write", crudo)
    expect(m).toContain("NO se ejecutó")
    expect(m).toContain("Divide el trabajo")
    expect(m).toContain(`primeros 2048 de ${crudo.length}`)
    expect(m).toContain("[recortado]")
    expect(m.includes(crudo)).toBe(false)
    expect(m).toContain(crudo.slice(0, 2048))
  })
  test("racha: cuenta cortes seguidos, los avisos propios no la rompen, la persona sí", () => {
    const a = (finish: string) => ({ info: { role: "assistant", finish }, parts: [] })
    const aviso = { info: { role: "user" }, parts: [{ type: "text", metadata: { [SalidaCortada.MARCA]: "aviso" } }] }
    const persona = { info: { role: "user" }, parts: [{ type: "text" }] }
    expect(SalidaCortada.racha([a("length"), aviso, a("length"), aviso, a("length")])).toBe(3)
    expect(SalidaCortada.racha([a("length"), a("length"), a("tool-calls"), a("length")])).toBe(1)
    expect(SalidaCortada.racha([a("length"), a("length"), persona])).toBe(0)
    expect(SalidaCortada.racha([a("length"), persona, a("length")])).toBe(1)
    expect(SalidaCortada.racha([a("stop")])).toBe(0)
  })
  test("interruptor", () => {
    expect(SalidaCortada.activo({})).toBe(true)
    expect(SalidaCortada.activo({ LAZUNOX_SALIDA_CORTADA: "1" })).toBe(true)
    expect(SalidaCortada.activo({ LAZUNOX_SALIDA_CORTADA: "0" })).toBe(false)
  })
})

// ---------------------------------------------------------------- bucle real
const lineaFin = (usage?: { input: number; output: number }) => ({
  id: "chatcmpl-test",
  object: "chat.completion.chunk",
  choices: [{ delta: {}, finish_reason: "length" }],
  ...(usage ? { usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output } } : {}),
})

/** Respuesta del proveedor cortada por longitud: lo que lleve `r` (texto y/o llamada a medias) seguido de `finish_reason: "length"`. */
const cortada = (r: ReturnType<typeof reply>, usage?: { input: number; output: number }): Item => {
  const base = r.item()
  if (base.type !== "sse") throw new Error("se esperaba SSE")
  return { ...base, tail: [...base.tail, lineaFin(usage)] }
}

const contenidoLargo = "x".repeat(6000)

const mensajesEnviados = (inputs: Record<string, unknown>[]) =>
  inputs.map((i) => JSON.stringify((i as { messages?: unknown }).messages ?? ""))

describe("salida cortada (bucle real)", () => {
  it.instance("HOY (interruptor apagado): la llamada cortada se resuelve como herramienta «invalid»; no hay guía para dividir ni tope", () =>
    conEntorno("LAZUNOX_SALIDA_CORTADA", "0", () =>
      Effect.gen(function* () {
        const { dir, llm } = yield* useServerConfig()
        const { prompt, session } = yield* sesionConPeticion("escribe un archivo grande")
        const destino = path.join(dir, "grande.txt")
        yield* llm.push(cortada(reply().pendingTool("write", { filePath: destino, content: contenidoLargo })))
        yield* llm.text("listo")
        yield* prompt.loop({ sessionID: session.id })

        const { partes } = yield* todasLasPartes(session.id)
        const herr = partes.filter((p) => p.type === "tool")
        expect(herr).toHaveLength(1)
        // Sin el mecanismo: el AI SDK no logra leer los argumentos y la llamada se reescribe a «invalid» (que se ejecuta y "tiene éxito").
        expect(herr[0].tool).toBe("invalid")
        expect(herr[0].state.status).toBe("completed")
        if (herr[0].state.status === "completed") {
          expect(herr[0].state.output).toContain("The arguments provided to the tool are invalid")
          expect(herr[0].state.output).not.toContain("Divide")
        }
        expect(fs.existsSync(destino)).toBe(false)
        expect(yield* llm.calls).toBe(2)
      }),
    ),
  )

  it.instance("llamada con argumentos incompletos: FALLA con guía para dividir y extracto; no se ejecuta ni se repite", () =>
    conEntorno("LAZUNOX_SALIDA_CORTADA", undefined, () =>
      Effect.gen(function* () {
        const { dir, llm } = yield* useServerConfig()
        const { prompt, session } = yield* sesionConPeticion("escribe un archivo grande")
        const destino = path.join(dir, "grande.txt")
        yield* llm.push(cortada(reply().pendingTool("write", { filePath: destino, content: contenidoLargo })))
        yield* llm.text("listo")
        const res = yield* prompt.loop({ sessionID: session.id })

        const { partes } = yield* todasLasPartes(session.id)
        const herr = partes.filter((p) => p.type === "tool")
        expect(herr).toHaveLength(1)
        expect(herr[0].tool).toBe("write")
        expect(herr[0].state.status).toBe("error")
        if (herr[0].state.status === "error") {
          const e = herr[0].state.error
          expect(e).toContain("NO se ejecutó")
          expect(e).toContain("Divide el trabajo")
          expect(e).toContain("primeros 2048 de")
          expect(e).toContain(destino)
          expect(herr[0].state.metadata?.lazunox_salida_cortada).toBe(true)
        }
        // Nada escrito y exactamente 2 peticiones: la cortada y la que ya lleva el error (no hay repetición a ciegas).
        expect(fs.existsSync(destino)).toBe(false)
        expect(yield* llm.calls).toBe(2)
        // El modelo recibe el error como resultado de SU llamada.
        const enviados = mensajesEnviados(yield* llm.inputs)
        expect(enviados[1]).toContain("Divide el trabajo")
        expect(res.parts.some((p) => p.type === "text" && p.text === "listo")).toBe(true)
      }),
    ),
  )

  it.instance("el extracto del error no pasa de 2048 caracteres de lo recibido", () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig()
      const { prompt, session } = yield* sesionConPeticion("escribe")
      const marca = "ZZZ_FIN_QUE_NO_DEBE_APARECER"
      yield* llm.push(cortada(reply().pendingTool("write", { filePath: path.join(dir, "a.txt"), content: contenidoLargo + marca })))
      yield* llm.text("listo")
      yield* prompt.loop({ sessionID: session.id })
      const { partes } = yield* todasLasPartes(session.id)
      const herr = partes.find((p) => p.type === "tool")
      expect(herr?.state.status).toBe("error")
      if (herr?.state.status === "error") {
        expect(herr.state.error).toContain("primeros 2048 de")
        expect(herr.state.error).toContain("[recortado]")
        expect(herr.state.error.length).toBeLessThan(2048 + 800)
        expect(herr.state.error).not.toContain(marca)
      }
    }),
  )

  it.instance("una llamada completa de la misma respuesta cortada conserva su resultado; solo la incompleta falla", () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig()
      const { prompt, session } = yield* sesionConPeticion("busca y escribe")
      fs.writeFileSync(path.join(dir, "uno.txt"), "x")
      const completa = JSON.stringify({ pattern: "*.txt" })
      const parcial = JSON.stringify({ filePath: path.join(dir, "b.txt"), content: contenidoLargo })
      const trozo = (tool_calls: unknown[]) => ({ id: "c", object: "chat.completion.chunk", choices: [{ delta: { tool_calls } }] })
      yield* llm.push({
        type: "sse",
        head: [{ id: "c", object: "chat.completion.chunk", choices: [{ delta: { role: "assistant" } }] }],
        tail: [
          trozo([{ index: 0, id: "call_a", type: "function", function: { name: "glob", arguments: completa } }]),
          trozo([{ index: 1, id: "call_b", type: "function", function: { name: "write", arguments: "" } }]),
          trozo([{ index: 1, function: { arguments: parcial.slice(0, 200) } }]),
          lineaFin(),
        ],
      } as Item)
      yield* llm.text("listo")
      yield* prompt.loop({ sessionID: session.id })
      const { partes } = yield* todasLasPartes(session.id)
      const glob = partes.find((p) => p.type === "tool" && p.tool === "glob")
      const write = partes.find((p) => p.type === "tool" && p.tool === "write")
      expect(glob?.type === "tool" && glob.state.status).toBe("completed")
      expect(write?.type === "tool" && write.state.status).toBe("error")
      expect(fs.existsSync(path.join(dir, "b.txt"))).toBe(false)
    }),
  )

  it.instance("sin llamadas: se inyecta el aviso sintético y la respuesta siguiente lo recibe", () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig()
      const { prompt, session } = yield* sesionConPeticion("cuéntame todo")
      yield* llm.push(cortada(reply().text("parte uno del texto")))
      yield* llm.text("resumen corto")
      const res = yield* prompt.loop({ sessionID: session.id })

      expect(yield* llm.calls).toBe(2)
      const enviados = mensajesEnviados(yield* llm.inputs)
      expect(enviados[0]).not.toContain("límite de salida")
      expect(enviados[1]).toContain("llegó al límite de salida")
      const { msgs } = yield* todasLasPartes(session.id)
      const avisos = msgs.filter(
        (m) => m.info.role === "user" && m.parts.some((p) => p.type === "text" && p.metadata?.[SalidaCortada.MARCA] === "aviso"),
      )
      expect(avisos).toHaveLength(1)
      expect(res.parts.some((p) => p.type === "text" && p.text === "resumen corto")).toBe(true)
    }),
  )

  it.instance("3 respuestas seguidas cortadas: falla con error propio y no pide una cuarta", () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig()
      const { prompt, session } = yield* sesionConPeticion("cuéntame todo")
      yield* llm.push(cortada(reply().text("a")), cortada(reply().text("b")), cortada(reply().text("c")))
      yield* llm.text("no debería llegar")
      const res = yield* prompt.loop({ sessionID: session.id })

      expect(yield* llm.calls).toBe(3)
      expect(res.info.role).toBe("assistant")
      if (res.info.role === "assistant") {
        expect(res.info.finish).toBe("length")
        expect((res.info.error?.data as { message?: string } | undefined)?.message).toBe(SalidaCortada.ERROR_RACHA)
      }
    }),
  )

  it.instance("con llamadas incompletas también cuenta la racha (3 pasos cortados seguidos)", () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig()
      const { prompt, session } = yield* sesionConPeticion("escribe")
      const corte = () => cortada(reply().pendingTool("write", { filePath: path.join(dir, "a.txt"), content: contenidoLargo }))
      yield* llm.push(corte(), corte(), corte())
      yield* llm.text("no debería llegar")
      const res = yield* prompt.loop({ sessionID: session.id })
      expect(yield* llm.calls).toBe(3)
      if (res.info.role === "assistant") expect((res.info.error?.data as { message?: string } | undefined)?.message).toBe(SalidaCortada.ERROR_RACHA)
      expect(fs.existsSync(path.join(dir, "a.txt"))).toBe(false)
    }),
  )

  it.instance("interruptor apagado: sin llamadas el turno termina cortado, sin aviso ni error propio", () =>
    conEntorno("LAZUNOX_SALIDA_CORTADA", "0", () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig()
        const { prompt, session } = yield* sesionConPeticion("cuéntame todo")
        yield* llm.push(cortada(reply().text("parte uno")))
        yield* llm.text("no debería llegar")
        const res = yield* prompt.loop({ sessionID: session.id })
        expect(yield* llm.calls).toBe(1)
        if (res.info.role === "assistant") {
          expect(res.info.finish).toBe("length")
          expect(res.info.error).toBeUndefined()
        }
      }),
    ),
  )
})
