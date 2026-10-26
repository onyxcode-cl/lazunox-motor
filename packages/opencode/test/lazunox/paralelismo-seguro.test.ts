// Lazunox (Ola 7 — 7.3): paralelismo seguro. Candado de lectura/escritura por sesión (session/paralelismo.ts) y su cableado en
// session/tools.ts. Sin sleeps largos: la concurrencia se mide con contadores y citas (si las lecturas no corrieran a la
// vez, la cita de tres no se completaría y la prueba lo vería). `LAZUNOX_PARALELISMO_SEGURO=0` devuelve el comportamiento anterior.
import { describe, expect, test } from "bun:test"
import { Fiber } from "effect"
import { Candado, conCandado, esSoloLectura, mcpSoloLectura, activo } from "../../src/session/paralelismo"
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


// ---------------------------------------------------------------------------------------------------------------------
// Núcleo: el candado, sin motor.
// ---------------------------------------------------------------------------------------------------------------------
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

describe("7.3 núcleo: Candado", () => {
  test("lectores comparten; el escritor espera a los lectores y bloquea a los siguientes (FIFO)", async () => {
    const c = new Candado()
    const l1 = await c.adquirir("lectura")
    const l2 = await c.adquirir("lectura")
    expect(c.estado.lectores).toBe(2)
    const orden: string[] = []
    const pe = c.adquirir("escritura").then((lib) => (orden.push("E"), lib))
    const pl3 = c.adquirir("lectura").then((lib) => (orden.push("L3"), lib))
    await tick()
    expect(orden).toEqual([]) // la escritura espera a los dos lectores; L3 va detrás de ella
    l1()
    await tick()
    expect(orden).toEqual([])
    l2()
    const le = await pe
    expect(orden).toEqual(["E"])
    expect(c.estado.escritor).toBe(true)
    le()
    const l3 = await pl3
    expect(orden).toEqual(["E", "L3"])
    l3()
    expect(c.estado).toEqual({ lectores: 0, escritor: false, esperando: 0 })
  })

  test("liberar dos veces no corrompe el contador; abortar en la cola no deja huérfanos", async () => {
    const c = new Candado()
    const e = await c.adquirir("escritura")
    const ctl = new AbortController()
    const espera = c.adquirir("lectura", ctl.signal)
    const rechazo = espera.then(
      () => "entró",
      () => "abortada",
    )
    ctl.abort()
    expect(await rechazo).toBe("abortada")
    expect(c.estado.esperando).toBe(0)
    e()
    e()
    expect(c.estado).toEqual({ lectores: 0, escritor: false, esperando: 0 })
    const l = await c.adquirir("lectura") // sigue usable
    l()
  })

  test("marcas: lista cerrada y readOnlyHint estricto", () => {
    for (const id of ["read", "glob", "grep", "skill", "task_list", "tool_search"]) expect(esSoloLectura(id)).toBe(true)
    for (const id of ["bash", "edit", "write", "apply_patch", "todowrite", "webfetch", "mcp_call", "lsp"])
      expect(esSoloLectura(id)).toBe(false)
    expect(mcpSoloLectura({ annotations: { readOnlyHint: true } })).toBe(true)
    expect(mcpSoloLectura({ annotations: { readOnlyHint: "true" } })).toBe(false)
    expect(mcpSoloLectura({ annotations: {} })).toBe(false)
    expect(mcpSoloLectura({})).toBe(false)
    expect(mcpSoloLectura(undefined)).toBe(false)
  })

  test("conCandado: dos escrituras de la misma sesión no se solapan; de sesiones distintas sí; un fallo no cancela a las demás", async () => {
    let activas = 0
    let max = 0
    const trabajo = (falla = false) => async () => {
      activas++
      max = Math.max(max, activas)
      await tick()
      await tick()
      activas--
      if (falla) throw new Error("boom")
      return "ok"
    }
    const r = await Promise.allSettled([
      conCandado("s1", false, undefined, trabajo(true)),
      conCandado("s1", false, undefined, trabajo()),
      conCandado("s1", false, undefined, trabajo()),
    ])
    expect(max).toBe(1)
    expect(r.map((x) => x.status)).toEqual(["rejected", "fulfilled", "fulfilled"])
    max = 0
    await Promise.all([conCandado("a", false, undefined, trabajo()), conCandado("b", false, undefined, trabajo())])
    expect(max).toBe(2)
  })

  test("interruptor LAZUNOX_PARALELISMO_SEGURO=0 apaga el candado", async () => {
    const antes = process.env.LAZUNOX_PARALELISMO_SEGURO
    try {
      process.env.LAZUNOX_PARALELISMO_SEGURO = "0"
      expect(activo()).toBe(false)
      let activas = 0
      let max = 0
      const t = async () => {
        activas++
        max = Math.max(max, activas)
        await tick()
        await tick()
        activas--
      }
      await Promise.all([conCandado("x", false, undefined, t), conCandado("x", false, undefined, t)])
      expect(max).toBe(2)
    } finally {
      if (antes === undefined) delete process.env.LAZUNOX_PARALELISMO_SEGURO
      else process.env.LAZUNOX_PARALELISMO_SEGURO = antes
    }
    expect(activo()).toBe(true)
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
// Con el motor: herramientas del proyecto que sustituyen a las nativas (mismo id) y anotan su paso en `globalThis.__lzxPS`.
// ---------------------------------------------------------------------------------------------------------------------
type Marca = { id: string; call: string; ev: "ini" | "fin" | "tope"; n: number }
const reg = () => (globalThis as any).__lzxPS as { activas: number; max: number; ev: Marca[]; citaFallida: boolean }

// `cuerpo` es JS dentro de `execute(_a, ctx)`. Ayudantes: entrar(), salir(), cita(n) (espera a n activas, máx. 4 s).
const herramienta = (id: string, cuerpo: string) => `
const g = () => globalThis.__lzxPS
const marca = (ev) => g().ev.push({ id: "${id}", call: ctx_call, ev, n: g().activas })
let ctx_call = ""
const entrar = () => { g().activas++; g().max = Math.max(g().max, g().activas); marca("ini") }
const salir = () => { g().activas--; marca("fin") }
const pausa = () => new Promise((r) => setTimeout(r, 25))
const cita = async (n) => {
  const t0 = Date.now()
  while (g().activas < n) {
    if (Date.now() - t0 > 4000) { g().citaFallida = true; return }
    await new Promise((r) => setTimeout(r, 5))
  }
}
export default {
  description: "t ${id}",
  args: {},
  async execute(_a, ctx) {
    ctx_call = ctx.callID
    ${cuerpo}
  },
}
`

const arrancarPS = Effect.fn("paralelismo.arrancar")(function* (
  herramientas: Record<string, string>,
  permission: { permission: string; pattern: string; action: "allow" | "ask" | "deny" }[] = [{ permission: "*", pattern: "*", action: "allow" }],
) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  const fsu = yield* FSUtil.Service
  yield* fsu.writeWithDirs(path.join(dir, "opencode.json"), JSON.stringify(cfg(llm.url)))
  for (const [id, cuerpo] of Object.entries(herramientas))
    yield* fsu.writeWithDirs(path.join(dir, ".opencode", "tool", `${id}.ts`), herramienta(id, cuerpo))
  ;(globalThis as any).__lzxPS = { activas: 0, max: 0, ev: [], citaFallida: false }
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({ title: "paralelismo", permission })
  return { dir, llm, chat, sessions, prompt: yield* SessionPrompt.Service }
})

const partesTool = (id: SessionID) =>
  MessageV2.filterCompactedEffect(id).pipe(
    Effect.map((ms) => ms.flatMap((m) => m.parts).filter((p): p is SessionV1.ToolPart => p.type === "tool")),
  )

describe("7.3 con el motor", () => {
  it.instance(
    "dos edit al mismo paso NO se solapan (la segunda empieza cuando la primera terminó)",
    () =>
      Effect.gen(function* () {
        const { llm, chat, prompt } = yield* arrancarPS({ edit: `entrar(); await pausa(); salir(); return "ok"` })
        yield* llm.push(variasLlamadas([{ name: "edit", input: {} }, { name: "edit", input: {} }]))
        yield* llm.text("listo")
        yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "edita dos veces" }] })
        const r = reg()
        expect(r.max).toBe(1)
        expect(r.ev.map((e) => e.ev)).toEqual(["ini", "fin", "ini", "fin"])
        const hs = yield* partesTool(chat.id)
        expect(hs.every((h) => h.state.status === "completed")).toBe(true)
      }),
    60_000,
  )

  it.instance(
    "tres lecturas del mismo paso corren a la vez (cita de tres, sin relojes)",
    () =>
      Effect.gen(function* () {
        const { llm, chat, prompt } = yield* arrancarPS({
          read: `entrar(); await cita(3); await pausa(); salir(); return "ok"`,
          grep: `entrar(); await cita(3); await pausa(); salir(); return "ok"`,
          glob: `entrar(); await cita(3); await pausa(); salir(); return "ok"`,
        })
        yield* llm.push(variasLlamadas([{ name: "read", input: {} }, { name: "grep", input: {} }, { name: "glob", input: {} }]))
        yield* llm.text("listo")
        yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "lee" }] })
        const r = reg()
        expect(r.citaFallida).toBe(false)
        expect(r.max).toBe(3)
        const hs = yield* partesTool(chat.id)
        expect(hs.map((h) => h.tool)).toEqual(["read", "grep", "glob"])
        expect(hs.every((h) => h.state.status === "completed")).toBe(true)
      }),
    60_000,
  )

  it.instance(
    "read, edit, read: la escritura espera a la primera lectura y la segunda lectura espera a la escritura; orden de resultados = pedido",
    () =>
      Effect.gen(function* () {
        const { llm, chat, prompt } = yield* arrancarPS({
          read: `entrar(); await pausa(); salir(); return "ok"`,
          edit: `entrar(); await pausa(); salir(); return "ok"`,
        })
        yield* llm.push(variasLlamadas([{ name: "read", input: {} }, { name: "edit", input: {} }, { name: "read", input: {} }]))
        yield* llm.text("listo")
        yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "lee, edita, lee" }] })
        const r = reg()
        expect(r.max).toBe(1)
        expect(r.ev.map((e) => `${e.id}:${e.ev}`)).toEqual([
          "read:ini",
          "read:fin",
          "edit:ini",
          "edit:fin",
          "read:ini",
          "read:fin",
        ])
        const hs = yield* partesTool(chat.id)
        expect(hs.map((h) => h.tool)).toEqual(["read", "edit", "read"])
      }),
    60_000,
  )

  it.instance(
    "un fallo en una escritura no cancela a las demás ni deja el candado tomado",
    () =>
      Effect.gen(function* () {
        const { llm, chat, prompt } = yield* arrancarPS({
          edit: `entrar(); await pausa(); salir(); throw new Error("fallo a propósito")`,
          read: `entrar(); await pausa(); salir(); return "ok"`,
        })
        yield* llm.push(variasLlamadas([{ name: "edit", input: {} }, { name: "edit", input: {} }, { name: "read", input: {} }]))
        yield* llm.text("listo")
        yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "x" }] })
        const hs = yield* partesTool(chat.id)
        expect(hs.map((h) => h.state.status)).toEqual(["error", "error", "completed"])
        expect(reg().ev.filter((e) => e.ev === "fin")).toHaveLength(3) // las tres llegaron a correr
        expect(reg().max).toBe(1)
      }),
    60_000,
  )

  it.instance(
    "un permiso pendiente en una lectura NO bloquea a las otras lecturas lanzadas; al responder, termina",
    () =>
      Effect.gen(function* () {
        const { llm, chat, prompt } = yield* arrancarPS(
          {
            read: `entrar(); if (ctx.callID === "call_0") { await ctx.ask({ permission: "read", patterns: ["pendiente"], always: [], metadata: {} }) } await pausa(); salir(); return "ok"`,
          },
          [
            { permission: "*", pattern: "*", action: "allow" },
            { permission: "read", pattern: "pendiente", action: "ask" },
          ],
        )
        yield* llm.push(variasLlamadas([{ name: "read", input: { n: 1 } }, { name: "read", input: { n: 2 } }, { name: "read", input: { n: 3 } }])) // entradas distintas: tres iguales disparan doom_loop
        yield* llm.text("listo")
        const permission = yield* Permission.Service
        const fiber = yield* prompt
          .prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "lee tres" }] })
          .pipe(Effect.forkChild)
        const pendiente = yield* pollWithTimeout(
          permission.list().pipe(Effect.map((l) => l.find((x) => x.sessionID === chat.id))),
          "nunca se pidió el permiso",
          "10 seconds",
        )
        // Las otras dos lecturas terminan mientras la primera sigue esperando a la persona.
        yield* pollWithTimeout(
          Effect.sync(() => (reg().ev.filter((e) => e.ev === "fin").length >= 2 ? true : undefined)),
          "las lecturas libres quedaron bloqueadas por el permiso pendiente",
          "10 seconds",
        )
        expect(reg().ev.filter((e) => e.ev === "fin")).toHaveLength(2)
        yield* permission.reply({ requestID: pendiente.id, reply: "once" })
        yield* Fiber.join(fiber)
        const hs = yield* partesTool(chat.id)
        expect(hs.map((h) => h.state.status)).toEqual(["completed", "completed", "completed"])
      }),
    60_000,
  )

  it.instance(
    "interruptor LAZUNOX_PARALELISMO_SEGURO=0: dos edit vuelven a solaparse (comportamiento anterior)",
    () =>
      Effect.gen(function* () {
        const antes = process.env.LAZUNOX_PARALELISMO_SEGURO
        process.env.LAZUNOX_PARALELISMO_SEGURO = "0"
        try {
          const { llm, chat, prompt } = yield* arrancarPS({ edit: `entrar(); await cita(2); await pausa(); salir(); return "ok"` })
          yield* llm.push(variasLlamadas([{ name: "edit", input: {} }, { name: "edit", input: {} }]))
          yield* llm.text("listo")
          yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "x" }] })
          expect(reg().max).toBe(2)
          expect(reg().citaFallida).toBe(false)
        } finally {
          if (antes === undefined) delete process.env.LAZUNOX_PARALELISMO_SEGURO
          else process.env.LAZUNOX_PARALELISMO_SEGURO = antes
        }
      }),
    60_000,
  )
})
