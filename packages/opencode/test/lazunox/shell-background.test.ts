import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Layer } from "effect"
import path from "path"
import { Config } from "@/config/config"
import { ShellTool, ShellWaitTool } from "../../src/tool/shell"
import { ShellBackground } from "../../src/tool/shell/background"
import { provideInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Plugin } from "../../src/plugin"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"

// Lazunox: shell en segundo plano (background: true + shell_wait). Solo se prueba en sistemas con /bin/sh.
const layer = Layer.mergeAll(
  LayerNode.compile(
    LayerNode.group([
      CrossSpawnSpawner.node,
      FSUtil.node,
      Plugin.node,
      Truncate.node,
      Config.node,
      Agent.node,
      RuntimeFlags.node,
    ]),
  ),
  testInstanceStoreLayer,
)
const it = testEffect(layer)
const root = path.join(__dirname, "../..")
const posix = process.platform !== "win32"

const session = (id: string) => ({
  sessionID: SessionID.make(id),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})
const A = session("ses_a")
const B = session("ses_b")

const tools = Effect.gen(function* () {
  const shell = yield* (yield* ShellTool).init()
  const wait = yield* (yield* ShellWaitTool).init()
  return { shell, wait }
})
const inRoot = <A, E, R>(self: Effect.Effect<A, E, R>) => self.pipe(provideInstance(root))
const idOf = (output: string) => /shell_id=(sh_\w+)/.exec(output)?.[1]
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const failure = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.exit,
    Effect.map((exit) => {
      if (Exit.isSuccess(exit)) throw new Error("se esperaba un fallo; en curso: " + ShellBackground.all().map((j) => j.sessionID + ":" + j.id + ":" + j.running + ":" + j.reason + ":" + j.code + ":" + (Date.now() - j.startedAt)).join(" | "))
      const err = Cause.squash(exit.cause)
      return err instanceof Error ? err : new Error(String(err))
    }),
  )
const cleanup = Effect.promise(async () => {
  for (const job of ShellBackground.running()) await Effect.runPromise(job.kill)
})

