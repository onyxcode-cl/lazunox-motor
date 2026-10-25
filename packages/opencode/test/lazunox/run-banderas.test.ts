// Lazunox: banderas de `opencode run` (--json-schema, --max-steps, --presupuesto-tokens, --permisos ninguno, --informe).
// Parte pura (validador de esquemas y medidor) + parte de proceso: el CLI real contra el proveedor falso de `test/lib/llm-server.ts`
// (mismo patrón que `test/cli/run/run-process.test.ts`).
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { reply } from "../lib/llm-server"
import { cliIt } from "../lib/cli-process"
import {
  CODIGO_SALIDA,
  comprobarSalida,
  crearMedidor,
  enteroPositivo,
  jsonDeTexto,
  leerEsquema,
  validarEsquema,
} from "../../src/cli/cmd/run-banderas"

const ESQUEMA = {
  type: "object",
  properties: {
    respuesta: { type: "integer", minimum: 0 },
    detalle: { type: "string", maxLength: 20 },
    etiquetas: { type: "array", items: { type: "string", enum: ["a", "b"] }, maxItems: 2 },
  },
  required: ["respuesta"],
  additionalProperties: false,
}

describe("validarEsquema", () => {
  test("acepta un valor correcto", () => {
    expect(validarEsquema(ESQUEMA, { respuesta: 4, detalle: "ok", etiquetas: ["a"] })).toEqual([])
  })
  test("rechaza tipo, falta de propiedad, extra, enum y límites", () => {
    expect(validarEsquema(ESQUEMA, { respuesta: "4" }).join("|")).toContain("respuesta")
    expect(validarEsquema(ESQUEMA, {}).join("|")).toContain('falta la propiedad "respuesta"')
    expect(validarEsquema(ESQUEMA, { respuesta: 1, otra: 1 }).join("|")).toContain('propiedad no admitida "otra"')
    expect(validarEsquema(ESQUEMA, { respuesta: 1, etiquetas: ["z"] }).join("|")).toContain("etiquetas[0]")
    expect(validarEsquema(ESQUEMA, { respuesta: -1 }).join("|")).toContain("mínimo 0")
    expect(validarEsquema(ESQUEMA, { respuesta: 1.5 }).join("|")).toContain("integer")
    expect(validarEsquema(ESQUEMA, { respuesta: 1, detalle: "x".repeat(21) }).join("|")).toContain("máximo 20")
    expect(validarEsquema(ESQUEMA, { respuesta: 1, etiquetas: ["a", "a", "b"] }).join("|")).toContain("máximo 2")
  })
  test("anyOf, oneOf, $ref y raíz que no es objeto", () => {
    const s = {
      $defs: { n: { type: "number" } },
      anyOf: [{ $ref: "#/$defs/n" }, { type: "string", pattern: "^x" }],
    }
    expect(validarEsquema(s, 3)).toEqual([])
    expect(validarEsquema(s, "xa")).toEqual([])
    expect(validarEsquema(s, "ya").length).toBeGreaterThan(0)
    expect(validarEsquema({ type: "array" }, { a: 1 }).length).toBeGreaterThan(0)
    expect(validarEsquema({ oneOf: [{ type: "number" }, { type: "integer" }] }, 3).join("|")).toContain(
      "exactamente una",
    )
  })
})

describe("comprobarSalida / leerEsquema / jsonDeTexto", () => {
  test("usa la salida estructurada y, si falta, el JSON del texto", () => {
    expect(comprobarSalida(ESQUEMA, { respuesta: 1 }, undefined).valido).toBe(true)
    expect(comprobarSalida(ESQUEMA, undefined, 'Listo:\n```json\n{"respuesta": 2}\n```').valido).toBe(true)
    const mala = comprobarSalida(ESQUEMA, undefined, "no es json")
    expect(mala.valido).toBe(false)
    expect(mala.errores[0]).toContain("salida estructurada")
  })
  test("esquema ilegible o que no es objeto", () => {
    expect(leerEsquema("{no").ok).toBe(false)
    expect(leerEsquema("[1]").ok).toBe(false)
    expect(leerEsquema('{"type":"object"}').ok).toBe(true)
    expect(jsonDeTexto('{"a":1}')).toEqual({ ok: true, valor: { a: 1 } })
  })
  test("enteroPositivo", () => {
    expect(enteroPositivo("--x", undefined)).toBeUndefined()
    expect(enteroPositivo("--x", 3)).toBe(3)
    expect(() => enteroPositivo("--x", 0)).toThrow("--x")
    expect(() => enteroPositivo("--x", 1.5)).toThrow()
    expect(() => enteroPositivo("--x", Number.NaN)).toThrow()
  })
})

