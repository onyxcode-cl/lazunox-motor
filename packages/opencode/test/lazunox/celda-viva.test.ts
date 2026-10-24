// Lazunox (celda viva): un rechazo de permiso revoca la celda y las celdas que ceden el control traen un resumen acotado.
import { describe, expect, test } from "bun:test"
import { CELL_REVOKED_MESSAGE, CodeModeTool, CodeModeWaitTool } from "@/tool/code-mode"
import type { Tool as MCPToolDef } from "@modelcontextprotocol/sdk/types.js"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Plugin } from "@/plugin"
import { Session } from "@/session/session"
import { Tool } from "@/tool/tool"
import * as Truncate from "@/tool/truncate"
import { MessageID, SessionID } from "@/session/schema"
import { Cause, Effect, Exit, Layer, Scope } from "effect"
import { BackgroundJob as CoreBackgroundJob } from "@opencode-ai/core/background-job"

const jobsScope = Effect.runSync(Scope.make())
const jobsLayer = Layer.succeed(
  CoreBackgroundJob.Service,
  Effect.runSync(CoreBackgroundJob.make.pipe(Effect.provideService(Scope.Scope, jobsScope))),
)

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_celda_viva"),
  messageID: MessageID.make("msg_celda_viva"),
  agent: "build",
  abort: new AbortController().signal,
  callID: "call_celda_viva",
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ok = (text: string) => ({ content: [{ type: "text", text }] })

function mcpTool(name: string, handler: (args: Record<string, unknown>) => unknown): MCP.McpTool {
  return {
    def: { name, description: name, inputSchema: { type: "object", properties: {} } } as MCPToolDef,
    client: {
      callTool: async (params: { arguments?: Record<string, unknown> }) => handler(params.arguments ?? {}),
    } as unknown as MCP.McpTool["client"],
  }
}

const layerFor = (mcpTools: Record<string, MCP.McpTool>) =>
  Layer.mergeAll(
    jobsLayer,
    Layer.mock(Plugin.Service, {
      trigger: ((_n, _i, output) => Effect.succeed(output)) as Plugin.Interface["trigger"],
    }),
    Layer.mock(Truncate.Service, { output: (text: string) => Effect.succeed({ content: text, truncated: false as const }) }),
    Layer.mock(Agent.Service, { get: () => Effect.succeed({ name: "build", permission: [] } as any) }),
    Layer.mock(Session.Service, { get: () => Effect.succeed({ permission: [] } as any) }),
    Layer.mock(MCP.Service, {
      tools: () => Effect.succeed(mcpTools),
      clients: () => Effect.succeed({ srv: {} as any }),
    }),
  )

const buildPair = (mcpTools: Record<string, MCP.McpTool>) =>
  Effect.runPromise(
    Effect.all([CodeModeTool.pipe(Effect.flatMap(Tool.init)), CodeModeWaitTool.pipe(Effect.flatMap(Tool.init))]).pipe(
      Effect.provide(layerFor(mcpTools)),
    ),
  )

const cellOf = (output: string) => /cell_id=(cm_\w+)/.exec(output)?.[1]
let n = 0
const callCtx = (extra: Partial<Tool.Context> = {}): Tool.Context => ({ ...ctx, callID: `call_cv_${++n}`, ...extra })
// Rechaza solo el permiso de la herramienta indicada; el resto se aprueba.
const rejecting = (key: string, error: unknown = new PermissionV1.RejectedError()): Partial<Tool.Context> => ({
  ask: (req) => (req.permission === key ? Effect.die(error) : Effect.void),
})

