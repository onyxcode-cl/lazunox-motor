// Revisión RI1-B1: cierre de conectores a medio conectar.
import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { execSync } from "node:child_process"
import { MCP } from "../../src/mcp/index"
import { InstanceState } from "../../src/effect/instance-state"
import { disposeInstance } from "../../src/effect/instance-registry"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(MCP.node))
const fixture = "/Users/dryogui/Documents/respaldo/OnyxCode/documentos/v1815/RI1-Q11-pruebas/mcp-lento.mjs"
const vivos = (tag: string) =>
  execSync("ps -axo pid=,command=").toString().split("\n").filter((l) => l.includes("mcp-lento.mjs") && l.includes(`REVQ11=${tag}`) && !l.includes("pgrep") && !l.includes("ps -axo")).length
const local = (name: string, tag: string, env: Record<string, string>) => ({
  type: "local" as const,
  command: [process.execPath, fixture, `REVQ11=${tag}`],
  environment: { NAME: name, ...env },
  timeout: 20_000,
})

const caso = (tag: string, env: Record<string, string>, esperaAntes: number) =>
  it.instance(
    `descartar la instancia con un conector a medio conectar (${tag})`,
    () =>
      Effect.gen(function* () {
        process.env.LAZUNOX_MCP_ESPERA_MS = "300"
        const mcp = yield* MCP.Service
        const dir = yield* InstanceState.directory
        yield* mcp.tools()
        console.log(tag, "pendientes tras el plazo:", yield* mcp.pendientes!(), "procesos vivos:", vivos(tag))
        yield* Effect.sleep(esperaAntes)
        yield* Effect.promise(() => disposeInstance(dir))
        yield* Effect.sleep(5000)
        const n = vivos(tag)
        console.log(tag, "procesos vivos 5 s después de descartar la instancia:", n)
        delete process.env.LAZUNOX_MCP_ESPERA_MS
        if (n) execSync(`pkill -f "REVQ11=${tag}" || true`)
        expect(n).toBe(0)
      }),
    { config: { mcp: { lento: local("lento", tag, env) } } },
    30_000,
  )

describe("REVISIÓN cierre con conectores pendientes", () => {
  caso("en-initialize", { DELAY: "3000" }, 200)
  caso("en-tools-list", { DELAY: "0", LIST_DELAY: "3000" }, 200)
  caso("en-tools-list-largo", { DELAY: "0", LIST_DELAY: "15000" }, 200)
  it.instance(
    "como antes (ESPERA=0): descartar mientras la primera petición espera tools/list",
    () =>
      Effect.gen(function* () {
        process.env.LAZUNOX_MCP_ESPERA_MS = "0"
        const mcp = yield* MCP.Service
        const dir = yield* InstanceState.directory
        const f = yield* mcp.tools().pipe(Effect.forkChild)
        yield* Effect.sleep(700)
        console.log("base-like procesos vivos antes:", vivos("baselike"))
        yield* Effect.promise(() => disposeInstance(dir))
        yield* Effect.sleep(5000)
        const n = vivos("baselike")
        console.log("base-like procesos vivos 5 s después:", n)
        delete process.env.LAZUNOX_MCP_ESPERA_MS
        if (n) execSync(`pkill -f "REVQ11=baselike" || true`)
      }),
    { config: { mcp: { lento: local("lento", "baselike", { DELAY: "0", LIST_DELAY: "3000" }) } } },
    30_000,
  )
})
