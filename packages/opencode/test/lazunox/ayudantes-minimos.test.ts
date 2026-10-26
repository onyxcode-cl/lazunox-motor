// Lazunox (Ola 6, 6.3 · H3 + H4): ayudantes con contexto mínimo. Con LAZUNOX_AYUDANTES_MINIMOS=1 la petición de una sesión hija de solo
// lectura no trae AGENTS.md, skills ni instrucciones MCP; con la bandera apagada es la de siempre; y los permisos no cambian.
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer, Schema } from "effect"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { Provider as ProviderSvc } from "@/provider/provider"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Format } from "../../src/format"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Command } from "../../src/command"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Question } from "../../src/question"
import { Skill } from "../../src/skill"
import { Snapshot } from "../../src/snapshot"
import { Instruction } from "../../src/session/instruction"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { SystemPrompt } from "../../src/session/system"
import { Todo } from "../../src/session/todo"
import { ContextoMinimo } from "../../src/session/contexto-minimo"
import * as Exhaustividad from "../../src/agent/exhaustividad"
import { camposExhaustividad } from "../../src/tool/task"
import { traducirClaude } from "../../src/config/agent-claude"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

const MARCA = "MARCA-AGENTS-7Q2X"
const BANDERA = "LAZUNOX_AYUDANTES_MINIMOS"
const previo = process.env[BANDERA]
afterEach(() => {
  if (previo === undefined) delete process.env[BANDERA]
  else process.env[BANDERA] = previo
})

const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({ summarize: () => Effect.void, diff: () => Effect.succeed([]), computeDiff: () => Effect.succeed([]) }),
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
const mcpInstr: MCP.ServerInstructions[] = [
  { name: "sin-herramientas", instructions: "MCP-SIN-HERRAMIENTAS-TEXTO", tools: [] },
  { name: "guide-server", instructions: "MCP-CON-HERRAMIENTA-TEXTO", tools: ["guide-server_lookup"] },
]
const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed(mcpInstr),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected"),
    authenticate: () => Effect.die("unexpected"),
    finishAuth: () => Effect.die("unexpected"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })
const raiz = LayerNode.group([
  SessionPrompt.node, Session.node, SessionProjector.node, MessageV2.node, Snapshot.node, LLM.node, Env.node, AgentSvc.node,
  Command.node, Permission.node, Plugin.node, Config.node, ProviderSvc.node, LSP.node, MCP.node, FSUtil.node, BackgroundJob.node,
  SessionStatus.node, SessionRunState.node, Database.node, EventV2Bridge.node, Question.node, Todo.node, ToolRegistry.node,
  Skill.node, Git.node, Ripgrep.node, Format.node, Truncate.node, SessionProcessor.node, Image.node, SessionCompaction.node,
  SessionRevert.node, Instruction.node, SystemPrompt.node, CrossSpawnSpawner.node, RuntimeFlags.node, testLLMServerNode,
])
const it = testEffect(
  LayerNode.compile(raiz, [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, mcp],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  ] as const),
)

const cfg = (url: string) => ({
  $schema: "https://opencode.ai/config.json",
  provider: {
    test: {
      name: "Test", id: "test", env: [], npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model", name: "Test Model", attachment: false, reasoning: false, temperature: false, tool_call: true,
          release_date: "2025-01-01", limit: { context: 100000, output: 10000 }, cost: { input: 0, output: 0 }, options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: url },
    },
  },
  agent: {
    // Solo lectura, pero con permiso de skills: así se ve que `minimo` quita la lista de skills.
    lector: {
      mode: "subagent", prompt: "PROMPT-LECTOR", contexto: "minimo",
      permission: { "*": "deny", read: "allow", skill: "allow" },
    },
    // Declara `minimo` pero PUEDE editar: se niega y sigue con el contexto completo.
    editor: {
      mode: "subagent", prompt: "PROMPT-EDITOR", contexto: "minimo",
      permission: { "*": "deny", read: "allow", edit: "allow", skill: "allow" },
    },
    // Sin `contexto`: nada cambia.
    comun: { mode: "subagent", prompt: "PROMPT-COMUN", permission: { "*": "deny", read: "allow", skill: "allow" } },
    // `minimo` sin prompt propio: usa el corto.
    sinprompt: { mode: "subagent", contexto: "minimo", permission: { "*": "deny", read: "allow" } },
  },
})

