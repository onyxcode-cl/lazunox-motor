// Lazunox 4D (P36): `SessionContextoFijo.calcular` (la ruta `GET /experimental/session/{id}/contexto-fijo` la cubre httpapi-exercise).
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Exit, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { Config } from "@/config/config"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Session } from "../../src/session/session"
import { SessionContextoFijo, tokensDe } from "../../src/session/contexto-fijo"
import { SystemPrompt } from "../../src/session/system"
import { SessionID } from "../../src/session/schema"
import { NotFoundError } from "../../src/storage/storage"
import { provideTmpdirInstance } from "../fixture/fixture"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([CrossSpawnSpawner.node, LayerNodePlatform.filesystem, InstanceStore.node]), [
    [
      InstanceBootstrap.node,
      Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
    ],
  ]),
)

const agente = { name: "build", mode: "primary", options: {}, permission: [{ permission: "*", pattern: "*", action: "allow" }], prompt: "P".repeat(400) }
const ayudante = { name: "explore", mode: "subagent", options: {}, permission: [], description: "D".repeat(100) }
const oculto = { name: "titulo", mode: "primary", hidden: true, options: {}, permission: [], description: "NO" }

const capa = (dir: string, mcpDefs: Record<string, unknown> = {}) =>
  AppNodeBuilder.build(SessionContextoFijo.node, [
    [Config.node, Layer.succeed(Config.Service, TestConfig.make())],
    [Global.node, Global.layerWith({ home: dir, config: dir })],
    [RuntimeFlags.node, RuntimeFlags.layer({})],
    [
      Session.node,
      Layer.succeed(
        Session.Service,
        Session.Service.of({
          get: (id: SessionID) =>
            id === SessionID.make("ses_noexiste")
              ? Effect.fail(new NotFoundError({ message: "nope" }))
              : Effect.succeed({ id, permission: [] } as any),
          messages: () => Effect.succeed([]),
        } as any),
      ),
    ],
    [
      Agent.node,
      Layer.succeed(
        Agent.Service,
        Agent.Service.of({
          get: () => Effect.succeed(agente as any),
          list: () => Effect.succeed([agente, ayudante, oculto] as any),
          defaultInfo: () => Effect.succeed(agente as any),
        } as any),
      ),
    ],
    [
      MCP.node,
      Layer.succeed(
        MCP.Service,
        MCP.Service.of({ tools: () => Effect.succeed(mcpDefs), instructions: () => Effect.succeed([]) } as any),
      ),
    ],
    [
      SystemPrompt.node,
      Layer.succeed(
        SystemPrompt.Service,
        SystemPrompt.Service.of({
          skills: () => Effect.succeed("S".repeat(400)),
          mcp: () => Effect.succeed("M".repeat(80)),
          environment: () => Effect.succeed([]),
        } as any),
      ),
    ],
  ])

describe("contexto fijo (4D)", () => {
  test_tokens()

  it.live("suma agentes, skills, MCP e instrucciones y cuenta las reglas por ruta sin sumarlas", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await fs.writeFile(path.join(dir, "AGENTS.md"), "I".repeat(1000))
          await fs.mkdir(path.join(dir, ".opencode/rules"), { recursive: true })
          await fs.writeFile(path.join(dir, ".opencode/rules/r.md"), "---\npaths: src/**\n---\n" + "R".repeat(5000))
        })
        const defs = { srv_a: { def: { description: "d".repeat(40), inputSchema: { type: "object" } } } }
        return yield* Effect.gen(function* () {
          const svc = yield* SessionContextoFijo.Service
          const r = yield* svc.calcular(SessionID.make("ses_x"))
          expect(r.aproximado).toBe(true)
          // agente (400/4) + ayudante visible "explore: " + 100 caracteres; el oculto y el primario no cuentan.
          expect(r.partes.agentes).toBe(100 + Math.ceil(("explore: ".length + 100) / 4))
          expect(r.partes.skills).toBe(100)
          expect(r.partes.mcp).toBe(20 + Math.ceil(("srv_a".length + 40 + JSON.stringify({ type: "object" }).length) / 4))
          // AGENTS.md (1000) + cabecera «Instructions from: <ruta>\n»; las reglas por ruta NO suman.
          expect(r.partes.instrucciones).toBeGreaterThanOrEqual(250)
          expect(r.partes.instrucciones).toBeLessThan(250 + 40)
          expect(r.reglasPorRuta).toBe(1)
          expect(r.tokens).toBe(r.partes.agentes + r.partes.skills + r.partes.mcp + r.partes.instrucciones)
        }).pipe(Effect.provide(capa(dir, defs)))
      }),
    ),
  )

  it.live("sesión inexistente: NotFoundError", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const exit = yield* Effect.gen(function* () {
          return yield* (yield* SessionContextoFijo.Service).calcular(SessionID.make("ses_noexiste"))
        }).pipe(Effect.provide(capa(dir)), Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    ),
  )
})

import { test } from "bun:test"
function test_tokens() {
  test("tokensDe: caracteres / 4 hacia arriba, vacío es 0", () => {
    expect(tokensDe(undefined)).toBe(0)
    expect(tokensDe("")).toBe(0)
    expect(tokensDe("abcde")).toBe(2)
  })
}