describe("medidor", () => {
  const paso = (id: string, input: number, output: number, reason = "tool-calls") => ({
    id,
    reason,
    tokens: { input, output, reasoning: 0, cache: { read: 7, write: 0 } },
  })
  test("corta por pasos solo si el bucle iba a seguir", () => {
    const m = crearMedidor({ maxPasos: 2 })
    expect(m.paso(paso("1", 10, 1), true)).toBeUndefined()
    expect(m.paso(paso("2", 10, 1), true)).toBe("max_pasos")
    const fin = crearMedidor({ maxPasos: 1 })
    expect(fin.paso(paso("1", 10, 1, "stop"), true)).toBeUndefined()
    expect(fin.informe("completado").exito).toBe(true)
  })
  test("corta por presupuesto (entrada + salida) y cuenta caché aparte; no repite pasos", () => {
    const m = crearMedidor({ presupuestoTokens: 100 })
    expect(m.paso(paso("1", 60, 20), true)).toBeUndefined()
    expect(m.paso(paso("1", 60, 20), true)).toBeUndefined() // mismo id: no se suma dos veces
    expect(m.paso(paso("2", 30, 5), true)).toBe("presupuesto_tokens")
    const inf = m.informe("presupuesto_tokens")
    expect(inf.tokens).toMatchObject({ entrada: 90, salida: 25, cache_leida: 14, total: 115 })
    expect(inf.pasos).toBe(2)
    expect(inf.exito).toBe(false)
    expect(CODIGO_SALIDA.presupuesto_tokens).not.toBe(0)
  })
  test("cuenta herramientas una vez por parte y los pasos de ayudantes aparte", () => {
    const m = crearMedidor({})
    m.herramienta({ id: "a", tool: "read", state: { status: "running" } })
    m.herramienta({ id: "a", tool: "read", state: { status: "completed" } })
    m.herramienta({ id: "a", tool: "read", state: { status: "completed" } })
    m.herramienta({ id: "b", tool: "bash", state: { status: "error" } })
    m.paso(paso("h", 5, 5), false)
    m.permisoNegado()
    const inf = m.informe("completado", { detalle: "x" })
    expect(inf.herramientas).toEqual({ read: 1, bash: 1 })
    expect(inf.llamadas_herramientas).toBe(2)
    expect(inf.pasos).toBe(0)
    expect(inf.pasos_ayudantes).toBe(1)
    expect(inf.permisos_negados).toBe(1)
  })
  test("no corta tras capturar la salida estructurada", () => {
    const m = crearMedidor({ maxPasos: 1 })
    m.herramienta({ id: "s", tool: "StructuredOutput", state: { status: "completed" } })
    expect(m.paso(paso("1", 1, 1), true)).toBeUndefined()
  })
  test("el tiempo sale del reloj inyectado", () => {
    let t = 1000
    const m = crearMedidor({ ahora: () => t })
    t = 4500
    expect(m.informe("completado").tiempo_ms).toBe(3500)
  })
})

// --- Proceso real: `bun src/index.ts run ...` contra el proveedor falso -------------------------------------------------

const ejecutar = { bash: "allow" as const }
const bashEco = (n: number) => ({ command: `printf paso${n}`, description: "Escribe un texto fijo" })

function informeDe(stdout: string, eventos: (s: string) => Array<Record<string, unknown>>) {
  return eventos(stdout).find((e) => e.type === "informe") as Record<string, any> | undefined
}

