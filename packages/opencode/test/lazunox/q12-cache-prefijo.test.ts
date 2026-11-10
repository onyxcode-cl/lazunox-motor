import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { eq } from "drizzle-orm"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect, setSystemTime, afterAll } from "bun:test"
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer } from "effect"
import path from "path"
import { fileURLToPath } from "url"
import { NamedError } from "@opencode-ai/core/util/error"
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
import { SessionMessageTable } from "@opencode-ai/core/session/sql"
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
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Shell } from "@opencode-ai/core/shell"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "../../src/format"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

function withSh<A, E, R>(fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = "/bin/sh"
      Shell.preferred.reset()
      return prev
    }),
    () => fx(),
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.preferred.reset()
      }),
  )
}

function toolPart(parts: SessionV1.Part[]) {
  return parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
}

type CompletedToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateCompleted }
type ErrorToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateError }

function completedTool(parts: SessionV1.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("completed")
  return part?.state.status === "completed" ? (part as CompletedToolPart) : undefined
}

function errorTool(parts: SessionV1.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("error")
  return part?.state.status === "error" ? (part as ErrorToolPart) : undefined
}

type McpEstado = {
  instructions: MCP.ServerInstructions[]
  tools: Record<string, MCP.McpTool>
  pendientes: string[]
}
const mcpEstado: McpEstado = { instructions: [], tools: {}, pendientes: [] }

