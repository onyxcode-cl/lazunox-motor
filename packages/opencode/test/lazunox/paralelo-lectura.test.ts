// Lazunox 5B (P27): ¿el motor ejecuta en paralelo las llamadas de solo lectura que el modelo pide en UN mismo paso?
// Se mide con el proveedor falso y herramientas lentas: `tool/read.ts`, `tool/grep.ts` y `tool/glob.ts` del proyecto de la
// prueba reemplazan a las nativas (mismo id) y duermen DEMORA ms anotando inicio y fin. Si las tres corren a la vez, el
// tiempo total es ~DEMORA; en serie sería ~3*DEMORA. `PROBE_ONLY=paralelo` (ver LAZUNOX.md).
import { describe, expect } from "bun:test"
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


const DEMORA = 700

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

// Herramienta lenta que sustituye a la nativa del mismo id y anota inicio/fin en `globalThis.__lzxLecturas`.
const herramientaLenta = (id: string) => `
export default {
  description: "lenta ${id}",
  args: {},
  async execute() {
    const reg = (globalThis.__lzxLecturas ??= [])
    reg.push({ id: "${id}", ev: "inicio", t: Date.now() })
    await new Promise((r) => setTimeout(r, ${DEMORA}))
    reg.push({ id: "${id}", ev: "fin", t: Date.now() })
    return "listo ${id}"
  },
}
`

const arrancarLento = Effect.fn("paralelo.arrancar")(function* (ids: string[]) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  const fsu = yield* FSUtil.Service
  yield* fsu.writeWithDirs(path.join(dir, "opencode.json"), JSON.stringify(cfg(llm.url)))
  for (const id of ids) yield* fsu.writeWithDirs(path.join(dir, ".opencode", "tool", `${id}.ts`), herramientaLenta(id))
  ;(globalThis as any).__lzxLecturas = []
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({ title: "paralelo", permission: [{ permission: "*", pattern: "*", action: "allow" }] })
  return { dir, llm, chat, sessions, prompt: yield* SessionPrompt.Service }
})

const registro = () => (globalThis as any).__lzxLecturas as { id: string; ev: "inicio" | "fin"; t: number }[]

describe("5B: lecturas de un mismo paso", () => {
  it.instance(
    "medición: read + grep + glob pedidas en un solo paso corren a la vez (no en serie)",
    () =>
      Effect.gen(function* () {
        const { llm, chat, prompt } = yield* arrancarLento(["read", "grep", "glob"])
        yield* llm.push(
          variasLlamadas([
            { name: "read", input: {} },
            { name: "grep", input: {} },
            { name: "glob", input: {} },
          ]),
        )
        yield* llm.text("listo")
        const t0 = Date.now()
        yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "lee todo" }] })
        const total = Date.now() - t0

        const r = registro()
        const inicios = r.filter((e) => e.ev === "inicio").map((e) => e.t)
        const fines = r.filter((e) => e.ev === "fin").map((e) => e.t)
        expect(inicios.length).toBe(3)
        expect(fines.length).toBe(3)
        console.log(`[paralelo] total=${total}ms; ventana=${Math.max(...fines) - Math.min(...inicios)}ms; serie=${DEMORA * 3}ms`)
        // Paralelo: el último inicio ocurre antes de que termine el primero (en serie, el 2.º empezaría tras el fin del 1.º).
        expect(Math.max(...inicios)).toBeLessThan(Math.min(...fines))
        expect(Math.max(...fines) - Math.min(...inicios)).toBeLessThan(DEMORA * 2)

        const hs = (yield* MessageV2.filterCompactedEffect(chat.id))
          .flatMap((m) => m.parts)
          .filter((p): p is SessionV1.ToolPart => p.type === "tool")
        expect(hs.map((h) => h.tool)).toEqual(["read", "grep", "glob"]) // el orden de los resultados es el de las llamadas
        expect(hs.every((h) => h.state.status === "completed")).toBe(true)
      }),
    60_000,
  )

  it.instance(
    "medición: una escritura (edit) pedida junto a lecturas TAMBIÉN se solapa (la serialización de escrituras no es de este nivel)",
    () =>
      Effect.gen(function* () {
        const { llm, chat, prompt } = yield* arrancarLento(["edit", "read"])
        yield* llm.push(
          variasLlamadas([
            { name: "edit", input: {} },
            { name: "read", input: {} },
          ]),
        )
        yield* llm.text("listo")
        yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "edita y lee" }] })
        const r = registro()
        const inicios = r.filter((e) => e.ev === "inicio").map((e) => e.t)
        const fines = r.filter((e) => e.ev === "fin").map((e) => e.t)
        expect(inicios.length).toBe(2)
        expect(Math.max(...inicios)).toBeLessThan(Math.min(...fines))
      }),
    60_000,
  )
})
