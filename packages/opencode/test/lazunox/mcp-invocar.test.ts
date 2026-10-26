import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { McpInvocar } from "../../src/mcp/invocar"

type Llamada = { name: string; arguments: Record<string, unknown> }

function montar(opts?: { ask?: () => Effect.Effect<void>; fallo?: boolean; hook?: (args: Record<string, unknown>) => void }) {
  const eventos: string[] = []
  const llamadas: Llamada[] = []
  const triggers: { name: string; input: any; output: any }[] = []
  const client = {
    callTool: async (params: Llamada) => {
      eventos.push("callTool")
      llamadas.push(params)
      if (opts?.fallo) throw new Error("boom")
      return { content: [{ type: "text", text: `eco:${JSON.stringify(params.arguments)}` }] }
    },
  }
  const entry = {
    def: { name: "start", description: "d", inputSchema: { type: "object", properties: {} } },
    client,
    timeout: 1000,
  } as any
  const asks: any[] = []
  const input = (args: Record<string, unknown>, extra: Partial<McpInvocar.RunInput> = {}): McpInvocar.RunInput => ({
    key: "x_start",
    entry,
    args,
    opts: { toolCallId: "call-1", abortSignal: new AbortController().signal, messages: [] },
    ctx: {
      sessionID: "ses_1" as any,
      ask: (req: any) => {
        eventos.push("ask")
        asks.push(req)
        return opts?.ask ? opts.ask() : Effect.void
      },
    },
    messageID: "msg_1",
    plugin: {
      trigger: ((name: string, i: any, o: any) => {
        eventos.push(name)
        triggers.push({ name, input: i, output: o })
        if (name === "tool.execute.before") opts?.hook?.(o.args)
        return Effect.succeed(o)
      }) as any,
    },
    truncate: { output: (text: string) => Effect.succeed({ content: text, truncated: false }) } as any,
    agent: { name: "build", mode: "primary", options: {}, permission: [] } as any,
    processor: { completeToolCall: () => Effect.void },
    ...extra,
  })
  return { eventos, llamadas, triggers, asks, input }
}

describe("McpInvocar.run", () => {
  test("gancho antes/después con la clave real y orden gancho → permiso → servidor → gancho", async () => {
    const m = montar()
    const out = await Effect.runPromise(McpInvocar.run(m.input({ a: 1 })))
    expect(m.eventos).toEqual(["tool.execute.before", "ask", "callTool", "tool.execute.after"])
    expect(m.triggers[0].input.tool).toBe("x_start")
    expect(m.triggers[1].input.tool).toBe("x_start")
    expect(m.triggers.every((t) => t.input.tool !== "mcp_call")).toBe(true)
    expect(out.output).toContain("eco:")
    expect(out.title).toBe("")
  })

  test("el gancho recibe el MISMO objeto args que llega a callTool; mutarlo llega al servidor", async () => {
    const args: Record<string, unknown> = { a: 1 }
    const m = montar({ hook: (a) => void (a.lazunox_session = "ses_1") })
    await Effect.runPromise(McpInvocar.run(m.input(args)))
    expect(m.triggers[0].output.args).toBe(args)
    expect(m.llamadas[0].arguments).toBe(args)
    expect(m.llamadas[0].arguments).toEqual({ a: 1, lazunox_session: "ses_1" })
  })

  test("pide permiso con la clave real y patrones *", async () => {
    const m = montar()
    await Effect.runPromise(McpInvocar.run(m.input({})))
    expect(m.asks).toHaveLength(1)
    expect(m.asks[0]).toMatchObject({ permission: "x_start", patterns: ["*"], always: ["*"] })
  })

  test("permiso rechazado: no llama al servidor ni dispara 'after'", async () => {
    const m = montar({ ask: () => Effect.die(Object.assign(new Error("denegado"), { _tag: "PermissionRejectedError" })) })
    await expect(Effect.runPromise(McpInvocar.run(m.input({})))).rejects.toThrow()
    expect(m.llamadas).toHaveLength(0)
    expect(m.eventos).toEqual(["tool.execute.before", "ask"])
  })

  test("onCall (no-op por defecto) entra y sale, también si el servidor falla", async () => {
    const ok = montar()
    const vistos: string[] = []
    await Effect.runPromise(McpInvocar.run(ok.input({}, { onCall: (fase, c) => void vistos.push(`${fase}:${c.key}:${c.sessionID}:${c.callID}`) })))
    expect(vistos).toEqual(["enter:x_start:ses_1:call-1", "exit:x_start:ses_1:call-1"])

    const mal = montar({ fallo: true })
    const v2: string[] = []
    await expect(
      Effect.runPromise(McpInvocar.run(mal.input({}, { onCall: (fase) => void v2.push(fase) }))),
    ).rejects.toThrow()
    expect(v2).toEqual(["enter", "exit"])
    // sin onCall tampoco falla
    await Effect.runPromise(McpInvocar.run(montar().input({})))
  })

  test("título y metadatos extra solo cuando se piden", async () => {
    const m = montar()
    const out = await Effect.runPromise(
      McpInvocar.run(m.input({}, { title: "x_start", extraMetadata: { lazunoxMcp: { tool: "x_start", server: "x" } } })),
    )
    expect(out.title).toBe("x_start")
    expect((out.metadata as any).lazunoxMcp).toEqual({ tool: "x_start", server: "x" })
  })

  // 6.8: ganchos de salida sobre una herramienta MCP.
  test("6.8 el gancho 'after' ve el texto como output y puede reemplazarlo: cambia solo el texto, no la metadata ni los adjuntos", async () => {
    const m = montar()
    const vistos: any[] = []
    const plugin: any = {
      trigger: (name: string, _i: any, o: any) => {
        if (name === "tool.execute.after") {
          vistos.push(o.output)
          o.output = "FILTRADO"
        }
        return Effect.succeed(o)
      },
    }
    const out = await Effect.runPromise(McpInvocar.run(m.input({ a: 1 }, { plugin })))
    expect(vistos).toEqual(['eco:{"a":1}'])
    expect(out.output).toBe("FILTRADO")
    expect((out as any).content).toEqual([{ type: "text", text: "FILTRADO" }])
    expect((out as any).output).toBe("FILTRADO")
    expect(out.attachments).toEqual([])
  })
  test("6.8 un gancho 'after' que no toca el texto deja el contenido intacto", async () => {
    const m = montar()
    const out = await Effect.runPromise(McpInvocar.run(m.input({ a: 1 })))
    expect(out.output).toBe('eco:{"a":1}')
    expect((out as any).content).toEqual([{ type: "text", text: 'eco:{"a":1}' }])
  })
  test("6.8 herramienta MCP que falla: avisa 'tool.execute.failure', el contexto va al error y el fallo se mantiene", async () => {
    const m = montar({ fallo: true })
    const plugin: any = {
      trigger: (name: string, i: any, o: any) => {
        m.eventos.push(name)
        if (name === "tool.execute.failure") {
          expect(i.tool).toBe("x_start")
          expect(i.error).toContain("boom")
          o.contexto = "revisa el servidor"
        }
        return Effect.succeed(o)
      },
    }
    const err = await Effect.runPromise(McpInvocar.run(m.input({}, { plugin })).pipe(Effect.flip))
    expect(String((err as Error).message)).toContain("boom")
    expect(String((err as Error).message)).toContain("[Gancho de usuario]: revisa el servidor")
    expect(m.eventos).toContain("tool.execute.failure")
    expect(m.eventos).not.toContain("tool.execute.after")
  })
})
