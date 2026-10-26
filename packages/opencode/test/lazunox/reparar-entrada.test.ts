// Lazunox (Ola 7 — 7.13): reparación de la entrada de herramientas por esquema (tool/reparar-entrada.ts), cableada en
// session/tools.ts antes de ganchos, permisos y candado. Parte pura (cada caso reparable y los NO reparables) + una
// comprobación con el motor y el proveedor falso (el modelo manda «20» y la herramienta recibe 20).
import { describe, expect, test } from "bun:test"
import { activa, repararEntrada } from "../../src/tool/reparar-entrada"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Effect, Layer } from "effect"
import path from "path"
import fsSync from "fs"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import type { SessionID } from "../../src/session/schema"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "../../src/format"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer, raw } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"


const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const flujoRoot = LayerNode.group([
  LayerNode.group([
    SessionPrompt.node,
    Session.node,
    SessionProjector.node,
    MessageV2.node,
    Snapshot.node,
    LLM.node,
    Env.node,
    AgentSvc.node,
    Command.node,
    Permission.node,
    Plugin.node,
    Config.node,
    ProviderSvc.node,
    LSP.node,
    MCP.node,
    FSUtil.node,
    BackgroundJob.node,
    SessionStatus.node,
    SessionRunState.node,
    Database.node,
    EventV2Bridge.node,
    Question.node,
    Todo.node,
    ToolRegistry.node,
    Skill.node,
    Git.node,
    Ripgrep.node,
    Format.node,
    Truncate.node,
    SessionProcessor.node,
    Image.node,
    SessionCompaction.node,
    SessionRevert.node,
    Instruction.node,
    SystemPrompt.node,
    CrossSpawnSpawner.node,
    RuntimeFlags.node,
  ]),
  LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
])


const montar = () =>
  testEffect(
    LayerNode.compile(flujoRoot, [
      [SessionSummary.node, summary],
      [LSP.node, lsp],
      [MCP.node, mcp],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true, experimentalBackgroundSubagents: false })],
    ]),
  )
const it = montar()

const cfg = (url: string) => ({
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: url },
    },
  },
  model: "test/test-model",
})



const rep = (entrada: unknown, esquema: unknown) => repararEntrada(entrada, esquema).valor

const esq = {
  type: "object",
  properties: {
    limit: { type: "integer" },
    ratio: { type: "number" },
    flag: { type: "boolean" },
    name: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    ids: { type: "array", items: { type: "integer" } },
    opts: { type: "object", properties: { n: { type: "integer" } } },
    cfg: { type: "object", properties: { deep: { type: "object", properties: { on: { type: "boolean" } } } } },
    items: { type: "array", items: { type: "object", properties: { count: { type: "integer" } } } },
    maybe: { type: ["integer", "null"] },
  },
  required: ["name"],
}

describe("7.13 reparaciones seguras", () => {
  test("objeto raíz que llegó como texto JSON", () => {
    expect(rep('{"name":"a","limit":"3"}', esq)).toEqual({ name: "a", limit: 3 })
  })
  test("objeto anidado como texto JSON", () => {
    expect(rep({ name: "a", opts: '{"n":"7"}' }, esq)).toEqual({ name: "a", opts: { n: 7 } })
  })
  test("arreglo que llegó como texto JSON", () => {
    expect(rep({ name: "a", tags: '["x","y"]' }, esq)).toEqual({ name: "a", tags: ["x", "y"] })
    expect(rep({ name: "a", ids: "[1,\"2\"]" }, esq)).toEqual({ name: "a", ids: [1, 2] })
  })
  test("número y entero como texto", () => {
    expect(rep({ name: "a", limit: "20", ratio: " 0.5 " }, esq)).toEqual({ name: "a", limit: 20, ratio: 0.5 })
    expect(rep({ name: "a", ratio: "-1e3" }, esq)).toEqual({ name: "a", ratio: -1000 })
  })
  test("booleano como texto", () => {
    expect(rep({ name: "a", flag: "false" }, esq)).toEqual({ name: "a", flag: false })
    expect(rep({ name: "a", flag: "True" }, esq)).toEqual({ name: "a", flag: true })
  })
  test("null en un opcional de tipo simple: se quita la clave", () => {
    expect(rep({ name: "a", limit: null, flag: null }, esq)).toEqual({ name: "a" })
  })
  test("valor suelto donde se espera un arreglo de uno", () => {
    expect(rep({ name: "a", tags: "solo" }, esq)).toEqual({ name: "a", tags: ["solo"] })
    expect(rep({ name: "a", ids: "4" }, esq)).toEqual({ name: "a", ids: [4] })
    expect(rep({ name: "a", items: { count: "2" } }, esq)).toEqual({ name: "a", items: [{ count: 2 }] })
  })
  test("anidado profundo y dentro de arreglos", () => {
    expect(rep({ name: "a", cfg: { deep: { on: "true" } }, items: [{ count: "1" }, { count: 2 }] }, esq)).toEqual({
      name: "a",
      cfg: { deep: { on: true } },
      items: [{ count: 1 }, { count: 2 }],
    })
  })
  test("$ref local", () => {
    const e = { type: "object", properties: { p: { $ref: "#/$defs/P" } }, $defs: { P: { type: "object", properties: { n: { type: "integer" } } } } }
    expect(rep({ p: '{"n":"3"}' }, e)).toEqual({ p: { n: 3 } })
  })
  test("type en lista con null: se repara contra la rama no nula; null legítimo se respeta", () => {
    expect(rep({ name: "a", maybe: "5" }, esq)).toEqual({ name: "a", maybe: 5 })
    expect(rep({ name: "a", maybe: null }, esq)).toEqual({ name: "a", maybe: null })
  })
  test("lo que ya es válido no cambia (misma referencia)", () => {
    const ok = { name: "a", limit: 2, tags: ["x"] }
    expect(rep(ok, esq)).toEqual(ok)
    expect(repararEntrada(ok, esq).cambios).toEqual([])
  })
  test("cada reparación queda anotada", () => {
    const r = repararEntrada({ name: "a", limit: "20", flag: "true" }, esq)
    expect(r.cambios.length).toBe(2)
  })
})