function makeMcp() {
  return Layer.succeed(
    MCP.Service,
    MCP.Service.of({
      status: () => Effect.succeed({}),
      clients: () => Effect.succeed({}),
      instructions: () => Effect.sync(() => mcpEstado.instructions),
      pendientes: () => Effect.sync(() => mcpEstado.pendientes),
      tools: () => Effect.sync(() => mcpEstado.tools),
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
}

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

const processorCreateStarted: Array<() => void> = []
const blockingProcessor = Layer.succeed(
  SessionProcessor.Service,
  SessionProcessor.Service.of({
    create: () => Effect.sync(() => processorCreateStarted.shift()?.()).pipe(Effect.andThen(Effect.never)),
  }),
)

const runtimeFlags = RuntimeFlags.layer({ experimentalEventSystem: true })

const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const promptRoot = LayerNode.group([
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
])

const root = LayerNode.group([promptRoot, testLLMServerNode])
const it = testEffect(
  LayerNode.compile(root, [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp()],
    [RuntimeFlags.node, runtimeFlags],
  ] as const),
)

// Config that registers a custom "test" provider with a "test-model" model
// so provider model lookup succeeds inside the loop.
const cfg = {
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
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

const writeText = Effect.fn("test.writeText")(function* (file: string, text: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(file, text)
})

const writeConfig = Effect.fn("test.writeConfig")(function* (dir: string, config: Partial<ConfigV1.Info>) {
  yield* writeText(
    path.join(dir, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config }),
  )
})

const useServerConfig = Effect.fn("test.useServerConfig")(function* (config: (url: string) => Partial<ConfigV1.Info>) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* writeConfig(dir, config(llm.url))
  return { dir, llm }
})

// Q1.2 (caché de prompts): guarda que el inicio del prompt no cambia sin motivo entre pasos y mensajes; y mide qué lo rompe cuando sí cambia.
// Compara, entre peticiones consecutivas al modelo, qué parte del inicio del prompt cambió.
// Orden de serialización que usan los proveedores: herramientas, sistema, mensajes anteriores, mensaje nuevo.
type Cuerpo = { messages?: Array<Record<string, unknown>>; tools?: unknown[]; [k: string]: unknown }
const unica = (c: Cuerpo) => c.messages?.[0] ?? {}
const nombreTool = (t: unknown) => ((t as { function?: { name?: string } }).function?.name ?? "?")

function primerCambio(a: string, b: string) {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i === n && a.length === b.length ? -1 : i
}

export function comparar(antes: Cuerpo, despues: Cuerpo) {
  const toolsA = antes.tools ?? []
  const toolsB = despues.tools ?? []
  const nomA = toolsA.map(nombreTool)
  const nomB = toolsB.map(nombreTool)
  let herramientas = "igual"
  if (JSON.stringify(toolsA) !== JSON.stringify(toolsB)) {
    const i = toolsA.findIndex((t, k) => JSON.stringify(t) !== JSON.stringify(toolsB[k]))
    const k = i === -1 ? Math.min(toolsA.length, toolsB.length) : i
    herramientas = `cambia desde la herramienta #${k} (${nomB[k] ?? nomA[k] ?? "-"}); antes ${nomA.length}, ahora ${nomB.length}`
  }
  const sA = JSON.stringify(unica(antes))
  const sB = JSON.stringify(unica(despues))
  let sistema = "igual"
  const c = primerCambio(sA, sB)
  if (c !== -1) sistema = `cambia en el byte ${c}: «${sB.slice(Math.max(0, c - 20), c + 70)}»`
  const mA = antes.messages ?? []
  const mB = despues.messages ?? []
  let mensajes = "prefijo conservado"
  for (let i = 1; i < mA.length; i++) {
    if (JSON.stringify(mA[i]) !== JSON.stringify(mB[i])) {
      const cc = primerCambio(JSON.stringify(mA[i]), JSON.stringify(mB[i] ?? ""))
      mensajes = `el mensaje #${i} cambió (byte ${cc}); antes ${mA.length}, ahora ${mB.length}`
      break
    }
  }
  return {
    herramientas,
    sistema,
    mensajes,
    ok: herramientas === "igual" && sistema === "igual" && mensajes === "prefijo conservado",
  }
}

const informe: string[] = []
function reportar(escenario: string, hits: Array<{ body: Record<string, unknown> }>) {
  const reales = hits.map((h) => h.body as Cuerpo).filter((b) => Array.isArray(b.tools) && b.tools.length > 0)
  const filas = reales.slice(1).map((b, i) => ({ paso: `${i + 1}→${i + 2}`, ...comparar(reales[i]!, b) }))
  for (const f of filas)
    informe.push(`[Q12] ${escenario} | ${f.paso} | herr: ${f.herramientas} | sistema: ${f.sistema} | mensajes: ${f.mensajes}`)
  return filas
}

const tool = (name: string, description = "Herramienta de prueba") =>
  ({
    def: { name, description, inputSchema: { type: "object", properties: { q: { type: "string" } } } },
    client: {} as never,
    timeout: 1000,
  }) as unknown as MCP.McpTool

const turno = Effect.fn("q12.turno")(function* (sessionID: SessionID, texto: string, agent = "build") {
  const prompt = yield* SessionPrompt.Service
  yield* prompt.prompt({ sessionID, agent, noReply: true, parts: [{ type: "text", text: texto }] })
  return yield* prompt.loop({ sessionID })
})

const sesion = Effect.fn("q12.sesion")(function* () {
  const sessions = yield* Session.Service
  return yield* sessions.create({ title: "q12", permission: [{ permission: "*", pattern: "*", action: "allow" }] })
})

const reinicio = () => {
  mcpEstado.instructions = []
  mcpEstado.tools = {}
  mcpEstado.pendientes = []
}

it.instance("Q12 (a) conversación normal: 4 pasos y un segundo mensaje", () =>
  Effect.gen(function* () {
    reinicio()
    const { dir, llm } = yield* useServerConfig(providerCfg)
    const chat = yield* sesion()
    yield* writeText(path.join(dir, "a.txt"), "uno")
    yield* llm.tool("glob", { pattern: "**/*.txt" })
    yield* llm.tool("glob", { pattern: "*.txt" })
    yield* llm.tool("glob", { pattern: "a*" })
    yield* llm.text("listo")
    yield* turno(chat.id, "busca archivos")
    yield* llm.text("segunda respuesta")
    yield* turno(chat.id, "otra cosa")
    const filas = reportar("a-normal", yield* llm.hits)
    expect(filas.length).toBeGreaterThanOrEqual(4)
    for (const f of filas) expect(f.ok).toBe(true)
  }),
  30_000,
)

it.instance("Q12 (b) conector con instrucciones propias, y otro que llega tarde", () =>
  Effect.gen(function* () {
    reinicio()
    mcpEstado.instructions = [{ name: "alfa", instructions: "Usa buscar antes de crear.", tools: ["alfa_buscar"] }]
    mcpEstado.tools = { alfa_buscar: tool("buscar") }
    const { llm } = yield* useServerConfig(providerCfg)
    const chat = yield* sesion()
    yield* llm.text("uno")
    yield* turno(chat.id, "primero")
    yield* llm.text("dos")
    yield* turno(chat.id, "segundo")
    // llega el conector tardío (con instrucciones y herramientas)
    mcpEstado.instructions = [...mcpEstado.instructions, { name: "beta", instructions: "Beta pide confirmar.", tools: ["beta_crear"] }]
    mcpEstado.tools = { ...mcpEstado.tools, beta_crear: tool("crear") }
    yield* llm.text("tres")
    yield* turno(chat.id, "tercero")
    yield* llm.text("cuatro")
    yield* turno(chat.id, "cuarto")
    const filas = reportar("b-conector-tardio", yield* llm.hits)
    // Antes y después de que llegue el conector tardío el inicio no se mueve; en el paso en que llega cambian herramientas y sistema (inevitable).
    expect(filas[0]!.ok).toBe(true)
    expect(filas[1]!.herramientas).not.toBe("igual")
    expect(filas[2]!.ok).toBe(true)
  }),
  30_000,
)

it.instance("Q12 (b2) conector pendiente: nota efímera al final y luego aparece", () =>
  Effect.gen(function* () {
    reinicio()
    mcpEstado.pendientes = ["tardio"]
    const { llm } = yield* useServerConfig(providerCfg)
    const chat = yield* sesion()
    yield* llm.text("uno")
    yield* turno(chat.id, "primero")
    yield* llm.text("dos")
    yield* turno(chat.id, "segundo")
    mcpEstado.pendientes = []
    mcpEstado.instructions = [{ name: "tardio", instructions: "Instrucciones tardías.", tools: ["tardio_hacer"] }]
    mcpEstado.tools = { tardio_hacer: tool("hacer") }
    yield* llm.text("tres")
    yield* turno(chat.id, "tercero")
    yield* llm.text("cuatro")
    yield* turno(chat.id, "cuarto")
    const filas = reportar("b2-pendiente-luego-listo", yield* llm.hits)
    // La nota efímera del conector que conecta va al final: el sistema y las herramientas no se mueven mientras espera.
    expect(filas[0]!.herramientas).toBe("igual")
    expect(filas[0]!.sistema).toBe("igual")
    expect(filas[2]!.ok).toBe(true)
  }),
  30_000,
)

it.instance("Q12 (c) cambio de agente a mitad de conversación", () =>
  Effect.gen(function* () {
    reinicio()
    const { llm } = yield* useServerConfig(providerCfg)
    const chat = yield* sesion()
    yield* llm.text("uno")
    yield* turno(chat.id, "primero", "build")
    yield* llm.text("dos")
    yield* turno(chat.id, "segundo", "plan")
    yield* llm.text("tres")
    yield* turno(chat.id, "tercero", "build")
    const filas = reportar("c-cambio-agente", yield* llm.hits)
    // El sistema no cambia con el agente; sí cambia la herramienta `task` (lista de agentes) y el aviso del modo (inevitable hoy).
    for (const f of filas) expect(f.sistema).toBe("igual")
  }),
  30_000,
)

it.instance("Q12 (e) orden de herramientas y conectores según el orden de conexión", () =>
  Effect.gen(function* () {
    reinicio()
    const { llm } = yield* useServerConfig(providerCfg)
    const a = yield* sesion()
    const b = yield* sesion()
    mcpEstado.instructions = [
      { name: "alfa", instructions: "A.", tools: ["alfa_x"] },
      { name: "beta", instructions: "B.", tools: ["beta_x"] },
    ]
    mcpEstado.tools = { alfa_x: tool("x"), beta_x: tool("x") }
    yield* llm.text("uno")
    yield* turno(a.id, "hola")
    mcpEstado.instructions = [...mcpEstado.instructions].reverse()
    mcpEstado.tools = { beta_x: tool("x"), alfa_x: tool("x") }
    yield* llm.text("uno")
    yield* turno(b.id, "hola")
    const reales = (yield* llm.hits).map((h) => h.body as Cuerpo).filter((x) => Array.isArray(x.tools) && x.tools.length > 0)
    const c = comparar(reales[0]!, reales[1]!)
    informe.push(`[Q12] e-orden-conexion | herr: ${c.herramientas} | sistema: ${c.sistema}`)
    // Las herramientas salen ordenadas por nombre sin importar el orden de conexión. (Las instrucciones las ordena MCP.instructions, que aquí está simulado.)
    expect(c.herramientas).toBe("igual")
  }),
  30_000,
)

it.instance("Q12 (f) cambio de día a medianoche", () =>
  Effect.gen(function* () {
    reinicio()
    const { llm } = yield* useServerConfig(providerCfg)
    const chat = yield* sesion()
    setSystemTime(new Date(2026, 10, 10, 23, 58, 0))
    yield* llm.text("uno")
    yield* turno(chat.id, "primero")
    setSystemTime(new Date(2026, 10, 10, 23, 59, 30))
    yield* llm.text("dos")
    yield* turno(chat.id, "segundo")
    setSystemTime(new Date(2026, 10, 11, 0, 1, 0))
    yield* llm.text("tres")
    yield* turno(chat.id, "tercero")
    setSystemTime()
    const filas = reportar("f-cambio-de-dia", yield* llm.hits)
    // Dentro del mismo día no cambia nada; al pasar la medianoche solo cambia la línea de la fecha (inevitable).
    expect(filas[0]!.ok).toBe(true)
    expect(filas[1]!.herramientas).toBe("igual")
    expect(filas[1]!.sistema).toContain("Today's date")
  }),
  30_000,
)

it.instance("Q12 (g) el padre tras un ayudante (task)", () =>
  Effect.gen(function* () {
    reinicio()
    const { llm } = yield* useServerConfig(providerCfg)
    const chat = yield* sesion()
    yield* llm.tool("task", { description: "mirar", prompt: "mira el cache", subagent_type: "general" })
    yield* llm.text("resultado del ayudante")
    yield* llm.text("fin")
    yield* turno(chat.id, "usa un ayudante")
    const hs = (yield* llm.hits).map((h) => h.body as Cuerpo).filter((x) => Array.isArray(x.tools) && x.tools.length > 0)
    informe.push(`[Q12] g-peticiones con herramientas: ${hs.length}`)
    // hs[0]=padre paso 1, hs[1]=ayudante, hs[2]=padre paso 2 (si el orden es ese)
    const padre = hs.filter((x) => JSON.stringify(x.tools).includes('"task"'))
    if (padre.length >= 2) {
      const c = comparar(padre[0]!, padre[padre.length - 1]!)
      informe.push(`[Q12] g-padre antes→después del ayudante | herr: ${c.herramientas} | sistema: ${c.sistema} | mensajes: ${c.mensajes}`)
      expect(c.ok).toBe(true)
    }
  }),
  30_000,
)

it.instance("Q12 (d) tras compactar: sistema y herramientas siguen iguales", () =>
  Effect.gen(function* () {
    reinicio()
    const { llm } = yield* useServerConfig(providerCfg)
    const chat = yield* sesion()
    const compaction = yield* SessionCompaction.Service
    yield* llm.text("uno")
    yield* turno(chat.id, "primero")
    yield* llm.text("dos")
    yield* turno(chat.id, "segundo")
    yield* compaction.create({ sessionID: chat.id, agent: "build", model: ref, auto: false })
    yield* llm.text("resumen de la conversación")
    yield* llm.text("tres")
    const prompt = yield* SessionPrompt.Service
    yield* prompt.loop({ sessionID: chat.id })
    yield* llm.text("cuatro")
    yield* turno(chat.id, "tercero")
    const hs = yield* llm.hits
    informe.push(`[Q12] d-peticiones totales: ${hs.length}`)
    const reales = hs.map((h) => h.body as Cuerpo).filter((x) => Array.isArray(x.tools) && x.tools.length > 0)
    for (let i = 1; i < reales.length; i++) {
      const c = comparar(reales[i - 1]!, reales[i]!)
      informe.push(`[Q12] d-compactar | ${i}→${i + 1} | msgs ${reales[i - 1]!.messages?.length}→${reales[i]!.messages?.length} | herr: ${c.herramientas} | sistema: ${c.sistema} | mensajes: ${c.mensajes}`)
      // Compactar cambia los mensajes (inevitable) pero no las herramientas ni el sistema.
      expect(c.herramientas).toBe("igual")
      expect(c.sistema).toBe("igual")
    }
  }),
  40_000,
)

it.instance("Q12 (h) salida larga de una herramienta (20 000 líneas) y pasos siguientes", () =>
  Effect.gen(function* () {
    reinicio()
    const { dir, llm } = yield* useServerConfig(providerCfg)
    const chat = yield* sesion()
    yield* writeText(path.join(dir, "a.txt"), "uno")
    yield* llm.tool("bash", { command: "seq 1 20000", description: "salida larga" })
    yield* llm.tool("glob", { pattern: "*.txt" })
    yield* llm.tool("glob", { pattern: "a*" })
    yield* llm.text("listo")
    yield* turno(chat.id, "corre las pruebas")
    const filas = reportar("h-salida-larga", yield* llm.hits)
    expect(filas.length).toBe(3)
    for (const f of filas) expect(f.ok).toBe(true)
  }),
  40_000,
)

// Q12_INFORME=1 imprime la tabla de qué cambia entre peticiones consecutivas.
afterAll(() => {
  if (process.env.Q12_INFORME === "1") console.log("\n" + informe.join("\n"))
})
