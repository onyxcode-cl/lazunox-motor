// Lazunox (fix revisor/git): el revisor y el verificador DEBEN poder ejecutar `git diff` (en «preguntar», la persona decide) con los
// rulesets de sesión que escribe la app para cada modo de Code, y lo que declaran (`GET /agent`) no puede exceder al padre según el
// guardián de subagentes de la app. Los rulesets están copiados de `src/shared/permission-rules.ts` de la app (`rulesetForMode`),
// el guardián de `src/main/opencode/subagent-guard.ts` (`wmatch`/`evaluate`/`childRules`/`escalations`).
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

type R = { permission: string; pattern: string; action: "allow" | "ask" | "deny" }
const r = (permission: string, pattern: string, action: R["action"]): R => ({ permission, pattern, action })
const readRules = [r("read", "*", "allow"), r("read", "*.env", "ask"), r("read", "*.env.*", "ask"), r("read", "*.env.example", "allow"), r("read", "mcp:*", "ask")]
const MARCAS_LECTURA = ["git branch", "git show", "git rev-parse", "git status", "git diff", "git log", "ls", "dir", "pwd", "Get-ChildItem", "Get-Location"]
const GIT_CFG = [".git/*", "*/.git/*", ".gitattributes", "*/.gitattributes", ".gitmodules", "*/.gitmodules"].flatMap((p) => [r("edit", p, "ask"), r("write", p, "ask")])
/** Copia de `rulesetForMode` (app, `src/shared/permission-rules.ts`) para los modos que importan. */
const MODOS: Record<string, R[]> = {
  "Preguntar siempre": [r("edit", "*", "ask"), r("write", "*", "ask"), ...readRules, r("bash", "*", "ask"), r("webfetch", "*", "ask"), r("websearch", "*", "ask"), r("external_directory", "*", "ask"), r("task", "*", "ask")],
  "Editar sin preguntar": [r("edit", "*", "allow"), r("write", "*", "allow"), ...GIT_CFG, ...readRules, r("bash", "*", "ask"), r("webfetch", "*", "ask"), r("websearch", "*", "ask"), r("external_directory", "*", "ask"), r("task", "*", "allow")],
  "Solo explorar": [r("edit", "*", "deny"), r("edit", ".opencode/plans/*.md", "allow"), r("write", "*", "deny"), r("write", ".opencode/plans/*.md", "allow"), ...readRules, r("bash", "*", "ask"), ...MARCAS_LECTURA.map((c) => r("bash", `${c} *`, "ask")), r("webfetch", "*", "allow"), r("websearch", "*", "allow"), r("external_directory", "*", "ask"), r("task", "*", "ask"), r("task", "general", "deny")],
  "Automático": [r("edit", "*", "allow"), r("write", "*", "allow"), ...GIT_CFG, ...readRules, r("bash", "*", "ask"), ...[...MARCAS_LECTURA, "npm run", "npm test"].map((c) => r("bash", `${c} *`, "ask")), r("webfetch", "*", "ask"), r("websearch", "*", "ask"), r("external_directory", "*", "ask"), r("task", "*", "allow")],
  "Todo sin preguntar": [r("edit", "*", "allow"), r("write", "*", "allow"), r("read", "*", "allow"), r("bash", "*", "allow"), r("webfetch", "*", "allow"), r("websearch", "*", "allow"), r("external_directory", "*", "allow"), r("task", "*", "allow")],
}

// --- Copia del guardián de subagentes de la app (subagent-guard.ts): mismo comparador, mismas claves base ---
const BS = String.fromCharCode(92)
const BASE_KEYS = ["*", "bash", "edit", "write", "read", "glob", "grep", "list", "webfetch", "websearch", "task", "skill", "question", "external_directory", "doom_loop", "computer_*", "browser_*"]
const RANK: Record<string, number> = { deny: 0, ask: 1, allow: 2 }
const SPECIAL = ".+^$" + String.fromCharCode(123, 125) + "()|[]" + BS
function wmatch(str: string, pattern: string) {
  const s = String(str).split(BS).join("/")
  const p = String(pattern).split(BS).join("/")
  let out = ""
  for (const ch of p) {
    if (ch === "*") out += ".*"
    else if (ch === "?") out += "."
    else if (SPECIAL.includes(ch)) out += BS + ch
    else out += ch
  }
  if (out.endsWith(" .*")) out = out.slice(0, -3) + "( .*)?"
  return new RegExp("^" + out + "$", "s").test(s)
}
function evalGuardia(permission: string, pattern: string, rules: R[]) {
  let hit: R | undefined
  for (const x of rules) if (wmatch(permission, x.permission) && wmatch(pattern, x.pattern)) hit = x
  return hit ? hit.action : "ask"
}
function escalaciones(parent: R[], agentRules: R[], parentSession: R[]) {
  const extra: R[] = []
  if (!agentRules.some((x) => x.permission === "todowrite")) extra.push(r("todowrite", "*", "deny"))
  if (!agentRules.some((x) => x.permission === "task")) extra.push(r("task", "*", "deny"))
  const child = agentRules.concat(parentSession.filter((x) => x.permission === "external_directory" || x.action === "deny"), extra)
  const all = parent.concat(child)
  const keys = new Set(BASE_KEYS)
  for (const x of all) keys.add(x.permission)
  const out: string[] = []
  for (const k of keys) {
    const pats = new Set(["*"])
    for (const x of all) if (x.permission === k) pats.add(x.pattern)
    for (const p of pats) {
      const a = evalGuardia(k, p, parent)
      const b = evalGuardia(k, p, child)
      if (RANK[b]! > RANK[a]!) out.push(k + (p === "*" ? "" : " " + p) + " (padre: " + a + ", subagente: " + b + ")")
    }
  }
  return out
}

