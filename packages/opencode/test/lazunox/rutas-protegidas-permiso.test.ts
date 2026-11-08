// Lazunox lazunox.15 (ronda 5): el cableado de `Permission.ask` con `esProtegida`: en un proyecto SIN git los patrones de `edit` salen
// relativos a `/` (base) y la comprobación de enlaces tiene que usar esa base; si no, nunca se aplicaba fuera de repositorios git.
import { afterEach, describe, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Effect, Layer, Option } from "effect"
import { Permission } from "../../src/permission"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { SessionID } from "../../src/session/schema"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
    [[InstanceStore.bootstrapNode, noopBootstrap]],
  ),
)
afterEach(async () => {
  await disposeAllInstances()
})

describe("Permission.ask + rutas protegidas + enlaces", () => {
  const probar = (git: boolean) =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = test.directory
      fs.symlinkSync(".mcp.json", path.join(dir, "x")) // enlace roto hacia un archivo protegido
      const svc = yield* Permission.Service
      const pide = (rel: string) =>
        svc
          .ask({
            sessionID: SessionID.make("ses_rp"),
            permission: "edit",
            // como lo construyen edit/write/apply_patch: relativo al worktree (en un proyecto sin git, `/`)
            patterns: [path.relative(git ? dir : "/", path.join(dir, rel))],
            metadata: {},
            always: [],
            ruleset: [{ permission: "edit", pattern: "*", action: "allow" }], // modo permisivo: allow a todo
          })
          .pipe(Effect.as("aprobada"), Effect.timeoutOption("150 millis"))
      expect(yield* pide("normal.ts")).toEqual(Option.some("aprobada"))
      expect(yield* pide("x")).toEqual(Option.none()) // pregunta (queda pendiente) aunque la regla diga allow
    })
  it.instance("proyecto con git", () => probar(true), { git: true })
  it.instance("proyecto SIN git (patrón relativo a `/`)", () => probar(false))
})
