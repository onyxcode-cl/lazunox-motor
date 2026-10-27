// Ola 7, 7.5: cableado del sanitizador en el bucle real (proveedor HTTP falso, shell real). Reproduce la tarea T28 del banco:
// un guion imprime una clave FALSA conocida al hacer `env` y se mira qué quedó mostrado/guardado y qué vio el modelo.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs"
import path from "path"
import { reply } from "../lib/llm-server"
import { conEntorno, it, sesionConPeticion, todasLasPartes, useServerConfig } from "./bucle-util"

const CLAVE = "sk-FALSAq1w2e3r4t5y6u7i8o9p0aAsSdDfFgGhHjJkKlL"
const COLA = CLAVE.slice(-16)

const conVars = <A, E, R>(vars: Record<string, string | undefined>, fx: () => Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Object.entries(vars).reduceRight(
    (acc, [k, v]) => () => conEntorno(k, v, acc),
    fx,
  )()

const correrT28 = Effect.gen(function* () {
  const { dir, llm } = yield* useServerConfig()
  fs.writeFileSync(path.join(dir, ".entorno"), `export LAZUNOX_REGION=sur\nexport LAZUNOX_API_KEY=${CLAVE}\n`)
  fs.writeFileSync(path.join(dir, "diagnostico.sh"), `. ./.entorno\nenv | sort | grep '^LAZUNOX_'\n`)
  const { prompt, session } = yield* sesionConPeticion("corre el diagnóstico y dime las variables")
  yield* llm.push(reply().tool("bash", { command: "sh diagnostico.sh", description: "Diagnóstico del entorno" }))
  yield* llm.text("listo")
  yield* prompt.loop({ sessionID: session.id })
  const { partes } = yield* todasLasPartes(session.id)
  const herr = partes.find((p) => p.type === "tool")
  const enviados = (yield* llm.inputs).map((i) => JSON.stringify((i as { messages?: unknown }).messages ?? ""))
  return { herr, enviados, dir }
})

describe("7.5 sanitizador en el bucle real (T28)", () => {
  it.instance("LAZUNOX_SANITIZAR_MODELO=1: la clave leída con `read` tampoco llega al modelo (hueco hallado por el banco)", () =>
    conVars({ LAZUNOX_SANITIZAR: undefined, LAZUNOX_SANITIZAR_MODELO: "1" }, () =>
      Effect.gen(function* () {
        const { dir, llm } = yield* useServerConfig()
        const archivo = path.join(dir, ".entorno")
        fs.writeFileSync(archivo, `export LAZUNOX_REGION=sur\nexport LAZUNOX_API_KEY=${CLAVE}\n`)
        const { prompt, session } = yield* sesionConPeticion("lee .entorno y dime la región")
        yield* llm.push(reply().tool("read", { filePath: archivo }))
        yield* llm.text("listo")
        yield* prompt.loop({ sessionID: session.id })
        const { partes } = yield* todasLasPartes(session.id)
        const herr = partes.find((p) => p.type === "tool")
        const enviados = (yield* llm.inputs).map((i) => JSON.stringify((i as { messages?: unknown }).messages ?? ""))
        expect(herr?.state.status).toBe("completed")
        expect(enviados).toHaveLength(2)
        expect(enviados[1]).toContain("LAZUNOX_REGION=sur")
        expect(enviados[1]).not.toContain(COLA)
        // El archivo en disco no se toca.
        expect(fs.readFileSync(archivo, "utf-8")).toContain(CLAVE)
      }),
    ),
  )

  it.instance("LAZUNOX_SANITIZAR_MODELO=1: la clave no queda guardada ni llega al modelo; las demás variables sí", () =>
    conVars({ LAZUNOX_SANITIZAR: undefined, LAZUNOX_SANITIZAR_MODELO: "1" }, () =>
      Effect.gen(function* () {
        const { herr, enviados } = yield* correrT28
        expect(herr?.state.status).toBe("completed")
        if (herr?.state.status !== "completed") return
        expect(herr.state.output).toContain("LAZUNOX_REGION=sur")
        expect(herr.state.output).toContain("LAZUNOX_API_KEY=[REDACTED_SECRET]")
        expect(JSON.stringify(herr)).not.toContain(COLA)
        // La 2.ª petición al modelo lleva el resultado de la herramienta: sin la clave.
        expect(enviados).toHaveLength(2)
        expect(enviados[1]).toContain("LAZUNOX_REGION=sur")
        expect(enviados[1]).not.toContain(COLA)
      }),
    ),
  )

  it.instance("por defecto (modelo apagado): lo mostrado sale limpio pero el modelo recibe la salida tal cual (documenta la opción apagada)", () =>
    conVars({ LAZUNOX_SANITIZAR: undefined, LAZUNOX_SANITIZAR_MODELO: undefined }, () =>
      Effect.gen(function* () {
        const { herr, enviados } = yield* correrT28
        expect(herr?.state.status).toBe("completed")
        if (herr?.state.status !== "completed") return
        // Metadatos (vista previa de la salida que muestra la interfaz): sin la clave.
        expect(JSON.stringify(herr.state.metadata)).not.toContain(COLA)
        expect(herr.state.metadata.output).toContain("[REDACTED_SECRET]")
        // La salida que ve el modelo no se toca sin la opción.
        expect(herr.state.output).toContain(COLA)
        expect(enviados[1]).toContain(COLA)
      }),
    ),
  )

  it.instance("LAZUNOX_SANITIZAR=0: todo como antes, también lo mostrado", () =>
    conVars({ LAZUNOX_SANITIZAR: "0", LAZUNOX_SANITIZAR_MODELO: "1" }, () =>
      Effect.gen(function* () {
        const { herr, enviados } = yield* correrT28
        expect(herr?.state.status).toBe("completed")
        if (herr?.state.status !== "completed") return
        expect(herr.state.output).toContain(COLA)
        expect(JSON.stringify(herr.state.metadata)).toContain(COLA)
        expect(enviados[1]).toContain(COLA)
      }),
    ),
  )

  it.instance("el comando guardado y su título salen sin secretos, pero el comando se ejecuta tal cual", () =>
    conVars({ LAZUNOX_SANITIZAR: undefined, LAZUNOX_SANITIZAR_MODELO: undefined }, () =>
      Effect.gen(function* () {
        const { dir, llm } = yield* useServerConfig()
        const { prompt, session } = yield* sesionConPeticion("escribe la clave en un archivo")
        yield* llm.push(
          reply().tool("bash", { command: `printf '%s' ${CLAVE} > copia.txt`, description: "Copia la clave" }),
        )
        yield* llm.text("listo")
        yield* prompt.loop({ sessionID: session.id })
        const { partes } = yield* todasLasPartes(session.id)
        const herr = partes.find((p) => p.type === "tool")
        expect(herr?.state.status).toBe("completed")
        if (herr?.state.status !== "completed") return
        expect(String(herr.state.input.command)).toContain("[REDACTED_SECRET]")
        expect(String(herr.state.input.command)).not.toContain(COLA)
        expect(herr.state.title).not.toContain(COLA)
        // El comando real se ejecutó con la clave verdadera.
        expect(fs.readFileSync(path.join(dir, "copia.txt"), "utf-8")).toBe(CLAVE)
      }),
    ),
  )

  it.instance("salida larga con la clave: ni la vista previa ni el archivo completo de salidas conservan la clave (solo con la opción del modelo)", () =>
    conVars({ LAZUNOX_SANITIZAR: undefined, LAZUNOX_SANITIZAR_MODELO: "1" }, () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig()
        const { prompt, session } = yield* sesionConPeticion("genera salida larga")
        yield* llm.push(
          reply().tool("bash", {
            command: `echo "LAZUNOX_API_KEY=${CLAVE}"; yes relleno-de-linea | head -c 120000; echo "LAZUNOX_API_KEY=${CLAVE}"`,
            description: "Salida larga",
          }),
        )
        yield* llm.text("listo")
        yield* prompt.loop({ sessionID: session.id })
        const { partes } = yield* todasLasPartes(session.id)
        const herr = partes.find((p) => p.type === "tool")
        expect(herr?.state.status).toBe("completed")
        if (herr?.state.status !== "completed") return
        const archivo = herr.state.metadata.outputPath as string | undefined
        expect(archivo).toBeTruthy()
        // Nota: no se exige que el archivo conserve cada línea: el archivo de salida larga a veces pierde un extremo (fallo anterior, ver LAZUNOX.md).
        const completo = fs.readFileSync(archivo!, "utf-8")
        expect(completo).toContain("relleno-de-linea")
        expect(completo).not.toContain(COLA)
        expect(herr.state.output).not.toContain(COLA)
      }),
    ),
  )
})