describe("celda viva: un rechazo detiene el resto", () => {
  test("rechazo en una celda ya cedida: las llamadas siguientes no corren aunque el script atrape el error", async () => {
    const ran: string[] = []
    const [exec, wait] = await buildPair({
      srv_slow: mcpTool("slow", async () => {
        await sleep(1300)
        return ok("lento")
      }),
      srv_danger: mcpTool("danger", () => {
        ran.push("danger")
        return ok("peligro")
      }),
      srv_after: mcpTool("after", () => {
        ran.push("after")
        return ok("despues")
      }),
    })
    const code = `
      await tools.srv.slow({});
      const seen = [];
      for (const name of ["danger", "after", "after"]) {
        try { await tools.srv[name]({}); seen.push("ok:" + name) } catch (e) { seen.push(e.message) }
      }
      return seen`
    const c = callCtx(rejecting("srv_danger"))
    const first = await Effect.runPromise(exec.execute({ code, yield_ms: 1000 }, c))
    const cell = cellOf(first.output)
    expect(cell).toBeDefined()
    const end = await Effect.runPromise(wait.execute({ cell_id: cell!, yield_ms: 5000 }, c))
    expect(end.output).toBe(CELL_REVOKED_MESSAGE)
    await sleep(100)
    expect(ran).toEqual([]) // ni la rechazada ni las siguientes
    // y la celda ya no está en curso
    const again = await Effect.runPromise(wait.execute({ cell_id: cell! }, c))
    expect(again.output).toBe(CELL_REVOKED_MESSAGE)
  })

  test("también con CorrectedError", async () => {
    const [exec] = await buildPair({ srv_a: mcpTool("a", () => ok("a")), srv_b: mcpTool("b", () => ok("b")) })
    const c = callCtx(rejecting("srv_a", new PermissionV1.CorrectedError({ feedback: "no" } as any)))
    const r = await Effect.runPromise(
      exec.execute({ code: "try { await tools.srv.a({}) } catch (e) {} return await tools.srv.b({})" }, c),
    )
    expect(r.output).toBe(CELL_REVOKED_MESSAGE)
  })

  test("rechazo antes de ceder: se detiene, las siguientes llamadas fallan con el mensaje", async () => {
    const ran: string[] = []
    const [exec] = await buildPair({
      srv_danger: mcpTool("danger", () => (ran.push("danger"), ok("x"))),
      srv_after: mcpTool("after", () => (ran.push("after"), ok("y"))),
    })
    const c = callCtx(rejecting("srv_danger"))
    const r = await Effect.runPromise(
      exec.execute(
        { code: "try { await tools.srv.danger({}) } catch (e) {} try { await tools.srv.after({}) } catch (e) {} return 'seguí'" },
        c,
      ),
    )
    expect(r.output).toBe(CELL_REVOKED_MESSAGE)
    expect(r.metadata.error).toBe(true)
    await sleep(100)
    expect(ran).toEqual([])
  })

  test("la revocación de una celda no afecta a otra", async () => {
    const ran: string[] = []
    const [exec, wait] = await buildPair({
      srv_slow: mcpTool("slow", async () => {
        await sleep(1300)
        return ok("lento")
      }),
      srv_danger: mcpTool("danger", () => ok("x")),
      srv_after: mcpTool("after", () => {
        ran.push("after")
        return ok("despues")
      }),
    })
    const a = callCtx()
    const first = await Effect.runPromise(
      exec.execute({ code: "await tools.srv.slow({}); return await tools.srv.after({})", yield_ms: 1000 }, a),
    )
    const cellA = cellOf(first.output)!
    // otra celda de la misma sesión se revoca mientras A sigue viva
    const b = callCtx(rejecting("srv_danger"))
    const rb = await Effect.runPromise(exec.execute({ code: "try { await tools.srv.danger({}) } catch (e) {} return 1" }, b))
    expect(rb.output).toBe(CELL_REVOKED_MESSAGE)
    const endA = await Effect.runPromise(wait.execute({ cell_id: cellA, yield_ms: 5000 }, a))
    expect(endA.output).toContain("despues")
    expect(ran).toEqual(["after"])
  })
})

describe("celda viva: resumen al pausar", () => {
  const slowTools = () => ({
    srv_fast: mcpTool("fast", () => ok("rapido")),
    srv_slow: mcpTool("slow", async () => {
      await sleep(2500)
      return ok("lento")
    }),
  })

  test("incluye llamadas completadas, las 3 últimas y segundos; execute_wait usa el mismo registro", async () => {
    const [exec, wait] = await buildPair(slowTools())
    const c = callCtx()
    const code = `
      for (const i of [1,2,3,4,5]) await tools.srv.fast({ i, nota: "x".repeat(300) });
      return await tools.srv.slow({})`
    const first = await Effect.runPromise(exec.execute({ code, yield_ms: 1000 }, c))
    expect(first.output).toContain("Script en curso")
    expect(first.output).toContain("5 llamada(s) completada(s)")
    const lines = first.output.split("\n").filter((l) => l.startsWith("- "))
    expect(lines.length).toBe(3)
    expect(lines[0]).toContain("srv.fast")
    expect(lines[2]).toContain("srv.slow")
    expect(lines[2]).toContain("[running]")
    expect(first.output).toMatch(/\d+ s transcurridos/)
    // entrada abreviada: la de 300 caracteres no cabe entera
    expect(first.output).not.toContain("x".repeat(100))
    const resumen = first.output.slice(first.output.indexOf("Resumen:"), first.output.indexOf("No lo vuelvas"))
    expect(resumen.length).toBeLessThanOrEqual(1000)
    const cell = cellOf(first.output)!
    const second = await Effect.runPromise(wait.execute({ cell_id: cell, yield_ms: 1000 }, c))
    expect(second.output).toContain("Script en curso")
    expect(second.output).toContain("5 llamada(s) completada(s)")
    expect(second.output.split("\n").filter((l) => l.startsWith("- ")).length).toBe(3)
    const final = await Effect.runPromise(wait.execute({ cell_id: cell, yield_ms: 5000 }, c))
    expect(final.output).toContain("lento")
  })

  test("el resumen no se filtra a otra sesión", async () => {
    const [exec, wait] = await buildPair(slowTools())
    const c = callCtx()
    const first = await Effect.runPromise(exec.execute({ code: "await tools.srv.fast({secreto: 'abc123'}); return await tools.srv.slow({})", yield_ms: 1000 }, c))
    const cell = cellOf(first.output)!
    expect(first.output).toContain("abc123")
    const otra = callCtx({ sessionID: SessionID.make("ses_otra_cv") })
    const exit = await Effect.runPromise(wait.execute({ cell_id: cell, yield_ms: 1000 }, otra).pipe(Effect.exit))
    if (Exit.isSuccess(exit)) throw new Error("la otra sesión no debía poder esperar la celda")
    const message = (Cause.squash(exit.cause) as Error).message
    expect(message).toContain("No existe la celda")
    expect(message).not.toContain("abc123")
    await Effect.runPromise(wait.execute({ cell_id: cell, terminate: true }, c))
  })
})
