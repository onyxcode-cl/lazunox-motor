// 7.15: el registro ofrece cuaderno_editar solo si el proyecto tiene cuadernos (o si LAZUNOX_CUADERNO=1), y nunca con =0.
import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ToolRegistry } from "@/tool/registry"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"

const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".opencode")])),
})
const it = testEffect(
  LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node]), [
    [Config.node, configLayer],
    [RuntimeFlags.node, RuntimeFlags.layer()],
  ]),
)

afterEach(async () => {
  delete process.env.LAZUNOX_CUADERNO
  await disposeAllInstances()
})

describe("7.15 registro", () => {
  it.instance("sin cuadernos en el proyecto no se ofrece (no cuesta tokens)", () =>
    Effect.gen(function* () {
      expect(yield* (yield* ToolRegistry.Service).ids()).not.toContain("cuaderno_editar")
    }),
  )
  it.instance("con LAZUNOX_CUADERNO=1 se ofrece aunque no haya cuadernos", () =>
    Effect.gen(function* () {
      process.env.LAZUNOX_CUADERNO = "1"
      expect(yield* (yield* ToolRegistry.Service).ids()).toContain("cuaderno_editar")
    }),
  )
  it.instance("con un .ipynb en el proyecto se ofrece, y con =0 no", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      yield* Effect.promise(() => fs.writeFile(path.join(dir, "a.ipynb"), "{}"))
      expect(yield* (yield* ToolRegistry.Service).ids()).toContain("cuaderno_editar")
    }),
  )
  it.instance("con =0 no se ofrece aunque haya cuadernos", () =>
    Effect.gen(function* () {
      process.env.LAZUNOX_CUADERNO = "0"
      const dir = (yield* TestInstance).directory
      yield* Effect.promise(() => fs.writeFile(path.join(dir, "a.ipynb"), "{}"))
      expect(yield* (yield* ToolRegistry.Service).ids()).not.toContain("cuaderno_editar")
    }),
  )
})