describe("opencode run con banderas (proceso)", () => {
  cliIt.concurrent(
    "--json-schema: una salida válida sale con 0, se imprime y queda en el informe",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => Bun.write(`${home}/esquema.json`, JSON.stringify(ESQUEMA)))
        yield* llm.tool("StructuredOutput", { respuesta: 4, detalle: "dos más dos" })
        const r = yield* opencode.run("¿cuánto es 2+2?", {
          timeoutMs: 80_000,
          format: "json",
          extraArgs: ["--json-schema", "esquema.json"],
        })
        opencode.expectExit(r, 0)
        const ev = opencode.parseJsonEvents(r.stdout)
        expect(ev.find((e) => e.type === "salida_estructurada")?.salida).toEqual({
          respuesta: 4,
          detalle: "dos más dos",
        })
        const inf = informeDe(r.stdout, opencode.parseJsonEvents)
        expect(inf?.motivo).toBe("completado")
        expect(inf?.exito).toBe(true)
        expect(inf?.esquema?.valido).toBe(true)
        expect(inf?.herramientas?.StructuredOutput).toBe(1)
      }),
    90_000,
  )

  cliIt.concurrent(
    "--json-schema: una salida inválida sale con código no cero y mensaje claro",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => Bun.write(`${home}/esquema.json`, JSON.stringify(ESQUEMA)))
        yield* llm.tool("StructuredOutput", { respuesta: "cuatro" })
        const r = yield* opencode.run("¿cuánto es 2+2?", {
          timeoutMs: 80_000,
          extraArgs: ["--json-schema", "esquema.json"],
        })
        expect(r.exitCode).toBe(CODIGO_SALIDA.esquema_invalido)
        expect(r.stderr).toContain("no cumple el esquema")
        expect(r.stderr).toContain("respuesta")
        expect(r.stderr).toContain('"motivo":"esquema_invalido"')
        expect(r.stdout).toBe("")
      }),
    90_000,
  )

  cliIt.concurrent(
    "--json-schema: archivo ausente o roto falla antes de llamar al modelo",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => Bun.write(`${home}/roto.json`, "{no"))
        const falta = yield* opencode.run("hola", { timeoutMs: 80_000, extraArgs: ["--json-schema", "nada.json"] })
        expect(falta.exitCode).not.toBe(0)
        expect(falta.stderr).toContain("no se pudo leer nada.json")
        const roto = yield* opencode.run("hola", { timeoutMs: 80_000, extraArgs: ["--json-schema", "roto.json"] })
        expect(roto.exitCode).not.toBe(0)
        expect(roto.stderr).toContain("no es JSON válido")
        expect(yield* llm.calls).toBe(0)
      }),
    90_000,
  )

  cliIt.concurrent(
    "--max-steps corta el bucle, deja informe con motivo y no sigue llamando al modelo",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        for (let i = 1; i <= 6; i++) yield* llm.tool("bash", bashEco(i))
        yield* llm.text("fin")
        const r = yield* opencode.run("haz varias cosas", {
          timeoutMs: 80_000,
          format: "json",
          permission: ejecutar,
          extraArgs: ["--max-steps", "2"],
        })
        expect(r.exitCode).toBe(CODIGO_SALIDA.max_pasos)
        const inf = informeDe(r.stdout, opencode.parseJsonEvents)
        expect(inf?.motivo).toBe("max_pasos")
        expect(inf?.pasos).toBe(2)
        expect(inf?.herramientas?.bash).toBe(2)
        expect(inf?.limites).toEqual({ max_pasos: 2 })
        expect(inf?.tiempo_ms).toBeGreaterThan(0)
        expect(inf?.tokens).toHaveProperty("cache_leida")
        // el motor no llegó a pedir los pasos 3..6: 2 pasos + peticiones auxiliares (título), no las 7 respuestas guionadas
        expect(yield* llm.calls).toBeLessThanOrEqual(5)
        expect(yield* llm.pending).toBeGreaterThanOrEqual(3)
      }),
    90_000,
  )

  cliIt.concurrent(
    "--presupuesto-tokens corta al superar entrada + salida acumuladas",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        for (let i = 1; i <= 5; i++)
          yield* llm.push(reply().tool("bash", bashEco(i)).usage({ input: 400, output: 100 }))
        yield* llm.text("fin")
        const r = yield* opencode.run("haz varias cosas", {
          timeoutMs: 80_000,
          format: "json",
          permission: ejecutar,
          extraArgs: ["--presupuesto-tokens", "900"],
        })
        expect(r.exitCode).toBe(CODIGO_SALIDA.presupuesto_tokens)
        const inf = informeDe(r.stdout, opencode.parseJsonEvents)
        expect(inf?.motivo).toBe("presupuesto_tokens")
        expect(inf?.pasos).toBe(2)
        expect(inf?.tokens.entrada).toBe(800)
        expect(inf?.tokens.salida).toBe(200)
        expect(inf?.tokens.total).toBe(1000)
      }),
    90_000,
  )

  cliIt.concurrent(
    "sin cortes, el informe dice completado y --informe lo guarda en un archivo",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(reply().tool("bash", bashEco(1)).usage({ input: 50, output: 10 }))
        yield* llm.text("listo", { usage: { input: 60, output: 5 } })
        const r = yield* opencode.run("una cosa", {
          timeoutMs: 80_000,
          permission: ejecutar,
          extraArgs: ["--max-steps", "10", "--informe", "informe.json"],
        })
        opencode.expectExit(r, 0)
        const inf = JSON.parse(yield* Effect.promise(() => Bun.file(`${home}/informe.json`).text()))
        expect(inf.motivo).toBe("completado")
        expect(inf.exito).toBe(true)
        expect(inf.pasos).toBe(2)
        expect(inf.tokens).toMatchObject({ entrada: 110, salida: 15, total: 125 })
        expect(inf.herramientas).toEqual({ bash: 1 })
      }),
    90_000,
  )

  cliIt.concurrent(
    "--permisos ninguno niega lo que preguntaría, sigue sin esperar y lo cuenta",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.tool("bash", { command: "touch negado", description: "Crea un archivo" })
        yield* llm.text("seguí sin el permiso")
        const r = yield* opencode.run("crea un archivo", {
          timeoutMs: 80_000,
          format: "json",
          permission: { bash: "ask" },
          extraArgs: ["--permisos", "ninguno"],
        })
        opencode.expectExit(r, 0)
        const ev = opencode.parseJsonEvents(r.stdout)
        expect(ev.some((e) => e.type === "permiso_negado" && e.permission === "bash")).toBe(true)
        const inf = informeDe(r.stdout, opencode.parseJsonEvents)
        expect(inf?.permisos_negados).toBe(1)
        expect(inf?.motivo).toBe("completado")
        expect(yield* Effect.promise(() => Bun.file(`${home}/negado`).exists())).toBe(false)
        // el modelo recibió el motivo y pudo continuar (a diferencia de un rechazo sin mensaje, que detiene el bucle)
        expect(ev.some((e) => e.type === "text" && JSON.stringify(e.part).includes("seguí sin el permiso"))).toBe(true)
      }),
    90_000,
  )

  cliIt.concurrent(
    "un proveedor que sigue fallando (cuota agotada) corta la ejecución con motivo de error en vez de esperar",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        for (let i = 0; i < 8; i++)
          yield* llm.error(429, { error: { message: "Free usage limit reached", type: "FreeUsageLimitError" } })
        const r = yield* opencode.run("haz algo", {
          format: "json",
          extraArgs: ["--max-steps", "5"],
          timeoutMs: 80_000,
        })
        expect(r.exitCode).toBe(CODIGO_SALIDA.error)
        const inf = informeDe(r.stdout, opencode.parseJsonEvents)
        expect(inf?.motivo).toBe("error")
        expect(inf?.detalle).toContain("no responde")
        expect(r.durationMs).toBeLessThan(75_000)
      }),
    90_000,
  )

  cliIt.concurrent(
    "--permisos ninguno no se combina con --auto; los topes deben ser enteros positivos",
    ({ opencode }) =>
      Effect.gen(function* () {
        const a = yield* opencode.run("hola", { timeoutMs: 80_000, extraArgs: ["--permisos", "ninguno", "--auto"] })
        expect(a.exitCode).not.toBe(0)
        expect(a.stderr).toContain("--permisos ninguno no se puede combinar con --auto")
        const b = yield* opencode.run("hola", { timeoutMs: 80_000, extraArgs: ["--max-steps", "0"] })
        expect(b.exitCode).not.toBe(0)
        expect(b.stderr).toContain("--max-steps debe ser un entero positivo")
        const c = yield* opencode.run("hola", { timeoutMs: 80_000, extraArgs: ["--presupuesto-tokens", "-5"] })
        expect(c.exitCode).not.toBe(0)
        expect(c.stderr).toContain("--presupuesto-tokens debe ser un entero positivo")
      }),
    90_000,
  )
})
