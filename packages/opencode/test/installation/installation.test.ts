import { describe, expect } from "bun:test"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Effect, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Installation } from "../../src/installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"

const encoder = new TextEncoder()

function mockHttpClient(handler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const client = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))))
  return Layer.succeed(HttpClient.HttpClient, client)
}

function mockSpawner(
  handler: (cmd: string, args: readonly string[]) => string | { code: number; stdout?: string; stderr?: string } = () =>
    "",
) {
  const spawner = ChildProcessSpawner.make((command) => {
    const std = ChildProcess.isStandardCommand(command) ? command : undefined
    const result = handler(std?.command ?? "", std?.args ?? [])
    const output = typeof result === "string" ? { code: 0, stdout: result, stderr: "" } : result
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(output.code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as any,
        stdout: output.stdout ? Stream.make(encoder.encode(output.stdout)) : Stream.empty,
        stderr: output.stderr ? Stream.make(encoder.encode(output.stderr)) : Stream.empty,
        all: Stream.empty,
        getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as any,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    )
  })
  return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function testLayer(
  httpHandler: (request: HttpClientRequest.HttpClientRequest) => Response,
  spawnHandler?: (cmd: string, args: readonly string[]) => string | { code: number; stdout?: string; stderr?: string },
) {
  const spawnerNode = makeGlobalNode({
    service: ChildProcessSpawner.ChildProcessSpawner,
    layer: mockSpawner(spawnHandler),
    deps: [],
  })
  return LayerNode.compile(Installation.node, [
    [httpClient, mockHttpClient(httpHandler)],
    [CrossSpawnSpawner.node, spawnerNode],
  ])
}

// Lazunox: el motor no consulta ni descarga actualizaciones por su cuenta (se actualiza con la app).
describe("installation", () => {
  const calls: string[] = []
  const layer = testLayer(
    (request) => {
      calls.push(request.url)
      return jsonResponse({ tag_name: "v99.0.0", version: "99.0.0" })
    },
    (cmd) => {
      calls.push(cmd)
      return ""
    },
  )

  describe("latest", () => {
    for (const method of ["unknown", "curl", "npm", "bun", "pnpm", "brew", "choco", "scoop"] as const) {
      testEffect(layer).effect(`no consulta nada ni dice que haya versión nueva (${method})`, () =>
        Effect.gen(function* () {
          calls.length = 0
          const result = yield* Installation.use.latest(method)
          expect(result).toBe(InstallationVersion)
          expect(calls).toEqual([])
        }),
      )
    }
  })

  describe("upgrade", () => {
    testEffect(layer).effect("rechaza actualizar y no ejecuta nada", () =>
      Effect.gen(function* () {
        calls.length = 0
        const error = yield* Effect.flip(Installation.use.upgrade("npm", "99.0.0"))
        expect(error.stderr).toBe(Installation.LAZUNOX_NO_UPGRADE)
        expect(calls).toEqual([])
      }),
    )
  })

  describe("upgradeMajor", () => {
    testEffect(layer).effect("rechaza actualizar y no ejecuta nada", () =>
      Effect.gen(function* () {
        calls.length = 0
        const error = yield* Effect.flip(Installation.use.upgradeMajor("curl"))
        expect(error.stderr).toBe(Installation.LAZUNOX_NO_UPGRADE)
        expect(calls).toEqual([])
      }),
    )
  })
})
