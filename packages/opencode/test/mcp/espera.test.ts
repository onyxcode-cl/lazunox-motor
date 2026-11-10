// Lazunox (Q1.1): el primer mensaje espera a los conectores MCP solo un plazo corto; los lentos terminan en segundo plano.
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { MCP } from "../../src/mcp/index"
import * as Espera from "../../src/mcp/espera"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(MCP.node))
const fixture = path.join(import.meta.dir, "../fixture/mcp-espera-stdio.mjs")

const local = (name: string, env: Record<string, string> = {}) => ({
  type: "local" as const,
  command: [process.execPath, fixture],
  environment: { NAME: name, ...env },
  timeout: 20_000,
})

const conEnv = <A, E, R>(valor: string | undefined, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previo = process.env.LAZUNOX_MCP_ESPERA_MS
      if (valor === undefined) delete process.env.LAZUNOX_MCP_ESPERA_MS
      else process.env.LAZUNOX_MCP_ESPERA_MS = valor
      return previo
    }),
    () => effect,
    (previo) =>
      Effect.sync(() => {
        if (previo === undefined) delete process.env.LAZUNOX_MCP_ESPERA_MS
        else process.env.LAZUNOX_MCP_ESPERA_MS = previo
      }),
  )

const nombres = (tools: Record<string, unknown>) => Object.keys(tools).sort()

describe("Espera.plazoMs", () => {
  test("sin variable: 2000", () => expect(Espera.plazoMs({})).toBe(2000))
  test("valor válido", () => expect(Espera.plazoMs({ LAZUNOX_MCP_ESPERA_MS: "500" })).toBe(500))
  test("0, negativo, texto o vacío-inválido: esperar todo (undefined)", () => {
    expect(Espera.plazoMs({ LAZUNOX_MCP_ESPERA_MS: "0" })).toBeUndefined()
    expect(Espera.plazoMs({ LAZUNOX_MCP_ESPERA_MS: "-5" })).toBeUndefined()
    expect(Espera.plazoMs({ LAZUNOX_MCP_ESPERA_MS: "abc" })).toBeUndefined()
    expect(Espera.plazoMs({ LAZUNOX_MCP_ESPERA_MS: "Infinity" })).toBeUndefined()
  })
  test("cadena vacía = sin variable", () => expect(Espera.plazoMs({ LAZUNOX_MCP_ESPERA_MS: "" })).toBe(2000))
})

describe("Espera.nota", () => {
  test("sin conectores: nada", () => expect(Espera.nota([])).toBeUndefined())
  test("lista los nombres ordenados", () => {
    const n = Espera.nota(["zeta", "alfa"])!
    expect(n).toContain("alfa, zeta")
  })
})

it.instance(
  "rápido + lento: sigue a los 300 ms con el rápido y marca al lento como pendiente; luego aparece sin reiniciar",
  () =>
    conEnv(
      "300",
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        const t0 = Date.now()
        const tools = yield* mcp.tools()
        const ms = Date.now() - t0
        expect(ms).toBeLessThan(1500)
        expect(nombres(tools)).toEqual(["rapido_eco_rapido"])
        expect(yield* mcp.pendientes!()).toEqual(["lento"])

        yield* pollWithTimeout(
          Effect.gen(function* () {
            const now = yield* mcp.tools()
            return Object.keys(now).includes("lento_eco_lento") ? now : undefined
          }),
          "el conector lento no apareció",
        )
        expect(yield* mcp.pendientes!()).toEqual([])
        expect(nombres(yield* mcp.tools())).toEqual(["lento_eco_lento", "rapido_eco_rapido"])
      }),
    ),
  {
    config: {
      mcp: { rapido: local("rapido", { DELAY: "0" }), lento: local("lento", { DELAY: "2500" }) },
    },
  },
)

it.instance(
  "conector que falla: sin pendiente permanente, estado failed y el resto sigue",
  () =>
    conEnv(
      "300",
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        const tools = yield* mcp.tools()
        expect(nombres(tools)).toEqual(["rapido_eco_rapido"])
        yield* pollWithTimeout(
          Effect.gen(function* () {
            return (yield* mcp.pendientes!()).length === 0 ? true : undefined
          }),
          "el conector caído sigue pendiente",
        )
        const status = yield* mcp.status()
        expect(status.caido?.status).toBe("failed")
        expect(status.rapido?.status).toBe("connected")
      }),
    ),
  {
    config: {
      mcp: { rapido: local("rapido"), caido: local("caido", { FAIL: "1", DELAY: "800" }) },
    },
  },
)

it.instance(
  "LAZUNOX_MCP_ESPERA_MS=0: igual que antes, espera a todos",
  () =>
    conEnv(
      "0",
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        const tools = yield* mcp.tools()
        expect(nombres(tools)).toEqual(["lento_eco_lento", "rapido_eco_rapido"])
        expect(yield* mcp.pendientes!()).toEqual([])
      }),
    ),
  { config: { mcp: { rapido: local("rapido"), lento: local("lento", { DELAY: "1500" }) } } },
)

it.instance(
  "valor inválido: igual que antes, espera a todos",
  () =>
    conEnv(
      "mucho",
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        expect(nombres(yield* mcp.tools())).toEqual(["lento_eco_lento", "rapido_eco_rapido"])
      }),
    ),
  { config: { mcp: { rapido: local("rapido"), lento: local("lento", { DELAY: "1500" }) } } },
)

it.instance(
  "status() sigue siendo exacto: espera a los que aún conectan",
  () =>
    conEnv(
      "300",
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        yield* mcp.tools()
        const status = yield* mcp.status()
        expect(status.lento?.status).toBe("connected")
        expect(status.rapido?.status).toBe("connected")
      }),
    ),
  { config: { mcp: { rapido: local("rapido"), lento: local("lento", { DELAY: "1500" }) } } },
)

it.instance(
  "conectores deshabilitados: no arrancan ni quedan pendientes",
  () =>
    conEnv(
      "300",
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        expect(nombres(yield* mcp.tools())).toEqual([])
        expect(yield* mcp.pendientes!()).toEqual([])
      }),
    ),
  { config: { mcp: { apagado: { ...local("apagado"), enabled: false } } } },
)