const GITS_LECTURA = ["git status", "git diff", "git diff --no-ext-diff HEAD~1", "git log --oneline -5", "git show HEAD"]

describe("revisor y verificador: git de solo lectura en «preguntar» con los rulesets de cada modo de Code", () => {
  for (const [modo, sesion] of Object.entries(MODOS)) {
    prueba.instance(
      `${modo}: /review -> git diff evalúa ask (nunca allow/deny), edit/write/task deny, y lo declarado no excede al padre`,
      () =>
        Effect.gen(function* () {
          const { hijas } = yield* herramientasDelRevisor(sesion as Session.Info["permission"])
          const agentes = yield* AgentSvc.Service
          const revisor = (yield* agentes.get("revisor"))!
          const build = (yield* agentes.get("build"))!
          const hija = hijas[0]!.permission ?? []
          const ev = (p: string, pat: string) => Permission.evaluate(p, pat, revisor.permission, hija).action
          for (const g of GITS_LECTURA) expect(`${g} => ${ev("bash", g)}`).toBe(`${g} => ask`)
          for (const o of ["rm -rf .", "git push", "git commit -m x", "curl http://x", "git diff > f", "ls"]) {
            // lo que no es git de lectura sigue denegado (y las redirecciones las corta `comandoDeSoloLectura` en la herramienta)
            if (o === "git diff > f") continue
            expect(`${o} => ${ev("bash", o)}`).toBe(`${o} => deny`)
          }
          for (const p of ["edit", "write", "task", "webfetch", "todowrite"]) expect(`${p} => ${ev(p, "x")}`).toBe(`${p} => deny`)
          // Lo declarado (`GET /agent`) frente al padre (agente + sesión), con el comparador del guardián de la app.
          const padre = [...build.permission, ...sesion] as R[]
          expect(escalaciones(padre, revisor.permission as R[], sesion)).toEqual([])
        }),
      90_000,
    )
  }

  prueba.instance(
    "declarado: ninguna regla `allow` de bash en revisor ni verificador, y `bash *: deny` va ANTES de las específicas",
    () =>
      Effect.gen(function* () {
        const agentes = yield* AgentSvc.Service
        for (const nombre of ["revisor", "verificador"]) {
          const a = (yield* agentes.get(nombre))!
          const bash = a.permission.filter((x) => x.permission === "bash")
          expect(bash.some((x) => x.action === "allow")).toBe(false)
          expect(bash.filter((x) => x.action === "ask").length).toBeGreaterThan(0)
          const iDeny = bash.findLastIndex((x) => x.pattern === "*" && x.action === "deny")
          const iAsk = bash.findIndex((x) => x.action === "ask")
          expect(iDeny).toBeGreaterThanOrEqual(0)
          expect(iDeny).toBeLessThan(iAsk)
        }
      }),
    30_000,
  )

  prueba.instance(
    "verificador: git diff y los ejecutores de pruebas evalúan ask con los rulesets; lo demás de bash, deny; sin edit/write/task",
    () =>
      Effect.gen(function* () {
        for (const [modo, sesion] of Object.entries(MODOS)) {
          const agentes = yield* AgentSvc.Service
          const ver = (yield* agentes.get("verificador"))!
          const build = (yield* agentes.get("build"))!
          const sub = deriveSubagentSessionPermission({ parentSessionPermission: sesion as any, parentAgentPermission: build.permission, subagent: ver })
          const ev = (p: string, pat: string) => Permission.evaluate(p, pat, ver.permission, sub).action
          for (const g of ["git diff", "bun test src/a.test.ts", "npm run typecheck", "pytest -q"]) expect(`${modo}: ${g} => ${ev("bash", g)}`).toBe(`${modo}: ${g} => ask`)
          for (const o of ["rm -rf .", "git push", "curl x"]) expect(`${modo}: ${o} => ${ev("bash", o)}`).toBe(`${modo}: ${o} => deny`)
          for (const p of ["edit", "write", "task", "webfetch"]) expect(`${modo}: ${p} => ${ev(p, "x")}`).toBe(`${modo}: ${p} => deny`)
          expect(escalaciones([...build.permission, ...sesion] as R[], ver.permission as R[], sesion as R[])).toEqual([])
        }
      }),
    60_000,
  )
})
