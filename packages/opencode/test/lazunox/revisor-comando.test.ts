// Lazunox B3 (probe `revisor (b2)`): `/review` (comando -> subtarea del agente `revisor`) tiene que dejar al revisor CON sus herramientas de
// lectura aunque la sesión traiga reglas de permiso propias, igual que cuando el padre lo lanza con `task`; y nunca con más que antes
// (sin edit/write/apply_patch/task) ni más que el padre.
import { describe, expect } from "bun:test"
import { deriveSubagentSessionPermission } from "../../src/agent/subagent-permissions"
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

/** Lanza `/review` con la sesión dada y devuelve las herramientas de la PRIMERA petición del revisor. */
const herramientasDelRevisor = (permission: Session.Info["permission"]) =>
  Effect.gen(function* () {
    const { directory: dir } = yield* TestInstance
    const llm = yield* TestLLMServer
    yield* (yield* FSUtil.Service).writeWithDirs(path.join(dir, "opencode.json"), JSON.stringify(cfg(llm.url)))
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "review", permission })
    yield* llm.text('{"findings":[],"overall_correctness":"correct","overall_explanation":"nada"}')
    yield* (yield* SessionPrompt.Service).command({ sessionID: chat.id, command: "review", arguments: "", model: "test/test-model" })
    const entradas = yield* llm.inputs
    const hijas = yield* sessions.children(chat.id)
    return { nombres: nombresDeHerramientas(entradas[0]).sort(), hijas, entradas }
  })

const SOLO_LECTURA = ["glob", "grep", "read"]
const PROHIBIDAS = ["edit", "write", "apply_patch", "task", "webfetch", "todowrite", "question"]

describe("/review (comando -> subtarea) conserva las herramientas del revisor con permisos propios en la sesión", () => {
  const casos: [string, Session.Info["permission"]][] = [
    ["sin reglas en la sesión", []],
    ["*: allow (peor caso)", [{ permission: "*", pattern: "*", action: "allow" }]],
    ["bash: allow", [{ permission: "bash", pattern: "*", action: "allow" }]],
  ]
  for (const [nombre, permiso] of casos) {
    prueba.instance(
      `${nombre}: el revisor conserva glob/grep/read y no obtiene edit/write/task`,
      () =>
        Effect.gen(function* () {
          const { nombres, hijas } = yield* herramientasDelRevisor(permiso)
          expect(hijas.length).toBe(1)
          for (const t of SOLO_LECTURA) expect(nombres).toContain(t)
          for (const t of PROHIBIDAS) expect(nombres).not.toContain(t)
        }),
      60_000,
    )
  }

  prueba.instance(
    "*: allow y bash: allow: el revisor conserva bash (para `git diff --no-ext-diff`); sigue siendo solo lectura (2C)",
    () =>
      Effect.gen(function* () {
        for (const permiso of [
          [{ permission: "*", pattern: "*", action: "allow" }],
          [{ permission: "bash", pattern: "*", action: "allow" }],
        ] as Session.Info["permission"][]) {
          const { nombres } = yield* herramientasDelRevisor(permiso)
          expect(nombres).toContain("bash")
        }
      }),
    60_000,
  )

  prueba.instance(
    "el tope del padre se mantiene: si la sesión niega read, el revisor tampoco lo tiene; si niega bash, no hay bash",
    () =>
      Effect.gen(function* () {
        const { nombres } = yield* herramientasDelRevisor([
          { permission: "*", pattern: "*", action: "allow" },
          { permission: "read", pattern: "*", action: "deny" },
          { permission: "bash", pattern: "*", action: "deny" },
        ])
        expect(nombres).not.toContain("read")
        expect(nombres).not.toContain("bash")
        expect(nombres).toContain("grep")
      }),
    60_000,
  )

  prueba.instance(
    "el permiso efectivo de la sesión hija: nunca edit/task, y read permitido",
    () =>
      Effect.gen(function* () {
        const { hijas } = yield* herramientasDelRevisor([{ permission: "*", pattern: "*", action: "allow" }])
        const reglas = hijas[0]!.permission ?? []
        const agente = yield* (yield* AgentSvc.Service).get("revisor")
        const ev = (p: string, pat: string) => Permission.evaluate(p, pat, agente!.permission, reglas).action
        expect(ev("read", "src/a.ts")).toBe("allow")
        expect(ev("bash", "git diff --no-ext-diff")).toBe("ask") // la persona decide cada orden (nunca allow, ver revisor-git-modos)
        for (const p of ["edit", "task", "webfetch"]) expect(ev(p, "*")).toBe("deny")
        expect(ev("bash", "rm -rf .")).toBe("deny")
      }),
    60_000,
  )
})

describe("sesión con `*: ask`: el revisor conserva la lectura pero en «preguntar» (nunca más que el padre)", () => {
  prueba.instance(
    "/review con `*: ask`: ofrece read/grep/glob/bash, ninguno en allow, nada de edit/write/task; igual que el cálculo de `task`",
    () =>
      Effect.gen(function* () {
        const ask = [{ permission: "*", pattern: "*", action: "ask" as const }]
        const { nombres, hijas } = yield* herramientasDelRevisor(ask)
        for (const t of [...SOLO_LECTURA, "bash"]) expect(nombres).toContain(t)
        for (const t of PROHIBIDAS) expect(nombres).not.toContain(t)
        const agentes = yield* AgentSvc.Service
        const build = yield* agentes.get("build")
        const revisor = yield* agentes.get("revisor")
        const porTask = deriveSubagentSessionPermission({ parentSessionPermission: ask, parentAgentPermission: build!.permission, subagent: revisor! })
        const ev = (reglas: typeof porTask, p: string, pat = "x") => Permission.evaluate(p, pat, revisor!.permission, reglas).action
        const hija = hijas[0]!.permission ?? []
        for (const p of ["read", "grep", "glob", "edit", "task", "write"]) expect(ev(hija, p)).toBe(ev(porTask, p))
        for (const p of ["read", "grep", "glob"]) expect(ev(hija, p)).toBe("ask") // como el padre: la persona decide
        for (const p of ["edit", "write", "task", "webfetch"]) expect(ev(hija, p)).toBe("deny")
        expect(ev(hija, "bash", "rm -rf .")).toBe("deny")
      }),
    60_000,
  )
})
