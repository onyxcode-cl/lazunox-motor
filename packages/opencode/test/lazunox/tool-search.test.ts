import { afterEach, describe, expect, test } from "bun:test"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { MessageID, SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { SessionTools } from "../../src/session/tools"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { ToolRegistry } from "../../src/tool/registry"
import { ToolSearch } from "../../src/tool/tool-search"
import { Truncate } from "../../src/tool/truncate"

// ---------- Parte pura ----------

const def = (name: string, description: string, props: Record<string, any> = {}, required: string[] = []) =>
  ({ name, description, inputSchema: { type: "object", properties: props, required } }) as any
const ent = (server: string, name: string, description = "", props: Record<string, any> = {}, required: string[] = []) =>
  ({ key: `${server}_${name}`, server, def: def(name, description, props, required), source: null }) satisfies ToolSearch.Entry<null>
const big = (n: number) => "x".repeat(n)
const cfg = (env: Record<string, string> = {}) => ToolSearch.config({ LAZUNOX_TOOL_SEARCH: "auto", ...env })
const visibleAll = (entries: ToolSearch.Entry<null>[]) => new Set(entries.map((e) => e.key))

describe("configuración", () => {
  test("valores por defecto y variables", () => {
    expect(ToolSearch.config({ LAZUNOX_AHORRO_TOKENS: "0" })).toMatchObject({ mode: "off", minTokens: 4000 })
    expect(cfg({ LAZUNOX_TOOL_SEARCH: "auto" }).mode).toBe("auto")
    expect(ToolSearch.config({}).keep.size).toBe(0)
    expect(cfg({ LAZUNOX_TOOL_SEARCH: "ON" }).mode).toBe("on")
    expect(cfg({ LAZUNOX_TOOL_SEARCH: "off" }).mode).toBe("off")
    expect(cfg({ LAZUNOX_TOOL_SEARCH: "raro" }).mode).toBe("off")
    expect(cfg({ LAZUNOX_TOOL_SEARCH_MIN_TOKENS: "10" }).minTokens).toBe(10)
    expect(cfg({ LAZUNOX_TOOL_SEARCH_MIN_TOKENS: "abc" }).minTokens).toBe(4000)
    expect([...cfg({ LAZUNOX_TOOL_SEARCH_KEEP: "browser, computer ,bgshell" }).keep]).toEqual(["browser", "computer", "bgshell"])
  })
})

describe("umbral", () => {
  const pocas = [ent("a", "uno", "corta"), ent("a", "dos", "corta")]
  const muchas = Array.from({ length: 40 }, (_, i) => ent("muchas", `t${i}`, big(600)))

  test("por debajo del umbral no se difiere; por encima sí", () => {
    expect(ToolSearch.decide(pocas, visibleAll(pocas), cfg(), false).deferred).toHaveLength(0)
    const d = ToolSearch.decide(muchas, visibleAll(muchas), cfg(), false)
    expect(d.deferred).toHaveLength(40)
    expect(d.direct).toHaveLength(0)
  })
  test("MIN_TOKENS se respeta", () => {
    expect(ToolSearch.decide(pocas, visibleAll(pocas), cfg({ LAZUNOX_TOOL_SEARCH_MIN_TOKENS: "1" }), false).deferred).toHaveLength(2)
  })
  test("on difiere aunque sea poco; off nunca; Code Mode nunca", () => {
    expect(ToolSearch.decide(pocas, visibleAll(pocas), cfg({ LAZUNOX_TOOL_SEARCH: "on" }), false).deferred).toHaveLength(2)
    expect(ToolSearch.decide(muchas, visibleAll(muchas), cfg({ LAZUNOX_TOOL_SEARCH: "off" }), false).deferred).toHaveLength(0)
    expect(ToolSearch.decide(muchas, visibleAll(muchas), cfg({ LAZUNOX_TOOL_SEARCH: "on" }), true).deferred).toHaveLength(0)
  })
  test("KEEP deja esos servidores como herramientas directas", () => {
    const todo = [...muchas, ent("browser", "click", big(5000)), ent("Computer", "key", big(5000))]
    const d = ToolSearch.decide(todo, visibleAll(todo), cfg({ LAZUNOX_TOOL_SEARCH_KEEP: "browser,computer" }), false)
    expect(d.direct.map((e) => e.key).toSorted()).toEqual(["Computer_key", "browser_click"])
    expect(d.deferred).toHaveLength(40)
  })
  test("lo no visible no cuenta para el umbral ni se difiere", () => {
    const visibles = new Set(["a_uno"])
    const d = ToolSearch.decide(muchas, visibles, cfg(), false)
    expect(d.deferred).toHaveLength(0)
    expect(d.direct).toHaveLength(40)
  })
  test("es determinista", () => {
    const a = ToolSearch.decide(muchas, visibleAll(muchas), cfg(), false)
    const b = ToolSearch.decide([...muchas].reverse(), visibleAll(muchas), cfg(), false)
    expect(ToolSearch.buildIndex(a.deferred)).toBe(ToolSearch.buildIndex(b.deferred))
  })
})

describe("índice", () => {
  test("ordenado y estable sin importar el orden de entrada", () => {
    const e = [ent("zeta", "b"), ent("alfa", "z"), ent("alfa", "a"), ent("zeta", "a")]
    const esperado = "alfa (2): alfa_a, alfa_z\nzeta (2): zeta_a, zeta_b"
    expect(ToolSearch.buildIndex(e)).toBe(esperado)
    expect(ToolSearch.buildIndex([...e].reverse())).toBe(esperado)
  })
  test("se recorta si es enorme", () => {
    const e = Array.from({ length: 2000 }, (_, i) => ent("s", `herramienta_larga_${i}`))
    expect(ToolSearch.buildIndex(e).length).toBeLessThan(6200)
  })
})

describe("búsqueda", () => {
  const e = [
    ent("gmail", "send_message", "Envía un correo", { to: { description: "destinatario" } }),
    ent("gmail", "send", "Envía algo"),
    ent("cal", "create_event", "Crea un evento de calendario"),
    ent("tix", "create_ticket", "Crea un ticket de soporte", { title: { description: "título" } }),
  ]
  test("select: es coincidencia exacta y sensible a mayúsculas; el parecido no ejecuta nada y sugiere", () => {
    const r = ToolSearch.search(e, "select:gmail_send,Gmail_send_message,nada")
    expect(r.matches.map((m) => m.key)).toEqual(["gmail_send"])
    expect(r.missing.map((m) => m.name)).toEqual(["Gmail_send_message", "nada"])
    expect(r.missing[0].suggestions).toContain("gmail_send_message")
  })
  test("texto libre ordena por relevancia", () => {
    expect(ToolSearch.search(e, "crear ticket").matches[0].key).toBe("tix_create_ticket")
    expect(ToolSearch.search(e, "tickets").matches[0].key).toBe("tix_create_ticket")
    expect(ToolSearch.search(e, "destinatario").matches[0].key).toBe("gmail_send_message")
  })
  test("nombre exacto es una consulta directa", () => {
    expect(ToolSearch.search(e, "gmail_send").matches.map((m) => m.key)).toEqual(["gmail_send"])
  })
  test("limit entre 1 y 10, 5 por defecto", () => {
    const m = Array.from({ length: 30 }, (_, i) => ent("s", `crear_${i}`, "crear"))
    expect(ToolSearch.search(m, "crear").matches).toHaveLength(5)
    expect(ToolSearch.search(m, "crear", 99).matches).toHaveLength(10)
    expect(ToolSearch.search(m, "crear", 0).matches).toHaveLength(1)
    expect(ToolSearch.search(m, "crear", 3).total).toBe(30)
  })
  test("el resultado tiene tope de 16 KB", () => {
    const m = Array.from({ length: 10 }, (_, i) => ent("s", `t${i}`, "d".repeat(5000)))
    const texto = ToolSearch.formatResult(ToolSearch.search(m, "d", 10), "d")
    expect(Buffer.byteLength(texto)).toBeLessThan(ToolSearch.MAX_RESULT_BYTES + 1000)
    expect(texto).toContain("Se omitieron")
    // aun una sola herramienta gigante se recorta
    const una = ToolSearch.formatResult(ToolSearch.search([ent("s", "g", "d".repeat(40000))], "g"), "g")
    expect(Buffer.byteLength(una)).toBeLessThan(ToolSearch.MAX_RESULT_BYTES + 1000)
  })
  test("incluye descripción completa y esquema", () => {
    const texto = ToolSearch.formatResult(ToolSearch.search(e, "select:tix_create_ticket"), "x")
    expect(texto).toContain("Crea un ticket de soporte")
    expect(texto).toContain('"title"')
    expect(texto).toContain("mcp_call")
  })
})

describe("validación de argumentos", () => {
  const d = def("x", "", { n: { type: "integer" }, s: { type: "string" }, o: { type: "object" } }, ["s"])
  test("required y tipos de primer nivel", () => {
    expect(ToolSearch.validateArguments(d, {})).toContain("s")
    expect(ToolSearch.validateArguments(d, { s: "a", n: 1.5 })).toContain("n debe ser integer")
    expect(ToolSearch.validateArguments(d, { s: 1 })).toContain("s debe ser string")
    expect(ToolSearch.validateArguments(d, { s: "a", n: 2, o: {} })).toBeUndefined()
  })
})

describe("reescritura de llamada directa", () => {
  const hay = (...names: string[]) => (n: string) => names.includes(n)
  test("herramienta fuera de la lista + mcp_call disponible → mcp_call", () => {
    expect(ToolSearch.rewriteDirectCall("x_start", '{"a":1}', hay("mcp_call", "tool_search"))).toEqual({
      toolName: "mcp_call",
      input: JSON.stringify({ tool: "x_start", arguments: { a: 1 } }),
    })
    expect(ToolSearch.rewriteDirectCall("x_start", "", hay("mcp_call"))?.input).toBe('{"tool":"x_start","arguments":{}}')
  })
  test("sin mcp_call, con la herramienta presente o con entrada no objeto → no se reescribe", () => {
    expect(ToolSearch.rewriteDirectCall("x_start", "{}", hay("bash"))).toBeUndefined()
    expect(ToolSearch.rewriteDirectCall("x_start", "{}", hay("mcp_call", "x_start"))).toBeUndefined()
    expect(ToolSearch.rewriteDirectCall("x_start", "[1]", hay("mcp_call"))).toBeUndefined()
    expect(ToolSearch.rewriteDirectCall("x_start", "{roto", hay("mcp_call"))).toBeUndefined()
  })
})

describe("Permission.disabled y tool_search/mcp_call", () => {
  const deny = (permission: string) => ({ permission, pattern: "*", action: "deny" as const })
  test("un `*: deny` genérico no los oculta; una regla con su nombre sí", () => {
    const todas = ["bash", "tool_search", "mcp_call"]
    expect([...Permission.disabled(todas, [deny("*")])]).toEqual(["bash"])
    expect([...Permission.disabled(todas, [deny("*"), deny("mcp_call")])].toSorted()).toEqual(["bash", "mcp_call"])
    expect([...Permission.disabled(todas, [deny("tool_search")])]).toEqual(["tool_search"])
  })
})

// ---------- Integración con SessionTools.resolve ----------

const sessionID = SessionID.make("ses_ts")
const messageID = MessageID.ascending()
const model = { providerID: ProviderV2.ID.make("test"), api: { id: "test-model" } } as Provider.Model
const allowAll = [{ permission: "*", pattern: "*", action: "allow" as const }]

const guardado = { ...process.env }
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in guardado)) delete process.env[k]
  Object.assign(process.env, guardado)
})

