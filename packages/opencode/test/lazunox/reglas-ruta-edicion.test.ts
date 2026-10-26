// Lazunox 4D (P23): al editar o escribir un archivo (edit, write, apply_patch) el resultado de la herramienta lleva las reglas por ruta.
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Instruction } from "../../src/session/instruction"
import { Session } from "../../src/session/session"
import { SessionProcessor } from "../../src/session/processor"
import { SessionTools } from "../../src/session/tools"
import { MessageID, SessionID } from "../../src/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const sessionID = SessionID.make("ses_reglas_edicion")
const agent: Agent.Info = {
  name: "build",
  mode: "primary",
  options: {},
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
}
const model = { providerID: ProviderV2.ID.make("test"), api: { id: "test-model" } } as Provider.Model

const falsa = (id: string): Tool.Def =>
  ({
    id,
    description: id,
    parameters: Schema.Struct({}),
    jsonSchema: { type: "object", properties: {} },
    execute: () => Effect.succeed({ title: id, metadata: { propio: 1 }, output: `${id} hecho` }),
  }) satisfies Tool.Def

const base = Layer.mergeAll(
  Layer.succeed(Plugin.Service, Plugin.Service.of({ init: () => Effect.void, list: () => Effect.succeed([]), trigger: (_n, _i, o) => Effect.succeed(o) } satisfies Plugin.Interface)),
  Layer.succeed(Permission.Service, Permission.Service.of({ ask: () => Effect.void, reply: () => Effect.void, list: () => Effect.succeed([]) } satisfies Permission.Interface)),
  Layer.succeed(MCP.Service, MCP.Service.of({ tools: () => Effect.succeed({}), clients: () => Effect.succeed({}) } as Partial<MCP.Interface> as MCP.Interface)),
  Layer.succeed(
    Truncate.Service,
    Truncate.Service.of({
      cleanup: () => Effect.void,
      write: () => Effect.succeed("o.txt"),
      output: (text: string) => Effect.succeed({ content: text, truncated: false }),
      limits: () => Effect.succeed({ maxLines: 2000, maxBytes: 50 * 1024 }),
    } satisfies Truncate.Interface),
  ),
  RuntimeFlags.layer(),
  Layer.succeed(
    ToolRegistry.Service,
    ToolRegistry.Service.of({
      ids: () => Effect.succeed(["edit", "write", "apply_patch", "grep"]),
      all: () => Effect.succeed([]),
      named: () => Effect.die("unused"),
      tools: () => Effect.succeed([falsa("edit"), falsa("write"), falsa("apply_patch"), falsa("grep")]),
    }),
  ),
)

const it = testEffect(
  Layer.mergeAll(
    base,
    AppNodeBuilder.build(LayerNode.group([CrossSpawnSpawner.node, LayerNodePlatform.filesystem, InstanceStore.node]), [
      [InstanceBootstrap.node, Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))],
    ]),
  ),
)

const instruccion = (dir: string) =>
  AppNodeBuilder.build(Instruction.node, [
    [Config.node, Layer.succeed(Config.Service, TestConfig.make())],
    [Global.node, Global.layerWith({ home: dir, config: dir })],
    [RuntimeFlags.node, RuntimeFlags.layer({})],
  ])

const procesador = (messageID: MessageID) =>
  ({
    message: { id: messageID, sessionID, role: "assistant" } as unknown as SessionV1.Assistant,
    updateToolCall: () => Effect.die("unused"),
    completeToolCall: () => Effect.void,
  }) satisfies Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">

describe("reglas por ruta al editar (4D)", () => {
  it.live("edit, write y apply_patch adjuntan la regla una vez por turno; otras herramientas no", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(dir, ".opencode/rules"), { recursive: true })
          await fs.writeFile(path.join(dir, ".opencode/rules/ts.md"), "---\npaths: src/**/*.ts\n---\nREGLA-AL-EDITAR\n")
        })
        const real = yield* Effect.promise(() => fs.realpath(dir))
        return yield* Effect.gen(function* () {
          const messageID = MessageID.make("msg_reglas_edicion_1")
          const tools = yield* SessionTools.resolve({
            agent,
            model,
            session: { id: sessionID, permission: [] } as unknown as Session.Info,
            processor: procesador(messageID),
            bypassAgentCheck: false,
            messages: [],
            promptOps: {} as never,
          })
          const ejecutar = (id: string, args: unknown) =>
            Effect.promise(
              () =>
                tools[id]!.execute!(args as never, {
                  toolCallId: `call-${id}`,
                  abortSignal: new AbortController().signal,
                  messages: [],
                }) as Promise<{ output: string; metadata: Record<string, unknown> }>,
            )
          const e = yield* ejecutar("edit", { filePath: path.join(dir, "src/a.ts") })
          expect(e.output).toContain("edit hecho")
          expect(e.output).toContain("REGLA-AL-EDITAR")
          expect(e.metadata.propio).toBe(1)
          expect(e.metadata.loaded).toEqual([path.join(real, ".opencode/rules/ts.md")])
          expect(e.metadata.reglasN).toBe(1)
          // Mismo mensaje del asistente: ya reclamada, ni write ni apply_patch la repiten.
          const w = yield* ejecutar("write", { filePath: path.join(dir, "src/b.ts") })
          expect(w.output).toBe("write hecho")
          const p = yield* ejecutar("apply_patch", { patchText: "*** Begin Patch\n*** Add File: src/c.ts\n+x\n*** End Patch" })
          expect(p.output).toBe("apply_patch hecho")
          // Otro archivo que no coincide, y una herramienta que no edita.
          expect((yield* ejecutar("write", { filePath: path.join(dir, "README.md") })).output).toBe("write hecho")
          expect((yield* ejecutar("grep", { filePath: path.join(dir, "src/a.ts") })).output).toBe("grep hecho")
        }).pipe(Effect.provide(instruccion(dir)))
      }),
    ),
  )

  it.live("apply_patch con una ruta relativa carga la regla de su archivo", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(dir, ".claude/rules"), { recursive: true })
          await fs.writeFile(path.join(dir, ".claude/rules/ts.md"), "---\npaths:\n  - src/**\n---\nREGLA-DEL-PARCHE\n")
        })
        return yield* Effect.gen(function* () {
          const tools = yield* SessionTools.resolve({
            agent,
            model,
            session: { id: sessionID, permission: [] } as unknown as Session.Info,
            processor: procesador(MessageID.make("msg_reglas_edicion_2")),
            bypassAgentCheck: false,
            messages: [],
            promptOps: {} as never,
          })
          const r = yield* Effect.promise(
            () =>
              tools.apply_patch!.execute!({ patchText: "*** Begin Patch\n*** Update File: src/c.ts\n@@\n+x\n*** End Patch" } as never, {
                toolCallId: "call-p",
                abortSignal: new AbortController().signal,
                messages: [],
              }) as Promise<{ output: string }>,
          )
          expect(r.output).toContain("REGLA-DEL-PARCHE")
        }).pipe(Effect.provide(instruccion(dir)))
      }),
    ),
  )
})