const preparar = Effect.fn("test.preparar")(function* () {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(path.join(dir, "opencode.json"), JSON.stringify(cfg(llm.url)))
  yield* fs.writeWithDirs(path.join(dir, "AGENTS.md"), `# Reglas\n${MARCA}\n`)
  yield* fs.writeWithDirs(
    path.join(dir, ".claude/skills/demo-skill/SKILL.md"),
    "---\nname: demo-skill\ndescription: SKILL-DEMO-DESCRIPCION\n---\n\ncuerpo\n",
  )
  yield* (yield* Config.Service).get()
  return { llm }
})

/** Lanza una petición como sesión hija (o raíz) del agente indicado y devuelve el cuerpo enviado al modelo. */
const peticion = Effect.fn("test.peticion")(function* (input: { agent: string; hija: boolean }) {
  const llm = yield* TestLLMServer
  const sessions = yield* Session.Service
  const prompt = yield* SessionPrompt.Service
  const padre = yield* sessions.create({ title: "padre" })
  const chat = yield* sessions.create(
    input.hija
      ? { title: "hija", parentID: padre.id, permission: [] }
      : { title: "raiz", permission: [{ permission: "*", pattern: "*", action: "allow" }] },
  )
  const msg = yield* sessions.updateMessage({
    id: MessageID.ascending(), role: "user", sessionID: chat.id, agent: input.agent, model: ref, time: { created: Date.now() },
  })
  yield* sessions.updatePart({ id: PartID.ascending(), messageID: msg.id, sessionID: chat.id, type: "text", text: "hola" })
  const antes = (yield* llm.hits).length
  yield* llm.hang
  const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
  yield* awaitWithTimeout(llm.wait(antes + 1), "esperando la petición al modelo", "10 seconds")
  const hits = yield* llm.hits
  yield* Fiber.interrupt(fiber)
  return hits[antes]!.body as Record<string, any>
})

const sistema = (body: Record<string, any>) => JSON.stringify(body.messages?.filter((m: any) => m.role === "system") ?? body.input ?? body)

