// Q28: lo que se ENVÍA al modelo sale sin claves por defecto (sin variables de entorno). Antes el nivel 2 del sanitizador (7.5) estaba
// apagado salvo LAZUNOX_SANITIZAR_MODELO=1: la clave salía tapada en pantalla pero viajaba en claro a la IA (hallazgo de T28 del banco).
// Proveedor HTTP falso que graba cada petición; shell real. Las claves son FALSAS.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs"
import path from "path"
import { reply } from "../lib/llm-server"
import { conEntorno, it, sesionConPeticion, todasLasPartes, useServerConfig } from "./bucle-util"

const CLAVE = "sk-FALSAq1w2e3r4t5y6u7i8o9p0aAsSdDfFgGhHjJkKlL"
const COLA = CLAVE.slice(-16)

const sinVars = <A, E, R>(fx: () => Effect.Effect<A, E, R>) =>
  conEntorno("LAZUNOX_SANITIZAR", undefined, () => conEntorno("LAZUNOX_SANITIZAR_MODELO", undefined, fx))

/** Corre una herramienta una vez y devuelve la parte guardada y el texto de cada petición al modelo. */
const correr = (tool: string, args: (dir: string) => Record<string, unknown>, preparar: (dir: string) => void) =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig()
    preparar(dir)
    const { prompt, session } = yield* sesionConPeticion("haz la tarea")
    yield* llm.push(reply().tool(tool, args(dir)))
    yield* llm.text("listo")
    yield* prompt.loop({ sessionID: session.id })
    const { partes } = yield* todasLasPartes(session.id)
    const herr = partes.find((p) => p.type === "tool")
    const enviados = (yield* llm.inputs).map((i) => JSON.stringify((i as { messages?: unknown }).messages ?? ""))
    return { herr, enviados, dir }
  })

const ENTORNO = `export LAZUNOX_REGION=sur\nexport LAZUNOX_API_KEY=${CLAVE}\nexport LAZUNOX_TIMEOUT=30\n`