function montar(opts: {
  mcpTools: Record<string, { name: string; description?: string; props?: Record<string, any>; required?: string[] }>
  askDeny?: (permission: string) => boolean
  hook?: (tool: string, args: Record<string, unknown>) => void
  agentPermission?: any[]
  sessionPermission?: any[]
  userTools?: Record<string, boolean>
  codeMode?: boolean
  extraServers?: Record<string, string[]> // servidor -> nombres de herramienta (cliente aparte)
}) {
  const llamadas: { name: string; arguments: any }[] = []
  const asks: string[] = []
  const hooks: { tool: string; args: any }[] = []
  const cliente = {
    getServerCapabilities: () => ({ tools: {} }),
    callTool: async (p: any) => {
      llamadas.push(p)
      return { content: [{ type: "text", text: `ok:${p.name}:${JSON.stringify(p.arguments)}` }] }
    },
  }
  const otro = { getServerCapabilities: cliente.getServerCapabilities, callTool: cliente.callTool }
  const mcpTools: Record<string, any> = {}
  for (const [key, t] of Object.entries(opts.mcpTools)) {
    const esDelOtro = key.startsWith("browser_")
    mcpTools[key] = {
      def: { name: t.name, description: t.description ?? "", inputSchema: { type: "object", properties: t.props ?? {}, required: t.required ?? [] } },
      client: esDelOtro ? otro : cliente,
      timeout: 1000,
    }
  }
  const fakeMcp = MCP.Service.of({
    tools: () => Effect.succeed(mcpTools),
    clients: () => Effect.succeed({ x: cliente, browser: otro } as any),
  } as Partial<MCP.Interface> as MCP.Interface)
  const fakePlugin = Plugin.Service.of({
    init: () => Effect.void,
    list: () => Effect.succeed([]),
    trigger: ((name: string, input: any, output: any) => {
      if (name === "tool.execute.before") {
        hooks.push({ tool: input.tool, args: output.args })
        opts.hook?.(input.tool, output.args)
      }
      return Effect.succeed(output)
    }) as any,
  } satisfies Plugin.Interface)
  const fakePermission = Permission.Service.of({
    ask: (req: any) => {
      asks.push(req.permission)
      return opts.askDeny?.(req.permission) ? Effect.die(new Error(`denegado:${req.permission}`)) : Effect.void
    },
    reply: () => Effect.void,
    list: () => Effect.succeed([]),
  } satisfies Permission.Interface)
  const fakeTruncate = Truncate.Service.of({
    cleanup: () => Effect.void,
    write: () => Effect.succeed("o.txt"),
    output: (text: string) => Effect.succeed({ content: text, truncated: false }),
    limits: () => Effect.succeed({ maxLines: 2000, maxBytes: 50 * 1024 }),
  } satisfies Truncate.Interface)
  const registry = ToolRegistry.Service.of({
    ids: () => Effect.succeed([]),
    all: () => Effect.succeed([]),
    named: () => Effect.die("unused"),
    tools: () => Effect.succeed([]),
  } as any)
  const layer = Layer.mergeAll(
    Layer.succeed(Plugin.Service, fakePlugin),
    Layer.succeed(Permission.Service, fakePermission),
    Layer.succeed(MCP.Service, fakeMcp),
    Layer.succeed(Truncate.Service, fakeTruncate),
    Layer.succeed(ToolRegistry.Service, registry),
    RuntimeFlags.layer({ experimentalCodeMode: opts.codeMode ?? false }),
  )
  const agent: Agent.Info = { name: "build", mode: "primary", options: {}, permission: opts.agentPermission ?? allowAll }
  const processor = {
    message: {
      id: messageID, sessionID, role: "assistant", parentID: MessageID.ascending(), agent: "build", mode: "build",
      path: { cwd: "/tmp", root: "/tmp" }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ModelV2.ID.make("test-model"), providerID: ProviderV2.ID.make("test"), time: { created: 1 },
    },
    updateToolCall: () => Effect.die("unused"),
    completeToolCall: () => Effect.void,
  } as any
  const resolver = () =>
    Effect.runPromise(
      SessionTools.resolve({
        agent, model,
        session: { id: sessionID, permission: opts.sessionPermission ?? [] } as unknown as Session.Info,
        processor, bypassAgentCheck: false, messages: [], promptOps: {} as never, userTools: opts.userTools,
      }).pipe(Effect.provide(layer)),
    )
  const exec = async (tools: Record<string, any>, name: string, args: unknown, id = "c1") =>
    tools[name].execute(args, { toolCallId: id, abortSignal: new AbortController().signal, messages: [] })
  return { resolver, exec, llamadas, asks, hooks }
}