describe("ayudantes con contexto mínimo (6.3): petición real", () => {
  it.instance(
    "bandera encendida: la hija de solo lectura no trae AGENTS.md, skills ni MCP, y usa su prompt corto",
    () =>
      Effect.gen(function* () {
        yield* preparar()
        process.env[BANDERA] = "1"
        const s = sistema(yield* peticion({ agent: "lector", hija: true }))
        expect(s).not.toContain(MARCA)
        expect(s).not.toContain("available_skills")
        expect(s).not.toContain("SKILL-DEMO-DESCRIPCION")
        expect(s).not.toContain("MCP-SIN-HERRAMIENTAS-TEXTO")
        expect(s).not.toContain("MCP-CON-HERRAMIENTA-TEXTO")
        expect(s).toContain("PROMPT-LECTOR")
      }),
    30_000,
  )

  it.instance(
    "bandera encendida: `general` y `build` siguen trayendo todo (aunque se declaren minimo no se aplica)",
    () =>
      Effect.gen(function* () {
        yield* preparar()
        process.env[BANDERA] = "1"
        for (const agent of ["general", "build"]) {
          const s = sistema(yield* peticion({ agent, hija: true }))
          expect(s).toContain(MARCA)
          expect(s).toContain("MCP-SIN-HERRAMIENTAS-TEXTO")
        }
      }),
    30_000,
  )

  it.instance(
    "bandera encendida: un agente que PUEDE editar rechaza `minimo` y conserva AGENTS.md y skills",
    () =>
      Effect.gen(function* () {
        yield* preparar()
        process.env[BANDERA] = "1"
        const s = sistema(yield* peticion({ agent: "editor", hija: true }))
        expect(s).toContain(MARCA)
        expect(s).toContain("SKILL-DEMO-DESCRIPCION")
      }),
    30_000,
  )

  it.instance(
    "bandera encendida: la sesión raíz (no hija) y el agente sin `contexto` no cambian",
    () =>
      Effect.gen(function* () {
        yield* preparar()
        process.env[BANDERA] = "1"
        const raiz = sistema(yield* peticion({ agent: "lector", hija: false }))
        expect(raiz).toContain(MARCA)
        expect(raiz).toContain("SKILL-DEMO-DESCRIPCION")
        const comun = sistema(yield* peticion({ agent: "comun", hija: true }))
        expect(comun).toContain(MARCA)
        expect(comun).toContain("SKILL-DEMO-DESCRIPCION")
      }),
    30_000,
  )

  it.instance(
    "bandera apagada: la hija trae AGENTS.md, skills y MCP como siempre (aunque declare minimo)",
    () =>
      Effect.gen(function* () {
        yield* preparar()
        delete process.env[BANDERA]
        const s = sistema(yield* peticion({ agent: "lector", hija: true }))
        expect(s).toContain(MARCA)
        expect(s).toContain("SKILL-DEMO-DESCRIPCION")
        expect(s).toContain("MCP-SIN-HERRAMIENTAS-TEXTO")
        process.env[BANDERA] = "0"
        const s0 = sistema(yield* peticion({ agent: "lector", hija: true }))
        expect(s0).toBe(s)
      }),
    30_000,
  )

  it.instance(
    "los permisos no cambian: las herramientas enviadas al modelo son las mismas con y sin bandera",
    () =>
      Effect.gen(function* () {
        yield* preparar()
        delete process.env[BANDERA]
        const apagada = yield* peticion({ agent: "lector", hija: true })
        process.env[BANDERA] = "1"
        const encendida = yield* peticion({ agent: "lector", hija: true })
        const nombres = (b: Record<string, any>) => JSON.stringify(b.tools ?? b.functions ?? null)
        expect(nombres(encendida)).toBe(nombres(apagada))
        expect(nombres(apagada)).not.toBe("null")
        // y los permisos del propio agente
        const agents = yield* AgentSvc.Service
        const lector = yield* agents.get("lector")
        expect(lector?.contexto).toBe("minimo")
        for (const nombre of ["explore", "verificador", "revisor"]) {
          const a = yield* agents.get(nombre)
          expect(a?.contexto).toBe("minimo")
          expect(Permission.disabled(["edit", "write"], a!.permission).has("edit")).toBe(true)
        }
        for (const nombre of ["general", "build"]) expect((yield* agents.get(nombre))?.contexto).toBeUndefined()
      }),
    30_000,
  )

  it.instance(
    "contexto mínimo sin prompt propio usa el prompt corto, no el base largo del proveedor",
    () =>
      Effect.gen(function* () {
        yield* preparar()
        process.env[BANDERA] = "1"
        const corto = sistema(yield* peticion({ agent: "sinprompt", hija: true }))
        expect(corto).toContain("read-only helper agent")
        delete process.env[BANDERA]
        const largo = sistema(yield* peticion({ agent: "sinprompt", hija: true }))
        expect(largo).not.toContain("read-only helper agent")
        expect(largo.length).toBeGreaterThan(corto.length + 2000)
      }),
    30_000,
  )
})

