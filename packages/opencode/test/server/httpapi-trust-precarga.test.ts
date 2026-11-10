// Lazunox (Q1.1, paso 3): tras confiar una carpeta, el motor precarga su instancia plena en segundo plano.
// No retrasa la respuesta del POST, no carga carpetas que ya estaban confiadas ni nada sin la bandera de confianza.
import { NodeHttpServer } from "@effect/platform-node"
import { afterEach, beforeEach, describe, expect } from "bun:test"
import { FolderTrust } from "@opencode-ai/core/folder-trust"
import { Context, Effect, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { InstanceStore } from "../../src/project/instance-store"
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
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { testEffect } from "../lib/effect"

const llamadas: { op: string; directory: string; cold?: boolean }[] = []
let terminadas = 0
const LENTA_MS = 600

const store = Layer.mock(InstanceStore.Service)({
  evict: (directory: string) => Effect.sync(() => void llamadas.push({ op: "evict", directory })),
  load: (input: InstanceStore.LoadInput) =>
    Effect.gen(function* () {
      llamadas.push({ op: "load", directory: input.directory, cold: input.cold })
      yield* Effect.sleep(LENTA_MS)
      terminadas++
      return {} as never
    }),
})

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers, trustHandlers]),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(Layer.mock(Auth.Service)({})),
  Layer.provide(store),
  Layer.provide(Layer.mock(Config.Service)({})),
  Layer.provide(Layer.mock(MoveSession.Service)({})),
  Layer.provide(Layer.mock(Installation.Service)({})),
  Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode" })),
)
const it = testEffect(apiLayer)

const tmpdirScoped = () =>
  Effect.acquireRelease(
    Effect.sync(() => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "q11-trust-")))),
    (dir) => Effect.sync(() => fs.rmSync(dir, { recursive: true, force: true })),
  )

const confiar = (directory: string) =>
  HttpClientRequest.post("/lazunox/trust").pipe(HttpClientRequest.bodyJsonUnsafe({ directory }), HttpClient.execute)

describe("precarga al confiar (Q1.1 paso 3)", () => {
  const saved = process.env.LAZUNOX_TRUST_REQUIRED
  beforeEach(() => {
    FolderTrust.reset()
    llamadas.length = 0
    terminadas = 0
  })
  afterEach(() => {
    FolderTrust.reset()
    if (saved === undefined) delete process.env.LAZUNOX_TRUST_REQUIRED
    else process.env.LAZUNOX_TRUST_REQUIRED = saved
  })

  it.live("con confianza exigida: el POST no espera la carga y la carga plena empieza en segundo plano", () =>
    Effect.gen(function* () {
      process.env.LAZUNOX_TRUST_REQUIRED = "1"
      const dir = yield* tmpdirScoped()
      const t0 = Date.now()
      const r = yield* confiar(dir)
      const ms = Date.now() - t0
      expect(r.status).toBe(200)
      expect(ms).toBeLessThan(LENTA_MS - 200)
      expect(terminadas).toBe(0) // la carga sigue en curso cuando ya respondió
      yield* Effect.sleep(50)
      const cargas = llamadas.filter((l) => l.op === "load")
      expect(cargas.length).toBeGreaterThanOrEqual(1)
      for (const c of cargas) expect(c.cold).toBeUndefined() // plena, nunca fría
      // El descarte (evict) va antes de la carga.
      expect(llamadas[0]?.op).toBe("evict")
    }),
  )

  it.live("carpeta ya confiada (sin cambios): no se vuelve a cargar", () =>
    Effect.gen(function* () {
      process.env.LAZUNOX_TRUST_REQUIRED = "1"
      const dir = yield* tmpdirScoped()
      yield* confiar(dir)
      llamadas.length = 0
      const r = yield* confiar(dir)
      expect(((yield* r.json) as { changed: boolean }).changed).toBe(false)
      yield* Effect.sleep(50)
      expect(llamadas).toEqual([])
    }),
  )

  it.live("sin la bandera de confianza: nada se precarga", () =>
    Effect.gen(function* () {
      delete process.env.LAZUNOX_TRUST_REQUIRED
      const dir = yield* tmpdirScoped()
      const r = yield* confiar(dir)
      expect(r.status).toBe(200)
      yield* Effect.sleep(50)
      expect(llamadas).toEqual([])
    }),
  )

  it.live("carpeta inexistente: 404 y no se carga nada", () =>
    Effect.gen(function* () {
      process.env.LAZUNOX_TRUST_REQUIRED = "1"
      const r = yield* confiar("/no/existe/q11-xyz")
      expect(r.status).toBe(404)
      yield* Effect.sleep(50)
      expect(llamadas).toEqual([])
    }),
  )
})