describe("7.13 lo NO reparable se deja tal cual (la herramienta lo rechaza con su mensaje)", () => {
  test("nunca inventa un obligatorio ni cambia null en obligatorio", () => {
    expect(rep({ limit: "3" }, esq)).toEqual({ limit: 3 }) // falta `name`: no se inventa
    expect(rep({ name: null }, esq)).toEqual({ name: null })
  })
  test("textos que no son números decimales", () => {
    for (const malo of ["", "  ", "abc", "0x10", "1,5", "Infinity", "NaN", "1e999", "2 3"])
      expect(rep({ name: "a", ratio: malo }, esq)).toEqual({ name: "a", ratio: malo })
    expect(rep({ name: "a", limit: "1.5" }, esq)).toEqual({ name: "a", limit: "1.5" }) // 1.5 no es entero
  })
  test("entero: el número fuera de rango seguro no se convierte", () => {
    expect(rep({ name: "a", limit: "99999999999999999999" }, esq)).toEqual({ name: "a", limit: "99999999999999999999" })
  })
  test("booleanos ambiguos (0, 1, sí, vacío)", () => {
    for (const malo of ["1", "0", "sí", "", "yes"]) expect(rep({ name: "a", flag: malo }, esq)).toEqual({ name: "a", flag: malo })
  })
  test("texto JSON roto o del tipo equivocado", () => {
    expect(rep({ name: "a", opts: '{"n":' }, esq)).toEqual({ name: "a", opts: '{"n":' })
    expect(rep({ name: "a", opts: "[1]" }, esq)).toEqual({ name: "a", opts: "[1]" })
    expect(rep({ name: "a", tags: "{x}" }, esq)).toEqual({ name: "a", tags: ["{x}"] }) // texto suelto: arreglo de uno (no es JSON)
    expect(rep({ name: "a", ids: "no" }, esq)).toEqual({ name: "a", ids: "no" }) // "no" no encaja como entero
  })
  test("el texto esperado como string no se toca", () => {
    expect(rep({ name: "20" }, esq)).toEqual({ name: "20" })
    expect(rep({ name: '{"a":1}' }, esq)).toEqual({ name: '{"a":1}' })
  })
  test("uniones ambiguas y enum/const con null: no se tocan", () => {
    const e = {
      type: "object",
      properties: {
        u: { anyOf: [{ type: "integer" }, { type: "boolean" }] },
        e: { type: "string", enum: ["a", "b"] },
        c: { type: "string", const: "x" },
        n: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    }
    expect(rep({ u: "5", e: null, c: null, n: null }, e)).toEqual({ u: "5", e: null, c: null, n: null })
  })
  test("claves desconocidas se conservan; entradas que no son objeto o sin esquema pasan intactas", () => {
    expect(rep({ name: "a", extra: "1" }, esq)).toEqual({ name: "a", extra: "1" })
    expect(rep(null, esq)).toBe(null)
    expect(rep("hola", esq)).toBe("hola")
    expect(rep({ a: "1" }, undefined)).toEqual({ a: "1" })
  })
  test("profundidad acotada (esquema recursivo no cuelga)", () => {
    const e: any = { type: "object", properties: { n: { type: "integer" } } }
    e.properties.hijo = e
    let v: any = { n: "1" }
    for (let i = 0; i < 30; i++) v = { n: "1", hijo: v }
    expect(() => rep(v, e)).not.toThrow()
  })
  test("interruptor LAZUNOX_REPARAR_ENTRADA=0", () => {
    expect(activa({})).toBe(true)
    expect(activa({ LAZUNOX_REPARAR_ENTRADA: "0" })).toBe(false)
    expect(activa({ LAZUNOX_REPARAR_ENTRADA: "1" })).toBe(true)
  })
})

// Una respuesta del modelo con VARIAS llamadas a herramientas en el mismo paso (índices 0..n-1, como las manda un proveedor real).
const variasLlamadas = (llamadas: { name: string; input: unknown }[]) => {
  const linea = (delta: Record<string, unknown>, finish?: string) => ({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }],
  })
  return raw({
    head: [linea({ role: "assistant" })],
    tail: [
      ...llamadas.flatMap((c, index) => [
        linea({ tool_calls: [{ index, id: `call_${index}`, type: "function", function: { name: c.name, arguments: "" } }] }),
        linea({ tool_calls: [{ index, function: { arguments: JSON.stringify(c.input) } }] }),
      ]),
      linea({}, "tool_calls"),
    ],
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// Con el motor: herramienta del proyecto con esquema JSON (args no-zod => esquema `required` todas); el proveedor falso manda
// los argumentos mal tipados y la herramienta anota lo que RECIBE.
// ---------------------------------------------------------------------------------------------------------------------
const herramientaTipada = `
export default {
  description: "tipada",
  args: { n: { type: "integer" }, flag: { type: "boolean" }, tags: { type: "array", items: { type: "string" } } },
  async execute(a, ctx) {
    ;(globalThis.__lzxRep ??= []).push(a)
    await ctx.ask({ permission: "tipada", patterns: [JSON.stringify(a)], always: [], metadata: {} })
    return JSON.stringify(a)
  },
}
`

const correrTipada = Effect.fn("reparar.correr")(function* (entrada: unknown) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  const fsu = yield* FSUtil.Service
  yield* fsu.writeWithDirs(path.join(dir, "opencode.json"), JSON.stringify(cfg(llm.url)))
  yield* fsu.writeWithDirs(path.join(dir, ".opencode", "tool", "tipada.ts"), herramientaTipada)
  ;(globalThis as any).__lzxRep = []
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({ title: "reparar", permission: [{ permission: "*", pattern: "*", action: "allow" }] })
  yield* llm.push(variasLlamadas([{ name: "tipada", input: entrada }]))
  yield* llm.text("listo")
  const prompt = yield* SessionPrompt.Service
  yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "usa tipada" }] })
  const hs = (yield* MessageV2.filterCompactedEffect(chat.id))
    .flatMap((m) => m.parts)
    .filter((p): p is SessionV1.ToolPart => p.type === "tool")
  return { recibido: (globalThis as any).__lzxRep as unknown[], parte: hs[0]! }
})