describe("ayudantes con contexto mínimo (6.3): reglas de decisión", () => {
  const denegado = [{ permission: "*", pattern: "*", action: "deny" as const }]
  const permitido = [{ permission: "*", pattern: "*", action: "allow" as const }]
  const agente = (o: Record<string, unknown> = {}) => ({ name: "x", contexto: "minimo" as const, permission: denegado, ...o })

  test("apagado por defecto: solo '1' lo enciende", () => {
    expect(ContextoMinimo.activo({})).toBe(false)
    expect(ContextoMinimo.activo({ LAZUNOX_AYUDANTES_MINIMOS: "0" })).toBe(false)
    expect(ContextoMinimo.activo({ LAZUNOX_AYUDANTES_MINIMOS: "true" })).toBe(false)
    expect(ContextoMinimo.activo({ LAZUNOX_AYUDANTES_MINIMOS: "1" })).toBe(true)
  })
  const on = { LAZUNOX_AYUDANTES_MINIMOS: "1" }
  test("minimo solo para hijas que declaran minimo y no pueden editar", () => {
    expect(ContextoMinimo.decidir({ agent: agente(), esHija: true, env: on })).toBe("minimo")
    expect(ContextoMinimo.decidir({ agent: agente(), esHija: false, env: on })).toBe("completo")
    expect(ContextoMinimo.decidir({ agent: agente({ contexto: undefined }), esHija: true, env: on })).toBe("completo")
    expect(ContextoMinimo.decidir({ agent: agente(), esHija: true, env: {} })).toBe("completo")
  })
  test("general y build nunca; con edit permitido se rechaza", () => {
    expect(ContextoMinimo.decidir({ agent: agente({ name: "general" }), esHija: true, env: on })).toBe("rechazado-nunca")
    expect(ContextoMinimo.decidir({ agent: agente({ name: "build" }), esHija: true, env: on })).toBe("rechazado-nunca")
    expect(ContextoMinimo.decidir({ agent: agente({ permission: permitido }), esHija: true, env: on })).toBe("rechazado-edita")
  })
  test("el permiso de la sesión que concede edit también lo rechaza (manda el conjunto real)", () => {
    const edit = [...denegado, { permission: "edit", pattern: "*", action: "allow" as const }]
    expect(ContextoMinimo.decidir({ agent: agente(), esHija: true, permissionSesion: edit, env: on })).toBe("rechazado-edita")
  })
  test("omitClaudeMd de Claude Code se traduce a contexto minimo", () => {
    const base = { name: "lector", description: "d" }
    expect(traducirClaude({ ...base, omitClaudeMd: true }, { soloClaude: true }).contexto).toBe("minimo")
    expect(traducirClaude({ ...base, omitClaudeMd: false }, { soloClaude: true }).contexto).toBeUndefined()
    expect(traducirClaude({ ...base, tools: "Read" }, { soloClaude: true }).contexto).toBeUndefined()
  })
})

describe("explore con exhaustividad (H4)", () => {
  test("pasos 6, 15 y 40 y nunca amplía el tope propio", () => {
    expect(Exhaustividad.PASOS).toEqual({ rapida: 6, media: 15, a_fondo: 40 })
    expect(Exhaustividad.topeEfectivo(undefined, undefined)).toBeUndefined()
    expect(Exhaustividad.topeEfectivo(20, undefined)).toBe(20)
    expect(Exhaustividad.topeEfectivo(undefined, "media")).toBe(15)
    expect(Exhaustividad.topeEfectivo(10, "a_fondo")).toBe(10)
    expect(Exhaustividad.topeEfectivo(100, "rapida")).toBe(6)
  })
  test("cada nivel añade su línea y se recuerda por sesión", () => {
    expect(Exhaustividad.linea("rapida")).toContain("6 steps")
    expect(Exhaustividad.linea("a_fondo")).toContain("40 steps")
    Exhaustividad.fijar("ses_a", "media")
    expect(Exhaustividad.nivelDe("ses_a")).toBe("media")
    expect(Exhaustividad.nivelDe("ses_b")).toBeUndefined()
    Exhaustividad.olvidar("ses_a")
    expect(Exhaustividad.nivelDe("ses_a")).toBeUndefined()
  })
  test("el parámetro de task solo existe con la bandera (apagada: esquema igual al de antes)", () => {
    expect(Object.keys(camposExhaustividad(false))).toEqual([])
    const campos = camposExhaustividad(true)
    expect(Object.keys(campos)).toEqual(["exhaustividad"])
    const esquema = Schema.Struct({ prompt: Schema.String, ...campos })
    expect(Schema.decodeUnknownSync(esquema)({ prompt: "x", exhaustividad: "rapida" }).exhaustividad).toBe("rapida")
    expect(() => Schema.decodeUnknownSync(esquema)({ prompt: "x", exhaustividad: "enorme" })).toThrow()
  })
})