describe("7.5 archivo de salida larga (reescritura)", () => {
  const conCarpeta = async (fn: (archivo: string) => Promise<void>) => {
    const { TRUNCATION_DIR } = await import("@/tool/truncation-dir")
    fs.mkdirSync(TRUNCATION_DIR, { recursive: true })
    const archivo = path.join(TRUNCATION_DIR, `tool_prueba_sanitizar_${Date.now()}`)
    try {
      await fn(archivo)
    } finally {
      fs.rmSync(archivo, { force: true })
    }
  }

  test("con la opción del modelo: se reescribe sin secretos; las demás líneas quedan", async () => {
    const { resultadoParaElModelo } = await import("../../src/session/sanitizar-partes")
    await conCarpeta(async (archivo) => {
      fs.writeFileSync(archivo, `a=1\nLAZUNOX_API_KEY=${CLAVE}\nb=2\n`)
      process.env.LAZUNOX_SANITIZAR_MODELO = "1"
      try {
        const r = await resultadoParaElModelo("bash", { output: `x ${CLAVE}`, metadata: { outputPath: archivo } })
        expect(r.output).toBe("x [REDACTED_SECRET]")
        expect(fs.readFileSync(archivo, "utf-8")).toBe("a=1\nLAZUNOX_API_KEY=[REDACTED_SECRET]\nb=2\n")
      } finally {
        delete process.env.LAZUNOX_SANITIZAR_MODELO
      }
    })
  })

  test("sin la opción, o en una herramienta que no es de comandos: no toca nada", async () => {
    const { resultadoParaElModelo } = await import("../../src/session/sanitizar-partes")
    await conCarpeta(async (archivo) => {
      const contenido = `LAZUNOX_API_KEY=${CLAVE}\n`
      fs.writeFileSync(archivo, contenido)
      const sin = await resultadoParaElModelo("bash", { output: CLAVE, metadata: { outputPath: archivo } })
      expect(sin.output).toBe(CLAVE)
      process.env.LAZUNOX_SANITIZAR_MODELO = "1"
      try {
        const otra = await resultadoParaElModelo("glob", { output: CLAVE, metadata: { outputPath: archivo } })
        expect(otra.output).toBe(CLAVE)
        expect(fs.readFileSync(archivo, "utf-8")).toBe(contenido)
        // Una ruta fuera de la carpeta de salidas no se reescribe nunca.
        const fuera = path.join(path.dirname(archivo), "..", `fuera_${Date.now()}`)
        fs.writeFileSync(fuera, contenido)
        try {
          await resultadoParaElModelo("bash", { output: "x", metadata: { outputPath: fuera } })
          expect(fs.readFileSync(fuera, "utf-8")).toBe(contenido)
        } finally {
          fs.rmSync(fuera, { force: true })
        }
      } finally {
        delete process.env.LAZUNOX_SANITIZAR_MODELO
      }
    })
  })
})
