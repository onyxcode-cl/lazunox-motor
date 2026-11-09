// Lazunox (lazunox.16, B2): la puerta de confianza del middleware de instancia (403 folder_not_trusted, carpeta fría para lecturas de
// historial, carpeta confiada con su ruta registrada) y el endpoint /lazunox/trust.
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { afterEach, beforeEach, describe, expect } from "bun:test"
import { FolderTrust } from "@opencode-ai/core/folder-trust"
import { Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import * as Socket from "effect/unstable/socket/Socket"
import fs from "node:fs"
import path from "node:path"
import { registerAdapter } from "../../src/control-plane/adapters"
import type { WorkspaceAdapter } from "../../src/control-plane/types"
import { Workspace } from "../../src/control-plane/workspace"
import { InstanceRef } from "../../src/effect/instance-ref"
import { Project } from "../../src/project/project"
import { InstanceStore } from "../../src/project/instance-store"
import { Session } from "../../src/session/session"
import { InstanceContextMiddleware, instanceContextLayer } from "../../src/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  workspaceRoutingLayer,
} from "../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { workspaceLayerWithRuntimeFlags } from "../fixture/workspace"
import { testEffect } from "../lib/effect"

const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await disposeAllInstances()
        await resetDatabase()
      }),
    )
  }),
)
const it = testEffect(
  Layer.mergeAll(testStateLayer, NodeHttpServer.layerTest, NodeServices.layer, workspaceLayerWithRuntimeFlags({ experimentalWorkspaces: true })),
)

const ProbeResult = Schema.Struct({ directory: Schema.optional(Schema.String), cold: Schema.optional(Schema.Boolean) })
const ProbeApi = HttpApi.make("trust-probe").add(
  HttpApiGroup.make("probe")
    .add(
      HttpApiEndpoint.get("agent", "/agent", { query: WorkspaceRoutingQuery, success: ProbeResult }),
      HttpApiEndpoint.get("sessions", "/session", { query: WorkspaceRoutingQuery, success: ProbeResult }),
      HttpApiEndpoint.post("create", "/session", { query: WorkspaceRoutingQuery, success: ProbeResult }),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware),
)
const probe = Effect.gen(function* () {
  const instance = yield* InstanceRef
  return { directory: instance?.directory, cold: instance?.cold }
})
const routes = HttpApiBuilder.layer(ProbeApi).pipe(
  Layer.provide(HttpApiBuilder.group(ProbeApi, "probe", (h) => h.handle("agent", () => probe).handle("sessions", () => probe).handle("create", () => probe))),
  Layer.provide(
    Layer.mergeAll(instanceContextLayer, workspaceRoutingLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal))),
  ),
  Layer.provide(Layer.mock(Session.Service)({})),
)
const serve = () => routes.pipe(HttpRouter.serve, Layer.build)
const get = (p: string, dir: string, headers: Record<string, string> = {}) =>
  HttpClientRequest.get(`${p}${p.includes("?") ? "&" : "?"}directory=${encodeURIComponent(dir)}`).pipe(
    (r) => Object.entries(headers).reduce((acc, [k, v]) => HttpClientRequest.setHeader(acc, k, v), r),
    HttpClient.execute,
  )

