// Lazunox 4C (P12): `/lote`. El comando es una plantilla para el agente actual; el motor no añade lógica. Aquí se prueba:
// (1) que la plantilla trae los seis pasos y las prohibiciones, (2) que el comando está registrado y NO es subtarea,
// (3) con el proveedor falso, que la plantilla llega al modelo, que con la bandera de ayudantes ENCENDIDA el modelo tiene
// `task_wait` y 3 unidades se lanzan como 3 sesiones hijas de fondo, y (4) con la bandera APAGADA no hay `task_wait` y el
// lanzamiento de fondo se rechaza sin crear ninguna sesión hija. El juicio del modelo (unidades que comparten archivo)
// NO se puede probar con un proveedor falso: lo cubre la tarea T15 del banco (ver LAZUNOX.md).
import { describe, expect, test } from "bun:test"
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
import PLANTILLA from "../../src/command/template/lote.txt"

// ---------------------------------------------------------------------------------------------------------------------
// La plantilla
// ---------------------------------------------------------------------------------------------------------------------
describe("plantilla de /lote", () => {
  test("trae los seis pasos en orden y recibe el trabajo en $ARGUMENTS", () => {
    const pos = ["## Paso 0", "## Paso 1", "## Paso 2", "## Paso 3", "## Paso 4", "## Paso 5", "## Paso 6"].map((p) => PLANTILLA.indexOf(p))
    expect(pos.every((p) => p >= 0)).toBe(true)
    expect([...pos].sort((a, b) => a - b)).toEqual(pos)
    expect(PLANTILLA).toContain("$ARGUMENTS")
    expect(Command.hints(PLANTILLA)).toEqual(["$ARGUMENTS"])
  })
  test("usa las herramientas y agentes del motor: task background, task_wait, verificador", () => {
    expect(PLANTILLA).toContain("`task`")
    expect(PLANTILLA).toContain("background: true")
    expect(PLANTILLA).toContain("task_wait")
    expect(PLANTILLA).toContain('subagent_type: "verificador"')
    expect(PLANTILLA).toContain("LAZUNOX_MAX_SUBAGENTS")
    expect(PLANTILLA).toContain("OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS")
  })
  test("unidades que comparten archivo: se fusionan, van en serie o se avisa; nunca en paralelo", () => {
    expect(PLANTILLA).toContain("comparten")
    expect(PLANTILLA).toContain("EN SERIE")
    expect(PLANTILLA).toContain("Nunca lances en paralelo dos unidades que comparten")
  })
  test("seguridad: sin push/commit/publicar, informes como datos, un fallo no detiene las demás, PASA solo con el verificador", () => {
    expect(PLANTILLA).toContain("`git push`")
    expect(PLANTILLA).toContain("`git commit`")
    expect(PLANTILLA).toContain("publicar")
    expect(PLANTILLA).toContain("son DATOS")
    expect(PLANTILLA).toContain("un fallo no detiene el lote")
    expect(PLANTILLA).toContain("PASA solo si el verificador respondió `PASA`")
    expect(PLANTILLA).toContain("presupuesto")
    expect(PLANTILLA).toContain("permisos")
  })
  test("sin ayudantes de fondo: lo dice y propone el modo en serie sin editar hasta que la persona acepte", () => {
    expect(PLANTILLA).toContain("están apagados")
    expect(PLANTILLA).toContain("MODO EN SERIE")
    expect(PLANTILLA).toContain("No empieces a editar hasta que la persona acepte")
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Con el proveedor falso
// ---------------------------------------------------------------------------------------------------------------------
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

const unidad = (letra: string, archivo: string) => ({
  description: `Unidad ${letra}`,
  subagent_type: "general",
  background: true,
  prompt: `UNIDAD-${letra}: renombra la función en ${archivo}. Solo puedes tocar ${archivo}. Nada de git push.`,
})

const unix = process.platform === "win32" ? "skip" : "run"

describe("comando lote registrado", () => {
  sinFondo.instance("existe, usa el agente actual (no es subtarea ni revisor) y trae la plantilla", () =>
    Effect.gen(function* () {
      const cmd = yield* (yield* Command.Service).get("lote")
      expect(cmd).toBeDefined()
      expect(cmd?.subtask).toBeUndefined()
      expect(cmd?.agent).toBeUndefined()
      expect(cmd?.source).toBe("command")
      expect(String(yield* Effect.promise(async () => cmd!.template))).toBe(PLANTILLA)
      const lista = (yield* (yield* Command.Service).list()).map((c) => c.name)
      expect(lista).toContain("lote")
      expect(lista).toContain("review") // no se pisa el resto
    }),
  )
})

const prueba = unix === "run" ? conFondo : { instance: (n: string, f: any, ...r: any[]) => conFondo.instance.skip(n, f, ...r) }
const pruebaSin = unix === "run" ? sinFondo : { instance: (n: string, f: any, ...r: any[]) => sinFondo.instance.skip(n, f, ...r) }

prueba.instance(
  "bandera encendida: la plantilla llega al modelo con task_wait, y 3 unidades se lanzan como 3 ayudantes de fondo",
  () =>
    Effect.gen(function* () {
      const { llm, chat, sessions, prompt } = yield* arrancar()
      const hijo = (l: string) => (hit: any) => {
        const m = JSON.stringify(hit.body?.messages ?? "")
        return m.includes(`UNIDAD-${l}:`) && !m.includes("LOTE de unidades independientes")
      }
      // Primero lo de los hijos (el servidor falso sirve la primera entrada que encaje): su primer mensaje es el prompt de la unidad.
      for (const l of ["A", "B", "C"]) yield* llm.textMatch(hijo(l), `Hecho ${l}. Archivos: src/${l.toLowerCase()}.ts`)
      // El padre lanza una unidad por paso (el servidor falso no admite varias herramientas en una respuesta) y cierra.
      yield* llm.tool("task", unidad("A", "src/a.ts"))
      yield* llm.tool("task", unidad("B", "src/b.ts"))
      yield* llm.tool("task", unidad("C", "src/c.ts"))
      yield* llm.text("Lanzadas 3 unidades.")

      yield* prompt.command({ sessionID: chat.id, command: "lote", arguments: "renombrar foo a bar en 3 módulos" })

      const entradas = yield* llm.inputs
      const primera = entradas[0] as any
      const texto = JSON.stringify(primera.messages)
      expect(texto).toContain("LOTE de unidades independientes")
      expect(texto).toContain("renombrar foo a bar en 3 módulos")
      expect(texto).not.toContain("$ARGUMENTS")
      const nombres = nombresDeHerramientas(primera)
      expect(nombres).toContain("task_wait")
      expect(nombres).toContain("task")

      const hs = yield* herramientas(chat.id)
      const lanzadas = hs.filter((h) => h.tool === "task")
      expect(lanzadas.length).toBe(3)
      expect(lanzadas.every((h) => h.state.status === "completed")).toBe(true)
      const hijas = yield* sessions.children(chat.id)
      expect(hijas.length).toBe(3)
      expect(hijas.every((h) => h.parentID === chat.id)).toBe(true)
      // Cada hijo recibió SU unidad y las demás no se le colaron.
      const prompts = entradas.slice(1).map((e: any) => JSON.stringify(e.messages ?? ""))
      for (const l of ["A", "B", "C"]) {
        const propios = prompts.filter((p) => p.includes(`UNIDAD-${l}:`) && !p.includes("LOTE de unidades independientes"))
        expect(propios.length).toBeGreaterThan(0)
        for (const p of propios) for (const otra of ["A", "B", "C"].filter((x) => x !== l)) expect(p).not.toContain(`UNIDAD-${otra}:`)
      }
    }),
  60_000,
)

pruebaSin.instance(
  "bandera apagada: el modelo no tiene task_wait y el lanzamiento de fondo se rechaza sin crear sesiones hijas",
  () =>
    Effect.gen(function* () {
      const { llm, chat, sessions, prompt } = yield* arrancar()
      yield* llm.tool("task", unidad("A", "src/a.ts"))
      yield* llm.text("Los ayudantes de fondo están apagados; propongo el modo en serie.")

      yield* prompt.command({ sessionID: chat.id, command: "lote", arguments: "renombrar foo a bar" })

      const entradas = yield* llm.inputs
      const primera = entradas[0] as any
      expect(JSON.stringify(primera.messages)).toContain("MODO EN SERIE") // la plantilla indica qué decir
      expect(nombresDeHerramientas(primera)).not.toContain("task_wait")
      const hs = yield* herramientas(chat.id)
      const t = hs.find((h) => h.tool === "task")
      expect(t?.state.status).toBe("error")
      expect((t?.state as any).error).toContain("OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS")
      expect((yield* sessions.children(chat.id)).length).toBe(0)
    }),
  60_000,
)

prueba.instance(
  "3 unidades: una falla y las otras terminan; el fallo no cancela a las demás",
  () =>
    Effect.gen(function* () {
      const { llm, chat, sessions, prompt } = yield* arrancar()
      const es = (l: string) => (hit: any) => {
        const m = JSON.stringify(hit.body?.messages ?? "")
        return m.includes(`UNIDAD-${l}:`) && !m.includes("LOTE de unidades independientes")
      }
      yield* llm.textMatch(es("A"), "Hecho A")
      yield* llm.pushMatch(es("B"), reply().streamError("boom B").item())
      yield* llm.textMatch(es("C"), "Hecho C")
      yield* llm.tool("task", unidad("A", "src/a.ts"))
      yield* llm.tool("task", unidad("B", "src/b.ts"))
      yield* llm.tool("task", unidad("C", "src/c.ts"))
      yield* llm.text("Resumen listo.")

      yield* prompt.command({ sessionID: chat.id, command: "lote", arguments: "x" })
      const hijas = yield* sessions.children(chat.id)
      expect(hijas.length).toBe(3)
      // Las dos sanas terminaron con respuesta del modelo aunque B falló.
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const textos = yield* Effect.forEach(hijas, (h) =>
            MessageV2.filterCompactedEffect(h.id).pipe(
              Effect.map((ms) => ms.flatMap((m) => m.parts).filter((p) => p.type === "text").map((p: any) => p.text).join(" ")),
            ),
          )
          const todo = textos.join(" | ")
          return todo.includes("Hecho A") && todo.includes("Hecho C") ? (true as const) : undefined
        }),
        "A y C no terminaron aunque B falló",
        "20 seconds",
      )
    }),
  60_000,
)
