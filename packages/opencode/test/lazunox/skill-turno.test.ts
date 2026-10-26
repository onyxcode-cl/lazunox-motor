// Lazunox B4 (probe `skills (c)`): `allowed-tools` de una skill EN LÍNEA restringe en el MISMO turno. El bucle relee los permisos de la
// sesión en cada paso: tras cargar la skill, las herramientas denegadas desaparecen del paso siguiente y un `bash` forzado no corre.
// Una skill nunca concede permisos. Al quedar la sesión en reposo se quita el bloque.
import { describe, expect } from "bun:test"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
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
import { TestLLMServer, reply } from "../lib/llm-server"
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


const montar = (fondo: boolean) =>
  testEffect(
    LayerNode.compile(flujoRoot, [
      [SessionSummary.node, summary],
      [LSP.node, lsp],
      [MCP.node, mcp],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true, experimentalBackgroundSubagents: fondo })],
    ]),
  )
const conFondo = montar(true)
const sinFondo = montar(false)

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

const herramientas = Effect.fn("lote.herramientas")(function* (sessionID: Session.Info["id"]) {
  const msgs = yield* MessageV2.filterCompactedEffect(sessionID)
  return msgs.flatMap((m) => m.parts.filter((p): p is SessionV1.ToolPart => p.type === "tool"))
})

const arrancar = Effect.fn("lote.arrancar")(function* () {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* (yield* FSUtil.Service).writeWithDirs(path.join(dir, "opencode.json"), JSON.stringify(cfg(llm.url)))
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({ title: "lote" })
  return { dir, llm, chat, sessions, prompt: yield* SessionPrompt.Service }
})

const nombresDeHerramientas = (cuerpo: any): string[] =>
  (cuerpo.tools ?? []).map((t: any) => t?.function?.name ?? t?.name).filter(Boolean)



const it = testEffect(
  LayerNode.compile(flujoRoot, [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, mcp],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  ]),
)
const unix = process.platform === "win32" ? "skip" : "run"
const prueba = unix === "run" ? it : { instance: (n: string, f: any, ...r: any[]) => it.instance.skip(n, f, ...r) }

const skillMd = (nombre: string, extra: string[]) =>
  ["---", `name: ${nombre}`, `description: Skill de prueba ${nombre}`, ...extra, "---", `Instrucciones de ${nombre}.`].join("\n")

/** Sesión con `skill` + `bash` permitidos; el guion carga la skill y después fuerza un `bash`. Devuelve peticiones, partes y archivos. */
const correr = (skill: string, permission: Session.Info["permission"]) =>
  Effect.gen(function* () {
    const { directory: dir } = yield* TestInstance
    const llm = yield* TestLLMServer
    const fs = yield* FSUtil.Service
    yield* fs.writeWithDirs(path.join(dir, "opencode.json"), JSON.stringify(cfg(llm.url)))
    yield* fs.writeWithDirs(path.join(dir, ".opencode", "skills", "lectora", "SKILL.md"), skillMd("lectora", ["allowed-tools: Read"]))
    yield* fs.writeWithDirs(path.join(dir, ".opencode", "skills", "hostil", "SKILL.md"), skillMd("hostil", ["allowed-tools: Bash Edit Write"]))
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "skill", permission })
    yield* llm.tool("skill", { name: skill })
    yield* llm.tool("bash", { command: "echo hola > forzado.txt", description: "prueba" })
    yield* llm.text("fin")
    yield* (yield* SessionPrompt.Service).prompt({
      sessionID: chat.id,
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
      parts: [{ type: "text", text: "usa la skill" }],
    })
    const entradas = yield* llm.inputs
    const partes = yield* herramientas(chat.id)
    const final = yield* sessions.get(chat.id)
    return { dir, nombres: entradas.map((e) => nombresDeHerramientas(e)), partes, final, fs }
  })

const PERMITE = [
  { permission: "*", pattern: "*", action: "allow" as const },
]

describe("allowed-tools de una skill en línea restringe desde el SIGUIENTE paso del mismo turno", () => {
  prueba.instance(
    "skill con `allowed-tools: Read`: el paso siguiente ya no ofrece bash/edit/write, y un bash forzado no corre",
    () =>
      Effect.gen(function* () {
        const r = yield* correr("lectora", PERMITE)
        // Paso 1: antes de cargar la skill, el modelo tiene bash.
        expect(r.nombres[0]).toContain("bash")
        expect(r.nombres[0]).toContain("skill")
        // Paso 2: ya restringido a lo que la skill listó.
        expect(r.nombres[1]).toContain("read")
        for (const t of ["bash", "edit", "write", "grep", "glob"]) expect(r.nombres[1]).not.toContain(t)
        // El bash forzado en el paso 2 no se ejecutó.
        const bash = r.partes.find((p) => p.tool === "bash")
        expect(bash?.state.status).not.toBe("completed")
        expect(fsSync.existsSync(path.join(r.dir, "forzado.txt"))).toBe(false)
      }),
    60_000,
  )

  prueba.instance(
    "al quedar la sesión idle ya no hay reglas lazunox_skill_*",
    () =>
      Effect.gen(function* () {
        const r = yield* correr("lectora", PERMITE)
        yield* Effect.sleep("300 millis")
        const s = yield* (yield* Session.Service).get(r.final.id)
        expect(JSON.stringify(s.permission ?? [])).not.toContain("lazunox_skill")
      }),
    60_000,
  )

  prueba.instance(
    "una skill NO concede: con `bash: ask` en la sesión, `allowed-tools: Bash` no lo pasa a allow; edit denegado no reaparece",
    () =>
      Effect.gen(function* () {
        const r = yield* correr("hostil", [
          { permission: "*", pattern: "*", action: "allow" },
          { permission: "bash", pattern: "*", action: "deny" },
          { permission: "edit", pattern: "*", action: "deny" },
        ])
        for (const n of r.nombres) {
          expect(n).not.toContain("bash")
          expect(n).not.toContain("edit")
        }
        expect(fsSync.existsSync(path.join(r.dir, "forzado.txt"))).toBe(false)
      }),
    60_000,
  )
})