const muchas = Object.fromEntries(
  Array.from({ length: 30 }, (_, i) => [`x_t${i}`, { name: `t${i}`, description: "d".repeat(500) }]),
)
const conStart = {
  ...muchas,
  x_start: { name: "start", description: "Inicia", props: { id: { type: "string" } }, required: ["id"] },
  x_secret: { name: "secret", description: "Secreto" },
}

describe("SessionTools con búsqueda diferida", () => {
  test("on: salen las x_* y entran tool_search + mcp_call; off: como siempre", async () => {
    process.env.LAZUNOX_TOOL_SEARCH = "on"
    const m = montar({ mcpTools: conStart })
    const tools = await m.resolver()
    expect(Object.keys(tools).filter((k) => k.startsWith("x_"))).toEqual([])
    expect(tools.tool_search).toBeDefined()
    expect(tools.mcp_call).toBeDefined()
    expect((tools.tool_search as any).description).toContain("x (32):")

    process.env.LAZUNOX_TOOL_SEARCH = "off"
    const t2 = await montar({ mcpTools: conStart }).resolver()
    expect(t2.tool_search).toBeUndefined()
    expect(t2.mcp_call).toBeUndefined()
    expect(t2.x_start).toBeDefined()
  })

  test("auto: poco catálogo no activa; mucho sí", async () => {
    delete process.env.LAZUNOX_TOOL_SEARCH
    process.env.LAZUNOX_AHORRO_TOKENS = "0"
    expect((await montar({ mcpTools: conStart }).resolver()).tool_search).toBeUndefined() // ausente = off (con el ahorro apagado)
    delete process.env.LAZUNOX_AHORRO_TOKENS
    process.env.LAZUNOX_TOOL_SEARCH = "auto"
    const poco = await montar({ mcpTools: { x_start: conStart.x_start } }).resolver()
    expect(poco.tool_search).toBeUndefined()
    expect(poco.x_start).toBeDefined()
    const mucho = await montar({ mcpTools: conStart }).resolver()
    expect(mucho.tool_search).toBeDefined()
  })

  test("KEEP: browser sigue directo y mcp_call lo rechaza", async () => {
    process.env.LAZUNOX_TOOL_SEARCH = "on"
    process.env.LAZUNOX_TOOL_SEARCH_KEEP = "browser"
    const m = montar({ mcpTools: { ...conStart, browser_click: { name: "click" } } })
    const tools = await m.resolver()
    expect(tools.browser_click).toBeDefined()
    await expect(m.exec(tools, "mcp_call", { tool: "browser_click", arguments: {} })).rejects.toThrow(/directamente/)
    expect(m.llamadas).toHaveLength(0)
  })

  test("Code Mode encendido: no aparecen", async () => {
    process.env.LAZUNOX_TOOL_SEARCH = "on"
    const tools = await montar({ mcpTools: conStart, codeMode: true }).resolver()
    expect(tools.tool_search).toBeUndefined()
    expect(tools.mcp_call).toBeUndefined()
  })

  test("tool_search devuelve esquema; select: es exacto", async () => {
    process.env.LAZUNOX_TOOL_SEARCH = "on"
    const m = montar({ mcpTools: conStart })
    const tools = await m.resolver()
    const r = await m.exec(tools, "tool_search", { query: "select:x_start" })
    expect(r.output).toContain("## x_start")
    expect(r.output).toContain('"required":["id"]')
    expect(r.metadata.matches).toEqual(["x_start"])
    const sin = await m.exec(tools, "tool_search", { query: "select:X_START" })
    expect(sin.output).toContain("No existe")
    await expect(m.exec(tools, "tool_search", {})).rejects.toThrow(/query/)
  })

  test("mcp_call ejecuta por el mismo camino: gancho con la clave real y el MISMO args, permiso con la clave real", async () => {
    process.env.LAZUNOX_TOOL_SEARCH = "on"
    const m = montar({ mcpTools: conStart, hook: (tool, args) => void (tool === "x_start" && (args.inyectado = "ses")) })
    const tools = await m.resolver()
    const args = { id: "7" }
    const r = await m.exec(tools, "mcp_call", { tool: "x_start", arguments: args })
    expect(m.hooks.map((h) => h.tool)).toEqual(["x_start"]) // nunca "mcp_call"
    expect(m.hooks[0].args).toBe(args)
    expect(m.llamadas[0].arguments).toBe(args)
    expect(m.llamadas[0].arguments).toEqual({ id: "7", inyectado: "ses" })
    expect(m.asks).toEqual(["x_start"])
    expect(r.title).toBe("x_start")
    expect(r.metadata.lazunoxMcp).toEqual({ tool: "x_start", server: "x" })
    expect(r.output).toContain("ok:start")
  })

  test("mcp_call con nombre inexistente o parecido no ejecuta", async () => {
    process.env.LAZUNOX_TOOL_SEARCH = "on"
    const m = montar({ mcpTools: conStart })
    const tools = await m.resolver()
    await expect(m.exec(tools, "mcp_call", { tool: "x_star", arguments: {} })).rejects.toThrow(/No existe.*x_start/)
    await expect(m.exec(tools, "mcp_call", { tool: "X_START", arguments: { id: "1" } })).rejects.toThrow(/No existe/)
    await expect(m.exec(tools, "mcp_call", { tool: "x_*", arguments: {} })).rejects.toThrow(/No existe/)
    await expect(m.exec(tools, "mcp_call", { arguments: {} })).rejects.toThrow(/tool is required/)
    expect(m.llamadas).toHaveLength(0)
    expect(m.asks).toHaveLength(0)
  })

  test("mcp_call valida required y tipos antes de llamar", async () => {
    process.env.LAZUNOX_TOOL_SEARCH = "on"
    const m = montar({ mcpTools: conStart })
    const tools = await m.resolver()
    await expect(m.exec(tools, "mcp_call", { tool: "x_start", arguments: {} })).rejects.toThrow(/obligatorios/)
    await expect(m.exec(tools, "mcp_call", { tool: "x_start", arguments: { id: 5 } })).rejects.toThrow(/tipo/)
    await expect(m.exec(tools, "mcp_call", { tool: "x_start", arguments: "x" })).rejects.toThrow(/object/)
    expect(m.llamadas).toHaveLength(0)
  })

  test("user.tools=false oculta la herramienta también a mcp_call y a tool_search", async () => {
    process.env.LAZUNOX_TOOL_SEARCH = "on"
    const m = montar({ mcpTools: conStart, userTools: { x_start: false } })
    const tools = await m.resolver()
    await expect(m.exec(tools, "mcp_call", { tool: "x_start", arguments: { id: "1" } })).rejects.toThrow(/No existe/)
    const r = await m.exec(tools, "tool_search", { query: "select:x_start,x_t1" })
    expect(r.output).toContain("## x_t1")
    expect(r.output).not.toContain("## x_start")
    expect((tools.tool_search as any).description).not.toContain("x_start")
    expect(m.llamadas).toHaveLength(0)
  })

  test("regla deny `x_*` (agente) deja el catálogo vacío: ni tool_search ni mcp_call", async () => {
    process.env.LAZUNOX_TOOL_SEARCH = "on"
    const m = montar({
      mcpTools: conStart,
      agentPermission: [...allowAll, { permission: "x_*", pattern: "*", action: "deny" }],
    })
    const tools = await m.resolver()
    expect(tools.tool_search).toBeUndefined()
    expect(tools.mcp_call).toBeUndefined()
  })

  test("regla deny de sesión sobre una sola herramienta: no está en el catálogo; el resto sí", async () => {
    process.env.LAZUNOX_TOOL_SEARCH = "on"
    const m = montar({
      mcpTools: conStart,
      sessionPermission: [{ permission: "x_start", pattern: "*", action: "deny" }],
    })
    const tools = await m.resolver()
    await expect(m.exec(tools, "mcp_call", { tool: "x_start", arguments: { id: "1" } })).rejects.toThrow(/No existe/)
    await m.exec(tools, "mcp_call", { tool: "x_t1", arguments: {} })
    expect(m.llamadas.map((l) => l.name)).toEqual(["t1"])
  })

  test("agente con `*: deny` y solo `x_start: allow`: x_start sí, x_secret no", async () => {
    process.env.LAZUNOX_TOOL_SEARCH = "on"
    process.env.LAZUNOX_TOOL_SEARCH_MIN_TOKENS = "0"
    const m = montar({
      mcpTools: { x_start: conStart.x_start, x_secret: conStart.x_secret },
      agentPermission: [
        { permission: "*", pattern: "*", action: "deny" },
        { permission: "x_start", pattern: "*", action: "allow" },
      ],
    })
    const tools = await m.resolver()
    expect((tools.tool_search as any).description).toContain("x_start")
    expect((tools.tool_search as any).description).not.toContain("x_secret")
    await expect(m.exec(tools, "mcp_call", { tool: "x_secret", arguments: {} })).rejects.toThrow(/No existe/)
    await m.exec(tools, "mcp_call", { tool: "x_start", arguments: { id: "1" } })
    expect(m.llamadas.map((l) => l.name)).toEqual(["start"])
  })

  test("ask (regla `ask`/`deny` de herramienta suelta) se aplica con la clave real: denegar → no llama al servidor", async () => {
    process.env.LAZUNOX_TOOL_SEARCH = "on"
    const m = montar({ mcpTools: conStart, askDeny: (p) => p === "x_secret" })
    const tools = await m.resolver()
    await expect(m.exec(tools, "mcp_call", { tool: "x_secret", arguments: {} })).rejects.toThrow(/denegado:x_secret/)
    expect(m.llamadas).toHaveLength(0)
    await m.exec(tools, "mcp_call", { tool: "x_start", arguments: { id: "1" } })
    expect(m.llamadas).toHaveLength(1)
  })

  test("la puerta del plan (gancho que lanza para nombres no permitidos) ve x_start y bloquea sin llamar al servidor", async () => {
    process.env.LAZUNOX_TOOL_SEARCH = "on"
    const m = montar({
      mcpTools: conStart,
      hook: (tool) => {
        if (tool !== "tool_search") throw new Error(`plan-gate:${tool}`)
      },
    })
    const tools = await m.resolver()
    await m.exec(tools, "tool_search", { query: "start" }) // permitido
    await expect(m.exec(tools, "mcp_call", { tool: "x_start", arguments: { id: "1" } })).rejects.toThrow(/plan-gate:x_start/)
    expect(m.llamadas).toHaveLength(0)
    expect(m.asks).toHaveLength(0)
  })
})
