// 7.12: las herramientas programadas solo se ofrecen con LAZUNOX_PROGRAMADAS=1 (apagado por defecto: no cuestan tokens).
import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ToolRegistry } from "@/tool/registry"
import { disposeAllInstances } from "../fixture/fixture"
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
const NOMBRES = ["programar", "listar_programadas", "borrar_programada", "esperar_y_continuar"]

afterEach(async () => {
  delete process.env.LAZUNOX_PROGRAMADAS
  await disposeAllInstances()
})

describe("7.12 registro", () => {
  it.instance("por defecto no se ofrece ninguna", () =>
    Effect.gen(function* () {
      const ids = yield* (yield* ToolRegistry.Service).ids()
      for (const n of NOMBRES) expect(ids).not.toContain(n)
    }),
  )
  it.instance("con LAZUNOX_PROGRAMADAS=1 se ofrecen las cuatro", () =>
    Effect.gen(function* () {
      process.env.LAZUNOX_PROGRAMADAS = "1"
      const ids = yield* (yield* ToolRegistry.Service).ids()
      for (const n of NOMBRES) expect(ids).toContain(n)
    }),
  )
})
