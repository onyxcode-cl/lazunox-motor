// Ayudas compartidas por las pruebas de compactación de Lazunox (copiadas del patrón de test/session/compaction.test.ts).
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Effect, Layer, Schema } from "effect"
import * as Stream from "effect/Stream"
import { Config } from "@/config/config"
import { LLM } from "../../src/session/llm"
import { SessionCompaction } from "../../src/session/compaction"
import { Plugin } from "../../src/plugin"
import { Session as SessionNs } from "@/session/session"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionSummary } from "../../src/session/summary"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Provider } from "@/provider/provider"
import { ProviderTest } from "../fake/provider"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { TestConfig } from "../fixture/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LLMEvent, Usage } from "@opencode-ai/llm"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Todo } from "@/session/todo"
import { testEffect } from "../lib/effect"

export const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const summaryLayer = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const basicUsage = () => new Usage({ inputTokens: 1, outputTokens: 1, totalTokens: 2 })

export function createModel(opts: { context: number; output: number }): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: { context: opts.context, output: opts.output },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: "@ai-sdk/anthropic" },
    options: {},
  } as Provider.Model
}

export const wide = (context = 100_000, output = 32_000) => ProviderTest.fake({ model: createModel({ context, output }) })

export function cfg(compaction?: ConfigV1.Info["compaction"]) {
  const base = Schema.decodeUnknownSync(ConfigV1.Info)({}) as ConfigV1.Info
  return Layer.succeed(Config.Service, TestConfig.make({ get: () => Effect.succeed({ ...base, compaction }) }))
}

const compactionTestNode = LayerNode.group([
  SessionCompaction.node,
  SessionNs.node,
  SessionProjector.node,
  Database.node,
  EventV2Bridge.node,
  CrossSpawnSpawner.node,
])

export const compactionEnv = AppNodeBuilder.build(
  LayerNode.group([SessionNs.node, SessionProjector.node, Database.node, EventV2Bridge.node, CrossSpawnSpawner.node, Todo.node]),
)
export const itCompaction = testEffect(compactionEnv)

export function withCompaction(options: { llm: Layer.Layer<LLM.Service>; plugin?: Layer.Layer<Plugin.Service>; config?: Layer.Layer<Config.Service>; provider?: ReturnType<typeof wide> }) {
  return Effect.provide(
    AppNodeBuilder.build(compactionTestNode, [
      [Provider.node, (options.provider ?? wide()).layer],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
      [SessionSummary.node, summaryLayer],
      [LLM.node, options.llm],
      ...(options.plugin ? ([[Plugin.node, options.plugin]] as const) : []),
      ...(options.config ? ([[Config.node, options.config]] as const) : []),
    ]),
  )
}

type Item = Stream.Stream<LLMEvent, unknown> | ((input: LLM.StreamInput) => Stream.Stream<LLMEvent, unknown>)

/** LLM falso: cada llamada consume el siguiente elemento de la cola; `peticiones` guarda el cuerpo de todas. */
export function llm() {
  const queue: Item[] = []
  const peticiones: LLM.StreamInput["messages"][] = []
  return {
    peticiones,
    reset() {
      queue.length = 0
      peticiones.length = 0
    },
    push(item: Item) {
      queue.push(item)
    },
    llmLayer: Layer.succeed(
      LLM.Service,
      LLM.Service.of({
        stream: (input) => {
          peticiones.push(input.messages)
          const item = queue.shift() ?? Stream.empty
          const stream = typeof item === "function" ? item(input) : item
          return stream.pipe(Stream.mapEffect((event) => Effect.succeed(event)))
        },
      }),
    ),
  }
}

export function reply(text: string): (input: LLM.StreamInput) => Stream.Stream<LLMEvent, unknown> {
  return () =>
    Stream.make(
      LLMEvent.textStart({ id: "txt-0" }),
      LLMEvent.textDelta({ id: "txt-0", text }),
      LLMEvent.textEnd({ id: "txt-0" }),
      LLMEvent.stepFinish({ index: 0, reason: "stop", usage: basicUsage() }),
      LLMEvent.finish({ reason: "stop", usage: basicUsage() }),
    )
}

export function userMsg(sessionID: SessionID, text: string) {
  return Effect.gen(function* () {
    const ssn = yield* SessionNs.Service
    const msg = yield* ssn.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: ref,
      time: { created: Date.now() },
    })
    yield* ssn.updatePart({ id: PartID.ascending(), messageID: msg.id, sessionID, type: "text", text })
    return msg
  })
}

/** Respuesta terminada del asistente, con partes de herramienta opcionales (ya completadas). */
export function assistantMsg(
  sessionID: SessionID,
  parentID: MessageID,
  opts: { text?: string; tokens?: number; tools?: Array<{ tool: string; input: Record<string, unknown>; output: string; metadata?: Record<string, unknown> }> } = {},
) {
  return Effect.gen(function* () {
    const ssn = yield* SessionNs.Service
    const msg = yield* ssn.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      sessionID,
      mode: "build",
      agent: "build",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { total: opts.tokens, output: 0, input: opts.tokens ?? 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      parentID,
      time: { created: Date.now() },
      finish: "stop",
    } as SessionV1.Assistant)
    if (opts.text)
      yield* ssn.updatePart({ id: PartID.ascending(), messageID: msg.id, sessionID, type: "text", text: opts.text })
    for (const t of opts.tools ?? []) {
      yield* ssn.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID,
        type: "tool",
        callID: `call_${Math.random().toString(36).slice(2)}`,
        tool: t.tool,
        state: {
          status: "completed",
          input: t.input,
          output: t.output,
          title: t.tool,
          metadata: t.metadata ?? {},
          time: { start: Date.now(), end: Date.now() },
        },
      } as SessionV1.ToolPart)
    }
    return msg
  })
}

export function compactionMarker(sessionID: SessionID, tail?: MessageID) {
  return Effect.gen(function* () {
    const ssn = yield* SessionNs.Service
    const msg = yield* ssn.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      model: ref,
      sessionID,
      agent: "build",
      time: { created: Date.now() },
    })
    yield* ssn.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID: msg.sessionID,
      type: "compaction",
      auto: false,
      ...(tail ? { tail_start_id: tail, manual_tail: true } : {}),
    })
    return msg
  })
}

/** Texto plano de lo que el modelo recibe en una petición (para buscar subcadenas). */
export const plano = (messages: LLM.StreamInput["messages"]) => JSON.stringify(messages)
