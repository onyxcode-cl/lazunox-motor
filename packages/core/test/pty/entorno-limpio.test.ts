// Lazunox (motor-18, A): el pty (terminal integrada) no hereda las variables del motor; sí PATH/HOME y lo que agrega `shell.env`.
import { afterEach, beforeEach, describe, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Config } from "@opencode-ai/core/config"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { Pty } from "@opencode-ai/core/pty"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

const locationLayer = Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/tmp") })))
const configLayer = Layer.mock(Config.Service)({ entries: () => Effect.succeed([]) })
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Pty.node, EventV2.node]), [
    [Config.node, configLayer],
    [Location.node, locationLayer],
  ]),
)
const ptyTest = process.platform === "win32" ? it.live.skip : it.live

const antes = { ...process.env }
beforeEach(() => {
  Object.assign(process.env, { LAZUNOX_CENTINELA: "centinela-inventada", OPENCODE_SERVER_PASSWORD: "x", LAZUNOX_PYTHON: "/p" })
  delete process.env.LAZUNOX_ENTORNO_LIMPIO
})
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in antes)) delete process.env[k]
  Object.assign(process.env, antes)
})

const volcar = (salida: string) =>
  Effect.gen(function* () {
    const pty = yield* Pty.Service
    const script = `require("node:fs").writeFileSync(${JSON.stringify(salida)}, JSON.stringify(Object.keys(process.env)))`
    const info = yield* pty.create({ command: process.execPath, args: ["-e", script], cwd: "/tmp", env: { DE_SHELL_ENV: "1" } })
    for (let i = 0; i < 100 && !fs.existsSync(salida); i++) yield* Effect.sleep("50 millis")
    yield* pty.remove(info.id).pipe(Effect.ignore)
    const n = JSON.parse(fs.readFileSync(salida, "utf8")) as string[]
    fs.rmSync(salida, { force: true })
    return n
  })

describe("pty: entorno limpio", () => {
  ptyTest("no ve la centinela ni la contraseña; sí PATH, HOME, LAZUNOX_PYTHON y lo de shell.env", () =>
    Effect.gen(function* () {
      const n = yield* volcar(path.join(os.tmpdir(), `lzx-m18-pty-${process.pid}.json`))
      expect(n).not.toContain("LAZUNOX_CENTINELA")
      expect(n).not.toContain("OPENCODE_SERVER_PASSWORD")
      for (const k of ["PATH", "HOME", "LAZUNOX_PYTHON", "DE_SHELL_ENV", "OPENCODE_TERMINAL", "TERM"]) expect(n).toContain(k)
    }),
  )
  ptyTest("apagado (LAZUNOX_ENTORNO_LIMPIO=0): vuelven", () =>
    Effect.gen(function* () {
      process.env.LAZUNOX_ENTORNO_LIMPIO = "0"
      const n = yield* volcar(path.join(os.tmpdir(), `lzx-m18-pty0-${process.pid}.json`))
      expect(n).toContain("LAZUNOX_CENTINELA")
    }),
  )
})
