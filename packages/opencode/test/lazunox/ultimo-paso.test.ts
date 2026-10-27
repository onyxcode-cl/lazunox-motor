// Ola 7, 7.10: en el último paso permitido el motor fuerza toolChoice "none" SIN quitar la lista de herramientas (la caché no se rompe).
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { TestInstance } from "../fixture/fixture"
import { TestLLMServer } from "../lib/llm-server"
import { conEntorno, it, proveedor, sesionConPeticion } from "./bucle-util"

const escenario = Effect.fn("test.ultimoPaso")(function* () {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(path.join(dir, "opencode.json"), JSON.stringify({ ...proveedor(llm.url), agent: { build: { steps: 2 } } }))
  const { prompt, session } = yield* sesionConPeticion("haz algo")
  yield* llm.tool("glob", { pattern: "*.nunca" })
  yield* llm.text("resumen final")
  yield* prompt.loop({ sessionID: session.id })
  return (yield* llm.inputs) as { tool_choice?: unknown; tools?: unknown[] }[]
})

describe("7.10 último paso sin herramientas", () => {
  it.instance("el paso 2 de 2 va con tool_choice none y conserva la lista de herramientas; el 1 no", () =>
    conEntorno("LAZUNOX_ULTIMO_PASO_SIN_HERRAMIENTAS", undefined, () =>
      Effect.gen(function* () {
        const [uno, dos] = yield* escenario()
        expect(uno!.tool_choice).toBe("auto")
        expect(dos!.tool_choice).toBe("none")
        expect(Array.isArray(dos!.tools) && dos!.tools!.length > 0).toBe(true)
        expect(JSON.stringify(dos!.tools)).toBe(JSON.stringify(uno!.tools))
      }),
    ),
  )
  it.instance("HOY (interruptor apagado): el último paso deja las herramientas en automático", () =>
    conEntorno("LAZUNOX_ULTIMO_PASO_SIN_HERRAMIENTAS", "0", () =>
      Effect.gen(function* () {
        const [, dos] = yield* escenario()
        expect(dos!.tool_choice).toBe("auto")
      }),
    ),
  )
})
