// Cierre de conectores a medio conectar (Q1.1, revisiones RI1-B1 y RI2).
// Portable: cada conector de prueba escribe su PID a un archivo y aquí se comprueba con process.kill(pid, 0); no usa ps ni pkill.
import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { MCP } from "../../src/mcp/index"
import { InstanceState } from "../../src/effect/instance-state"
import { disposeInstance } from "../../src/effect/instance-registry"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(MCP.node))
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixture", "mcp-lento-stdio.mjs")

const pidDir = () => mkdtempSync(path.join(tmpdir(), "lzx-mcp-lento-"))
const pids = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".pid")).map((f) => Number(readFileSync(path.join(dir, f), "utf8")))
const vivo = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const vivos = (dir: string) => pids(dir).filter(vivo)
// Espera (con sondeo) a que no quede ninguno vivo, hasta `max` ms; devuelve los que siguen vivos.
const hastaCero = (dir: string, max: number) =>
  Effect.gen(function* () {
    const fin = Date.now() + max
    while (Date.now() < fin && vivos(dir).length) yield* Effect.sleep(100)
    return vivos(dir)
  })
const limpiar = (dir: string) => {
  for (const pid of vivos(dir)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
  rmSync(dir, { recursive: true, force: true })
}
const local = (name: string, dir: string, env: Record<string, string>) => ({
  type: "local" as const,
  command: [process.execPath, fixture],
  environment: { NAME: name, PIDDIR: dir, ...env },
  timeout: 20_000,
})

const caso = (tag: string, env: Record<string, string>, esperaAntes: number) => {
  const dir = pidDir()
  return it.instance(
    `descartar la instancia con un conector a medio conectar (${tag})`,
    () =>
      Effect.gen(function* () {
        process.env.LAZUNOX_MCP_ESPERA_MS = "300"
        const mcp = yield* MCP.Service
        const directory = yield* InstanceState.directory
        yield* mcp.tools().pipe(Effect.ensuring(Effect.sync(() => delete process.env.LAZUNOX_MCP_ESPERA_MS)))
        yield* Effect.sleep(esperaAntes)
        yield* Effect.promise(() => disposeInstance(directory))
        const quedan = yield* hastaCero(dir, 4000)
        limpiar(dir)
        expect(quedan).toEqual([])
      }),
    { config: { mcp: { lento: local("lento", dir, env) } } },
    20_000,
  )
}

describe("cierre con conectores pendientes", () => {
  caso("en-initialize", { DELAY: "2000" }, 200)
  caso("en-tools-list", { DELAY: "0", LIST_DELAY: "2000" }, 200)
  caso("en-tools-list-largo", { DELAY: "0", LIST_DELAY: "10000" }, 200)
})