describe("7.13 con el motor", () => {
  it.instance(
    "el modelo manda «20», «true» y un texto suelto: la herramienta recibe 20, true y [texto]",
    () =>
      Effect.gen(function* () {
        const r = yield* correrTipada({ n: "20", flag: "true", tags: "uno" })
        expect(r.recibido).toEqual([{ n: 20, flag: true, tags: ["uno"] }])
        expect(r.parte.state.status).toBe("completed")
        expect((r.parte.state as any).output).toBe(JSON.stringify({ n: 20, flag: true, tags: ["uno"] }))
      }),
    60_000,
  )

  it.instance(
    "lo no reparable llega tal cual (la herramienta o su esquema decide)",
    () =>
      Effect.gen(function* () {
        const r = yield* correrTipada({ n: "veinte", flag: "quizá", tags: ["a"] })
        expect(r.recibido).toEqual([{ n: "veinte", flag: "quizá", tags: ["a"] }])
      }),
    60_000,
  )

  it.instance(
    "interruptor LAZUNOX_REPARAR_ENTRADA=0: llega sin reparar",
    () =>
      Effect.gen(function* () {
        const antes = process.env.LAZUNOX_REPARAR_ENTRADA
        process.env.LAZUNOX_REPARAR_ENTRADA = "0"
        try {
          const r = yield* correrTipada({ n: "20", flag: "true", tags: "uno" })
          expect(r.recibido).toEqual([{ n: "20", flag: "true", tags: "uno" }])
        } finally {
          if (antes === undefined) delete process.env.LAZUNOX_REPARAR_ENTRADA
          else process.env.LAZUNOX_REPARAR_ENTRADA = antes
        }
      }),
    60_000,
  )
})
