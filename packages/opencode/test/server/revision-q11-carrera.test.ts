// Revisión RI1-B2: carrera confiar → quitar confianza con el InstanceStore real.
import { NodeHttpServer } from "@effect/platform-node"
import { afterEach, describe, expect } from "bun:test"
import { FolderTrust } from "@opencode-ai/core/folder-trust"
import { Context, Effect, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import fs from "node:fs"
import os from "node:os"
import { execSync } from "node:child_process"
import path from "node:path"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { GlobalBus } from "../../src/bus/global"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { Installation } from "../../src/installation"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { trustHandlers } from "../../src/server/routes/instance/httpapi/handlers/trust"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"
import { workspaceLayerWithRuntimeFlags } from "../fixture/workspace"
import { testEffect } from "../lib/effect"
import { registerDisposer } from "../../src/effect/instance-registry"

const ws = workspaceLayerWithRuntimeFlags({})
const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers, trustHandlers]),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(Layer.mock(Auth.Service)({})),
  Layer.provide(Layer.mock(Config.Service)({})),
  Layer.provide(Layer.mock(MoveSession.Service)({})),
  Layer.provide(Layer.mock(Installation.Service)({})),
  Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode" })),
)
const stateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() => Effect.promise(async () => { await disposeAllInstances(); await resetDatabase() }))
  }),
)
const it = testEffect(Layer.mergeAll(stateLayer, apiLayer.pipe(Layer.provideMerge(ws))))

const carpetaGit = () =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "q11-carrera-")))
      execSync("git init -q && git -c user.email=a@b -c user.name=t commit -q --allow-empty -m init", { cwd: dir })
      return dir
    }),
    (dir) => Effect.sync(() => fs.rmSync(dir, { recursive: true, force: true })),
  )
const body = (directory: string) => HttpClientRequest.bodyJsonUnsafe({ directory })
const confiar = (d: string) => HttpClientRequest.post("/lazunox/trust").pipe(body(d), HttpClient.execute)
const quitar = (d: string) => HttpClientRequest.delete("/lazunox/trust").pipe(body(d), HttpClient.execute)

describe("REVISIÓN carrera confiar/quitar", () => {
  afterEach(() => FolderTrust.reset())
  it.live("ventana: DELETE llega mientras el POST hace evict (disposer lento de 300 ms simulando una instancia fría que se descarga)", () =>
    Effect.gen(function* () {
      process.env.LAZUNOX_TRUST_REQUIRED = "1"
      const dir = yield* carpetaGit()
      const marca = path.join(dir, "..", path.basename(dir) + ".plugin-cargado")
      fs.mkdirSync(path.join(dir, ".opencode", "plugin"), { recursive: true })
      fs.writeFileSync(
        path.join(dir, ".opencode", "plugin", "marca.ts"),
        `import fs from "node:fs"\nfs.appendFileSync(${JSON.stringify(marca)}, "x")\nexport const Marca = async () => ({})\n`,
      )
      let lento = true
      const off = registerDisposer(async (d) => { if (lento && d === dir) { lento = false; await new Promise((r) => setTimeout(r, 300)) } })
      const eventos: string[] = []
      const on = (e: any) => { if (e?.payload?.type === "server.instance.disposed" && e.directory === dir) eventos.push("disposed") }
      GlobalBus.on("event", on)
      const t0 = Date.now()
      const [rPost, rDel] = yield* Effect.all([confiar(dir), Effect.sleep(80).pipe(Effect.andThen(quitar(dir)))], { concurrency: "unbounded" })
      console.log("POST", rPost.status, "DELETE", rDel.status, (yield* rDel.json), "ms", Date.now() - t0)
      console.log("confiada tras la carrera:", FolderTrust.isTrusted(dir))
      yield* Effect.sleep(5000)
      console.log("plugin de la carpeta cargado:", fs.existsSync(marca))
      console.log("eventos disposed (0 = instancia plena sigue viva):", eventos.length)
      const cargado = fs.existsSync(marca)
      GlobalBus.off("event", on)
      off()
      fs.rmSync(marca, { force: true })
      // Con la confianza quitada, no debe quedar una instancia plena viva ni haberse ejecutado el código de la carpeta.
      expect(FolderTrust.isTrusted(dir)).toBe(false)
      expect(cargado).toBe(false)
      delete process.env.LAZUNOX_TRUST_REQUIRED
    }),
    30_000,
  )
})