describe("puerta de confianza del middleware de instancia", () => {
  const saved = process.env.LAZUNOX_TRUST_REQUIRED
  beforeEach(() => FolderTrust.reset())
  afterEach(() => {
    FolderTrust.reset()
    if (saved === undefined) delete process.env.LAZUNOX_TRUST_REQUIRED
    else process.env.LAZUNOX_TRUST_REQUIRED = saved
  })

  it.live("sin la bandera: todo como hoy (carpeta no confiada se carga plena)", () =>
    Effect.gen(function* () {
      delete process.env.LAZUNOX_TRUST_REQUIRED
      const dir = yield* tmpdirScoped({ git: true })
      yield* serve()
      const r = yield* get("/agent", dir)
      expect(r.status).toBe(200)
      expect(yield* r.json).toEqual({ directory: dir, cold: null })
    }),
  )

  it.live("con la bandera: carpeta no confiada → 403 en rutas cerradas, fría (sin guardar el proyecto) en lecturas", () =>
    Effect.gen(function* () {
      process.env.LAZUNOX_TRUST_REQUIRED = "1"
      const dir = yield* tmpdirScoped({ git: true })
      yield* serve()
      const cerrada = yield* get("/agent", dir)
      expect(cerrada.status).toBe(403)
      expect(yield* cerrada.json).toEqual({ error: "folder_not_trusted" })
      const post = yield* HttpClientRequest.post(`/session?directory=${encodeURIComponent(dir)}`).pipe(HttpClient.execute)
      expect(post.status).toBe(403)
      const fria = yield* get("/session", dir)
      expect(fria.status).toBe(200)
      expect(yield* fria.json).toEqual({ directory: dir, cold: true })
      // La instancia fría no escribió el proyecto en la base.
      const guardado = (yield* Project.use.list()).find((p) => p.worktree === dir)
      expect(guardado).toBeUndefined()
    }),
  )

  it.live("confiada: carga plena con la ruta registrada; enlaces y grafías de la misma carpeta valen; hijas y madres no", () =>
    Effect.gen(function* () {
      process.env.LAZUNOX_TRUST_REQUIRED = "1"
      const dir = yield* tmpdirScoped({ git: true })
      const sub = path.join(dir, "sub")
      fs.mkdirSync(sub)
      const link = path.join(dir, "..", `enlace-${path.basename(dir)}`)
      fs.symlinkSync(dir, link)
      yield* Effect.addFinalizer(() => Effect.sync(() => fs.rmSync(link, { force: true })))
      yield* serve()
      expect((yield* get("/agent", dir)).status).toBe(403)
      expect(FolderTrust.trust(dir)?.added).toBe(true)
      const ok = yield* get("/agent", dir + "/")
      expect(ok.status).toBe(200)
      expect(yield* ok.json).toEqual({ directory: dir, cold: null })
      const viaLink = yield* get("/agent", link)
      expect(viaLink.status).toBe(200)
      expect(yield* viaLink.json).toEqual({ directory: dir, cold: null })
      expect((yield* get("/agent", sub)).status).toBe(403)
      expect((yield* get("/agent", path.dirname(dir))).status).toBe(403)
      expect((yield* get("/agent", dir + "\0x")).status).toBe(403)
    }),
  )

  it.live("precedencia: manda la carpeta que el motor realmente usa (query sobre encabezado)", () =>
    Effect.gen(function* () {
      process.env.LAZUNOX_TRUST_REQUIRED = "1"
      const T = yield* tmpdirScoped({ git: true })
      const V = yield* tmpdirScoped({ git: true })
      FolderTrust.trust(T)
      yield* serve()
      expect((yield* get("/agent", V, { "x-opencode-directory": T })).status).toBe(403)
      expect((yield* get("/agent", T, { "x-opencode-directory": V })).status).toBe(200)
      const sinQuery = yield* HttpClientRequest.get("/agent").pipe(HttpClientRequest.setHeader("x-opencode-directory", V), HttpClient.execute)
      expect(sinQuery.status).toBe(403)
    }),
  )

  it.live("quitar la confianza descarga la instancia plena y no se sirve nada de la caché", () =>
    Effect.gen(function* () {
      process.env.LAZUNOX_TRUST_REQUIRED = "1"
      const dir = yield* tmpdirScoped({ git: true })
      FolderTrust.trust(dir)
      yield* serve()
      expect((yield* get("/agent", dir)).status).toBe(200)
      FolderTrust.untrust(dir)
      yield* InstanceStore.Service.use((s) => s.evict(dir))
      expect((yield* get("/agent", dir)).status).toBe(403)
      expect((yield* get("/session", dir)).status).toBe(200)
      expect(yield* (yield* get("/session", dir)).json).toEqual({ directory: dir, cold: true })
      FolderTrust.trust(dir)
      const otra = yield* get("/agent", dir)
      expect(yield* otra.json).toEqual({ directory: dir, cold: null })
    }),
  )

  it.live("un workspace local cuyo destino es una carpeta no confiada → 403", () =>
    Effect.gen(function* () {
      process.env.LAZUNOX_TRUST_REQUIRED = "1"
      const T = yield* tmpdirScoped({ git: true })
      const V = yield* tmpdirScoped({ git: true })
      FolderTrust.trust(T)
      const project = yield* Project.use.fromDirectory(T)
      const adapter = (directory: string): WorkspaceAdapter => ({
        name: "Local Test",
        description: "x",
        configure: (info) => ({ ...info, name: "local-test", directory }),
        create: async () => {},
        async remove() {},
        target: () => ({ type: "local" as const, directory }),
      })
      registerAdapter(project.project.id, "confianza-a-v", adapter(V))
      registerAdapter(project.project.id, "confianza-a-t", adapter(T))
      const wV = yield* Workspace.use.create({ type: "confianza-a-v", branch: null, extra: null, projectID: project.project.id })
      const wT = yield* Workspace.use.create({ type: "confianza-a-t", branch: null, extra: null, projectID: project.project.id })
      yield* serve()
      const aV = yield* HttpClientRequest.get(`/agent?workspace=${wV.id}`).pipe(HttpClientRequest.setHeader("x-opencode-directory", T), HttpClient.execute)
      expect(aV.status).toBe(403)
      const aT = yield* HttpClientRequest.get(`/agent?workspace=${wT.id}`).pipe(HttpClientRequest.setHeader("x-opencode-directory", V), HttpClient.execute)
      expect(aT.status).toBe(200)
      yield* Workspace.use.remove(wV.id).pipe(Effect.ignore)
      yield* Workspace.use.remove(wT.id).pipe(Effect.ignore)
    }),
  )
})
