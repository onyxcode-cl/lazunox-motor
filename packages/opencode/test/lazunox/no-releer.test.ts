import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Layer } from "effect"
import path from "path"
import { LecturasSesion } from "../../src/session/lecturas"
import { Agent } from "../../src/agent/agent"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { LSP } from "@/lsp/lsp"
import { SessionID, MessageID } from "../../src/session/schema"
import { Instruction } from "../../src/session/instruction"
import { ReadTool } from "../../src/tool/read"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import {
  disposeAllInstances,
  provideInstance,
  testInstanceStoreLayer,
  TestInstance,
  tmpdirScoped,
} from "../fixture/fixture"
import { testEffect } from "../lib/effect"


afterEach(async () => {
  await disposeAllInstances()
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const readLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      FSUtil.node,
      CrossSpawnSpawner.node,
      Instruction.node,
      LSP.node,
      Ripgrep.node,
      Truncate.node,
    ]),
  )

const it = testEffect(Layer.mergeAll(readLayer(), testInstanceStoreLayer))

const init = Effect.fn("ReadToolTest.init")(function* () {
  const info = yield* ReadTool
  return yield* info.init()
})

const run = Effect.fn("ReadToolTest.run")(function* (
  args: Tool.InferParameters<typeof ReadTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const exec = Effect.fn("ReadToolTest.exec")(function* (
  dir: string,
  args: Tool.InferParameters<typeof ReadTool>,
  next: Tool.Context = ctx,
) {
  return yield* provideInstance(dir)(run(args, next))
})

const fail = Effect.fn("ReadToolTest.fail")(function* (
  dir: string,
  args: Tool.InferParameters<typeof ReadTool>,
  next: Tool.Context = ctx,
) {
  const exit = yield* exec(dir, args, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected read to fail")
})

const put = Effect.fn("NoReleerTest.put")(function* (p: string, content: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(p, content)
})

let n = 0
const sesion = () => SessionID.make(`ses_norel_${++n}_${Date.now()}`)

// Mensajes tal como los vería el modelo: una parte `read` completada por cada llamada dada.
const mensajes = (calls: string[], extra: { compacted?: boolean } = {}) =>
  [
    {
      info: { id: "msg_a", role: "assistant" },
      parts: calls.map((callID) => ({
        type: "tool",
        tool: "read",
        callID,
        state: {
          status: "completed",
          input: {},
          output: "x",
          title: "",
          metadata: {},
          time: { start: 0, end: 1, ...(extra.compacted ? { compacted: 2 } : {}) },
        },
      })),
    },
  ] as any

const leer = (dir: string, args: Tool.InferParameters<typeof ReadTool>, sid: SessionID, callID: string, visibles: string[], asks?: string[]) =>
  exec(dir, args, {
    ...ctx,
    sessionID: sid,
    callID,
    messages: mensajes(visibles),
    ask: (req: any) => Effect.sync(() => void asks?.push(...req.patterns)),
  } as Tool.Context)

describe("lazunox no-releer", () => {
  it.live("igual y visible -> línea corta; cambiado -> completo", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const f = path.join(dir, "a.txt")
      yield* put(f, "uno\ndos\ntres\n" + "relleno de la línea\n".repeat(200))
      const sid = sesion()
      const r1 = yield* leer(dir, { filePath: f }, sid, "c1", ["c1"])
      expect(r1.output).toContain("1: uno")
      const r2 = yield* leer(dir, { filePath: f }, sid, "c2", ["c1", "c2"])
      expect(r2.output).toContain("Sin cambios")
      expect(r2.output).toContain("n.º 1")
      expect(r2.output).not.toContain("1: uno")
      expect(r2.output.length).toBeLessThan(r1.output.length / 5)
      yield* put(f, "uno\ndos\ncuatro\n")
      const r3 = yield* leer(dir, { filePath: f }, sid, "c3", ["c1", "c2", "c3"])
      expect(r3.output).toContain("3: cuatro")
      // la nueva lectura pasa a ser la referencia
      const r4 = yield* leer(dir, { filePath: f }, sid, "c4", ["c3", "c4"])
      expect(r4.output).toContain("Sin cambios")
      expect(r4.output).toContain("n.º 2")
    }),
  )

  it.live("la lectura anterior ya no está visible (compactada o rebobinada) -> completo", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const f = path.join(dir, "a.txt")
      yield* put(f, "uno\ndos\n")
      const sid = sesion()
      yield* leer(dir, { filePath: f }, sid, "c1", ["c1"])
      const r = yield* leer(dir, { filePath: f }, sid, "c2", ["c2"])
      expect(r.output).toContain("1: uno")
      // podada: la parte sigue pero con time.compacted
      const r2 = yield* exec(dir, { filePath: f }, {
        ...ctx,
        sessionID: sid,
        callID: "c3",
        messages: mensajes(["c2"], { compacted: true }),
      } as Tool.Context)
      expect(r2.output).toContain("1: uno")
    }),
  )

  it.live("tras LecturasSesion.vaciar -> completo", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const f = path.join(dir, "a.txt")
      yield* put(f, "uno\n")
      const sid = sesion()
      yield* leer(dir, { filePath: f }, sid, "c1", ["c1"])
      LecturasSesion.vaciar(sid)
      const r = yield* leer(dir, { filePath: f }, sid, "c2", ["c1", "c2"])
      expect(r.output).toContain("1: uno")
    }),
  )

  it.live("rangos distintos se leen siempre; el rango no cuenta como lectura completa", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const f = path.join(dir, "a.txt")
      yield* put(f, "uno\ndos\ntres\n")
      const sid = sesion()
      yield* leer(dir, { filePath: f }, sid, "c1", ["c1"])
      const r2 = yield* leer(dir, { filePath: f, offset: 2, limit: 1 }, sid, "c2", ["c1", "c2"])
      expect(r2.output).toContain("2: dos")
      const r3 = yield* leer(dir, { filePath: f, offset: 2, limit: 1 }, sid, "c3", ["c1", "c2", "c3"])
      expect(r3.output).toContain("2: dos")
      const r4 = yield* leer(dir, { filePath: f, limit: 2 }, sid, "c4", ["c1", "c4"])
      expect(r4.output).toContain("1: uno")
    }),
  )

  it.live("sesiones distintas no comparten el mapa", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const f = path.join(dir, "a.txt")
      yield* put(f, "uno\n")
      yield* leer(dir, { filePath: f }, sesion(), "c1", ["c1"])
      const r = yield* leer(dir, { filePath: f }, sesion(), "c2", ["c1", "c2"])
      expect(r.output).toContain("1: uno")
    }),
  )

  it.live("el permiso de lectura se pide también en la lectura repetida (.env incluido)", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const f = path.join(dir, ".env")
      yield* put(f, "A=1\n")
      const sid = sesion()
      const asks: string[] = []
      yield* leer(dir, { filePath: f }, sid, "c1", ["c1"], asks)
      const r = yield* leer(dir, { filePath: f }, sid, "c2", ["c1", "c2"], asks)
      expect(r.output).toContain("Sin cambios")
      expect(asks.filter((p) => p.endsWith(".env")).length).toBe(2)
      // permiso denegado en la repetida: falla, no devuelve el aviso corto
      const exit = yield* exec(dir, { filePath: f }, {
        ...ctx,
        sessionID: sid,
        callID: "c3",
        messages: mensajes(["c1", "c3"]),
        ask: () => Effect.die(new Error("denegado")),
      } as Tool.Context).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.live("LAZUNOX_NO_RELEER=0 lo apaga", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const f = path.join(dir, "a.txt")
      yield* put(f, "uno\n")
      const sid = sesion()
      yield* leer(dir, { filePath: f }, sid, "c1", ["c1"])
      process.env.LAZUNOX_NO_RELEER = "0"
      try {
        const r = yield* leer(dir, { filePath: f }, sid, "c2", ["c1", "c2"])
        expect(r.output).toContain("1: uno")
      } finally {
        delete process.env.LAZUNOX_NO_RELEER
      }
    }),
  )

  it.live("si apareció un AGENTS.md de la subcarpeta, la repetida NO es la línea corta (no se pierde su contenido)", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const f = path.join(dir, "sub", "a.txt")
      yield* put(f, "uno\ndos\n")
      const sid = sesion()
      yield* leer(dir, { filePath: f }, sid, "c1", ["c1"])
      yield* put(path.join(dir, "sub", "AGENTS.md"), "REGLA-NUEVA-DE-SUBCARPETA")
      const r = yield* exec(dir, { filePath: f }, {
        ...ctx,
        messageID: MessageID.make("msg_otro_turno"),
        sessionID: sid,
        callID: "c2",
        messages: mensajes(["c1", "c2"]),
      } as Tool.Context)
      expect(r.output).not.toContain("Sin cambios")
      expect(r.output).toContain("REGLA-NUEVA-DE-SUBCARPETA")
      // Y cuando ya no hay AGENTS.md nuevo por reclamar (mismo mensaje), la repetida vuelve a ser corta.
      const r3 = yield* exec(dir, { filePath: f }, {
        ...ctx,
        messageID: MessageID.make("msg_otro_turno"),
        sessionID: sid,
        callID: "c3",
        messages: mensajes(["c2", "c3"]),
      } as Tool.Context)
      expect(r3.output).toContain("Sin cambios")
    }),
  )
})