describe.skipIf(!posix)("shell en segundo plano", () => {
  it.live("un comando rápido termina antes del yield y no queda en curso", () =>
    inRoot(
      Effect.gen(function* () {
        const { shell } = yield* tools
        const r = yield* shell.execute({ command: "echo hola", background: true, yield_ms: 5000 }, A)
        expect(r.output).toContain("hola")
        expect(r.output).toContain("terminó con código 0")
        expect(r.output).not.toContain("en curso")
        expect(ShellBackground.running().length).toBe(0)
      }),
    ),
  )

  it.live("un comando lento pasa a «en curso» y shell_wait entrega solo lo que faltaba", () =>
    inRoot(
      Effect.gen(function* () {
        const { shell, wait } = yield* tools
        const first = yield* shell.execute(
          { command: "echo uno; sleep 2; echo dos", background: true, yield_ms: 1000 },
          A,
        )
        const id = idOf(first.output)
        expect(id).toBeDefined()
        expect(first.output).toContain("uno")
        expect(first.output).toContain("Comando en curso")
        expect(first.output).not.toContain("dos")
        const second = yield* wait.execute({ shell_id: id!, yield_ms: 5000 }, A)
        expect(second.output).toContain("dos")
        expect(second.output).not.toContain("uno")
        expect(second.output).toContain("terminó con código 0")
        // Nada nuevo en una tercera lectura.
        const third = yield* wait.execute({ shell_id: id! }, A)
        expect(third.output).not.toContain("dos")
      }),
    ),
  )

  it.live("terminate mata de verdad el proceso y todo su grupo", () =>
    inRoot(
      Effect.gen(function* () {
        const { shell, wait } = yield* tools
        const first = yield* shell.execute(
          { command: "sleep 300 & echo $! > /tmp/lzx-bg-child.pid; echo $$ ; wait", background: true, yield_ms: 1000 },
          A,
        )
        const id = idOf(first.output)!
        const parent = Number(first.output.split("\n")[0])
        const child = Number((yield* Effect.promise(() => Bun.file("/tmp/lzx-bg-child.pid").text())).trim())
        expect(alive(parent)).toBe(true)
        expect(alive(child)).toBe(true)
        const r = yield* wait.execute({ shell_id: id, terminate: true }, A)
        expect(r.output).toContain("terminado por ti")
        yield* Effect.sleep("500 millis")
        expect(alive(parent)).toBe(false)
        expect(alive(child)).toBe(false)
        expect(ShellBackground.get(id)?.running).toBe(false)
      }),
    ),
  )

  it.live("el shell_id de otra sesión se rechaza (esperar y terminar)", () =>
    inRoot(
      Effect.gen(function* () {
        const { shell, wait } = yield* tools
        const first = yield* shell.execute({ command: "sleep 30", background: true, yield_ms: 1000 }, A)
        const id = idOf(first.output)!
        const e1 = yield* failure(wait.execute({ shell_id: id }, B))
        expect(e1.message).toContain("No existe el shell")
        const e2 = yield* failure(wait.execute({ shell_id: id, terminate: true }, B))
        expect(e2.message).toContain("No existe el shell")
        expect(ShellBackground.get(id)?.running).toBe(true)
        yield* wait.execute({ shell_id: id, terminate: true }, A)
      }),
    ),
  )

  it.live("topes de trabajos vivos por sesión (3) y por motor (6)", () =>
    inRoot(
      Effect.gen(function* () {
        const { shell } = yield* tools
        for (let i = 0; i < 3; i++) {
          const r = yield* shell.execute({ command: "sleep 30", background: true, yield_ms: 1000 }, A)
          expect(r.output).toContain("Comando en curso")
        }
        const err = yield* failure(shell.execute({ command: "sleep 30", background: true, yield_ms: 1000 }, A))
        expect(err.message).toContain("en esta sesión")
        // Otra sesión sí puede, hasta el tope del motor.
        for (let i = 0; i < 3; i++) {
          yield* shell.execute({ command: "sleep 30", background: true, yield_ms: 1000 }, session(`ses_c${i}`))
        }
        const eng = yield* failure(shell.execute({ command: "sleep 30", background: true, yield_ms: 1000 }, B))
        expect(eng.message).toContain("en el motor")
        yield* cleanup
      }),
    ),
  )

  it.live("pasa por los mismos permisos que shell (ask) antes de lanzar", () =>
    inRoot(
      Effect.gen(function* () {
        const { shell } = yield* tools
        const asked: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
        const stop = new Error("denegado")
        const ctx = {
          ...A,
          ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
            Effect.sync(() => {
              asked.push(req)
              throw stop
            }),
        }
        const before = ShellBackground.all().length
        const err = yield* failure(shell.execute({ command: "echo secreto", background: true }, ctx))
        expect(err.message).toBe("denegado")
        expect(asked[0]?.permission).toBe("bash")
        expect(asked[0]?.patterns).toContain("echo secreto")
        expect(ShellBackground.all().length).toBe(before)
      }),
    ),
  )

  it.live("tope de vida: el comando se mata solo", () =>
    inRoot(
      Effect.gen(function* () {
        process.env.LAZUNOX_SHELL_BG_MAX_MS = "1500"
        try {
          const { shell, wait } = yield* tools
          const first = yield* shell.execute({ command: "sleep 60", background: true, yield_ms: 1000 }, A)
          const id = idOf(first.output)!
          const r = yield* wait.execute({ shell_id: id, yield_ms: 5000 }, A)
          expect(r.output).toContain("tope de vida")
        } finally {
          delete process.env.LAZUNOX_SHELL_BG_MAX_MS
        }
      }),
    ),
  )

  it.live("tope de salida: el archivo no pasa del límite", () =>
    inRoot(
      Effect.gen(function* () {
        process.env.LAZUNOX_SHELL_BG_MAX_OUTPUT = "2000"
        try {
          const { shell } = yield* tools
          const r = yield* shell.execute(
            { command: "head -c 100000 /dev/zero | tr '\\0' 'x'", background: true, yield_ms: 5000 },
            A,
          )
          expect(r.output).toContain("tope de 2000 bytes")
          const job = ShellBackground.all().find((j) => j.command.startsWith("head -c"))!
          expect(job.written).toBeLessThanOrEqual(2000)
        } finally {
          delete process.env.LAZUNOX_SHELL_BG_MAX_OUTPUT
        }
      }),
    ),
  )

  it.live("shell sin background sigue siendo síncrono y sin shell_id", () =>
    inRoot(
      Effect.gen(function* () {
        const { shell } = yield* tools
        const r = yield* shell.execute({ command: "echo sincrono" }, A)
        expect(r.output).toContain("sincrono")
        expect(r.output).not.toContain("shell_id")
        expect(r.metadata.exit).toBe(0)
      }),
    ),
  )
})