describe("Q28 el modelo no recibe claves (por defecto)", () => {
  it.instance("(a) bash con `cat .entorno`: la petición siguiente lleva el marcador y no la clave", () =>
    sinVars(() =>
      Effect.gen(function* () {
        const { herr, enviados } = yield* correr(
          "bash",
          () => ({ command: "cat .entorno", description: "Muestra el entorno" }),
          (d) => fs.writeFileSync(path.join(d, ".entorno"), ENTORNO),
        )
        expect(herr?.state.status).toBe("completed")
        if (herr?.state.status !== "completed") return
        expect(enviados).toHaveLength(2)
        expect(enviados[1]).toContain("[REDACTED_SECRET]")
        expect(enviados[1]).not.toContain(COLA)
        // (e) el texto de alrededor se conserva
        expect(enviados[1]).toContain("LAZUNOX_REGION=sur")
        expect(enviados[1]).toContain("LAZUNOX_TIMEOUT=30")
        // lo guardado también va limpio (no queda en disco de la sesión ni se reenvía al reanudar)
        expect(JSON.stringify(herr)).not.toContain(COLA)
        expect(herr.state.output).toContain("LAZUNOX_API_KEY=[REDACTED_SECRET]")
      }),
    ),
  )

  it.instance("(b) read: la clave no llega al modelo; el archivo en disco no cambia", () =>
    sinVars(() =>
      Effect.gen(function* () {
        const { herr, enviados, dir } = yield* correr(
          "read",
          (d) => ({ filePath: path.join(d, ".entorno") }),
          (d) => fs.writeFileSync(path.join(d, ".entorno"), ENTORNO),
        )
        expect(herr?.state.status).toBe("completed")
        expect(enviados).toHaveLength(2)
        expect(enviados[1]).toContain("[REDACTED_SECRET]")
        expect(enviados[1]).not.toContain(COLA)
        expect(enviados[1]).toContain("LAZUNOX_REGION=sur")
        expect(fs.readFileSync(path.join(dir, ".entorno"), "utf-8")).toBe(ENTORNO)
      }),
    ),
  )

  it.instance("(c) env | grep: la clave que imprime `env` no llega al modelo", () =>
    sinVars(() =>
      Effect.gen(function* () {
        const { enviados } = yield* correr(
          "bash",
          () => ({ command: "env | grep '^LAZUNOX_' | sort", description: "Variables" }),
          () => {},
        ).pipe(
          // La variable se pone en el entorno del proceso del motor, que el shell hereda.
          (fx) => conEntorno("LAZUNOX_API_KEY", CLAVE, () => conEntorno("LAZUNOX_REGION", "sur", () => fx)),
        )
        expect(enviados).toHaveLength(2)
        expect(enviados[1]).toContain("LAZUNOX_REGION=sur")
        expect(enviados[1]).toContain("LAZUNOX_API_KEY=[REDACTED_SECRET]")
        expect(enviados[1]).not.toContain(COLA)
      }),
    ),
  )

  it.instance("(c2) printenv de una sola variable: el valor suelto (sin nombre) con forma sk- también se tapa", () =>
    sinVars(() =>
      Effect.gen(function* () {
        const { enviados } = yield* correr(
          "bash",
          () => ({ command: "printenv LAZUNOX_API_KEY", description: "Una variable" }),
          () => {},
        ).pipe((fx) => conEntorno("LAZUNOX_API_KEY", CLAVE, () => fx))
        expect(enviados).toHaveLength(2)
        expect(enviados[1]).toContain("[REDACTED_SECRET]")
        expect(enviados[1]).not.toContain(COLA)
      }),
    ),
  )

  it.instance("(d) salida sin secretos: llega idéntica byte a byte (con tildes, tabuladores y espacios finales)", () =>
    sinVars(() =>
      Effect.gen(function* () {
        const texto = "región=sur\tmodo=pruebas  \nmax_tokens=4096\nBearer of good news\nñandú 日本語\n"
        const { herr, enviados } = yield* correr(
          "bash",
          () => ({ command: "cat plano.txt", description: "Texto plano" }),
          (d) => fs.writeFileSync(path.join(d, "plano.txt"), texto),
        )
        expect(herr?.state.status).toBe("completed")
        if (herr?.state.status !== "completed") return
        expect(herr.state.output).toContain(texto)
        expect(enviados[1]).toContain(JSON.stringify(herr.state.output).slice(1, -1))
        expect(enviados[1]).not.toContain("[REDACTED_SECRET]")
      }),
    ),
  )

  it.instance("determinista: la misma salida da siempre el mismo texto enviado en dos sesiones", () =>
    sinVars(() =>
      Effect.gen(function* () {
        const una = yield* correr("bash", () => ({ command: "cat .entorno", description: "x" }), (d) =>
          fs.writeFileSync(path.join(d, ".entorno"), ENTORNO),
        )
        const otra = yield* correr("bash", () => ({ command: "cat .entorno", description: "x" }), (d) =>
          fs.writeFileSync(path.join(d, ".entorno"), ENTORNO),
        )
        const salida = (h: typeof una.herr) => (h?.state.status === "completed" ? h.state.output : "")
        expect(salida(una.herr)).toBe(salida(otra.herr))
        expect(salida(una.herr)).toContain("[REDACTED_SECRET]")
      }),
    ),
  )

  it.instance("LAZUNOX_SANITIZAR_MODELO=0 devuelve el comportamiento anterior (el modelo recibe la salida tal cual)", () =>
    conEntorno("LAZUNOX_SANITIZAR", undefined, () =>
      conEntorno("LAZUNOX_SANITIZAR_MODELO", "0", () =>
        Effect.gen(function* () {
          const { enviados } = yield* correr(
            "bash",
            () => ({ command: "cat .entorno", description: "x" }),
            (d) => fs.writeFileSync(path.join(d, ".entorno"), ENTORNO),
          )
          expect(enviados[1]).toContain(COLA)
        }),
      ),
    ),
  )
})

describe("Q28 (f) conectores MCP y ayudantes: cualquier herramienta, no solo las de comandos", () => {
  const sin = async <T>(fn: () => Promise<T>) => {
    const a = process.env.LAZUNOX_SANITIZAR
    const b = process.env.LAZUNOX_SANITIZAR_MODELO
    delete process.env.LAZUNOX_SANITIZAR
    delete process.env.LAZUNOX_SANITIZAR_MODELO
    try {
      return await fn()
    } finally {
      if (a !== undefined) process.env.LAZUNOX_SANITIZAR = a
      if (b !== undefined) process.env.LAZUNOX_SANITIZAR_MODELO = b
    }
  }

  test("resultadoParaElModelo tapa la salida de un conector MCP y de un ayudante (task)", async () => {
    const { resultadoParaElModelo } = await import("../../src/session/sanitizar-partes")
    await sin(async () => {
      for (const tool of ["miconector_leer_config", "task", "webfetch", "glob"]) {
        const r = await resultadoParaElModelo(tool, { output: `a=1\nLAZUNOX_API_KEY=${CLAVE}\nb=2`, metadata: {} })
        expect(r.output).toBe("a=1\nLAZUNOX_API_KEY=[REDACTED_SECRET]\nb=2")
      }
    })
  })

  test("textoParaElModelo (lo que guarda el procesador) tapa también conectores MCP", async () => {
    const { textoParaElModelo } = await import("../../src/session/sanitizar-partes")
    await sin(async () => {
      expect(textoParaElModelo("miconector_leer_config", `token: ${CLAVE}`)).not.toContain(COLA)
      const limpio = "nada que tapar\n"
      expect(textoParaElModelo("miconector_leer_config", limpio)).toBe(limpio)
    })
  })
})
