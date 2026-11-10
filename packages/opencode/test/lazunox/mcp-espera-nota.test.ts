// Lazunox (Q1.1): mientras haya conectores MCP conectando, el modelo recibe una nota corta con sus nombres (fuera del sistema fijo);
// cuando terminan, la nota desaparece.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Session } from "@/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { it, mcpPendientes, sesionConPeticion, useServerConfig } from "./bucle-util"

type Entrada = { messages?: { role: string }[] }
const sistemaDe = (input: Record<string, unknown>) =>
  JSON.stringify(((input as Entrada).messages ?? []).filter((m) => m.role === "system"))
const restoDe = (input: Record<string, unknown>) =>
  JSON.stringify(((input as Entrada).messages ?? []).filter((m) => m.role !== "system"))

describe("Q1.1 nota de conectores conectando (bucle real)", () => {
  it.instance("con un conector pendiente hay nota (no en el sistema); al terminar ya no", () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig()
      mcpPendientes.nombres = ["lento", "alfa"]
      const a = yield* sesionConPeticion("hola")
      yield* llm.text("listo")
      yield* a.prompt.loop({ sessionID: a.session.id })

      mcpPendientes.nombres = []
      const b = yield* sesionConPeticion("otra vez")
      yield* llm.text("listo")
      yield* b.prompt.loop({ sessionID: b.session.id })

      const inputs = (yield* llm.inputs).filter((i) => ((i as { tools?: unknown[] }).tools ?? []).length > 0)
      expect(inputs.length).toBeGreaterThanOrEqual(2)
      const primera = inputs[0]!
      const ultima = inputs[inputs.length - 1]!
      expect(restoDe(primera)).toContain("alfa, lento")
      expect(sistemaDe(primera)).not.toContain("conectando")
      expect(restoDe(ultima)).not.toContain("conectando")
    }).pipe(Effect.ensuring(Effect.sync(() => void (mcpPendientes.nombres = [])))),
  )

  it.instance("la nota omite los conectores cuyas herramientas el agente tiene negadas por permisos", () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig()
      mcpPendientes.nombres = ["lento", "alfa"]
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      // `lento_*` negado para toda la sesión; `alfa` sigue permitido.
      const session = yield* sessions.create({
        title: "Lazunox",
        permission: [
          { permission: "*", pattern: "*", action: "allow" },
          { permission: "lento_*", pattern: "*", action: "deny" },
        ],
      })
      yield* prompt.prompt({ sessionID: session.id, agent: "build", noReply: true, parts: [{ type: "text", text: "hola" }] })
      yield* llm.text("listo")
      yield* prompt.loop({ sessionID: session.id })
      const inputs = (yield* llm.inputs).filter((i) => ((i as { tools?: unknown[] }).tools ?? []).length > 0)
      const nota = restoDe(inputs[0]!)
      expect(nota).toContain("conectando: alfa.")
      expect(nota).not.toContain("lento")
    }).pipe(Effect.ensuring(Effect.sync(() => void (mcpPendientes.nombres = [])))),
  )

  it.instance("si todos los pendientes están negados no hay nota", () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig()
      mcpPendientes.nombres = ["lento"]
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Lazunox",
        permission: [
          { permission: "*", pattern: "*", action: "allow" },
          { permission: "lento_*", pattern: "*", action: "deny" },
        ],
      })
      yield* prompt.prompt({ sessionID: session.id, agent: "build", noReply: true, parts: [{ type: "text", text: "hola" }] })
      yield* llm.text("listo")
      yield* prompt.loop({ sessionID: session.id })
      const inputs = (yield* llm.inputs).filter((i) => ((i as { tools?: unknown[] }).tools ?? []).length > 0)
      expect(restoDe(inputs[0]!)).not.toContain("conectando")
    }).pipe(Effect.ensuring(Effect.sync(() => void (mcpPendientes.nombres = [])))),
  )
})
