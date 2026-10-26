import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { Session } from "@/session/session"
import { Database } from "@opencode-ai/core/database/database"
import { Objetivo } from "../../src/session/objetivo"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

// Lazunox 3A: rutas GET/POST/DELETE /experimental/session/{sessionID}/objetivo (pertenencia a la sesión, validación).
const it = testEffect(Layer.mergeAll(LayerNode.compile(LayerNode.group([Session.node, Database.node])), httpApiLayer))

const json = <T>(response: HttpClientResponse.HttpClientResponse) => response.json.pipe(Effect.map((v) => v as T))
const url = (id: string) => `/experimental/session/${id}/objetivo`
const get = (id: string, dir: string) => requestInDirectory(url(id), dir)
const post = (id: string, dir: string, body: unknown) =>
  requestInDirectory(url(id), dir, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } })
const del = (id: string, dir: string) => requestInDirectory(url(id), dir, { method: "DELETE" })

afterEach(async () => {
  Objetivo.reiniciarParaPruebas()
  await disposeAllInstances()
  await resetDatabase()
})

describe("rutas del objetivo", () => {
  it.instance("apagado por defecto; crear, leer y quitar pertenecen a SU sesión", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const sessions = yield* Session.Service
      const a = yield* sessions.create({ title: "a" })
      const b = yield* sessions.create({ title: "b" })
      expect(yield* json(yield* get(a.id, directory))).toEqual({ objetivo: null })
      const creada = yield* json<{ objetivo: { estado: string; tope: number; verificar?: string } }>(
        yield* post(a.id, directory, { condicion: "que pasen las pruebas", verificar: "$ bun test", tope: 999 }),
      )
      expect(creada.objetivo).toMatchObject({ estado: "activo", tope: 25, verificar: "bun test" })
      expect(yield* json(yield* get(b.id, directory))).toEqual({ objetivo: null }) // la otra sesión no lo ve
      expect(yield* json(yield* del(b.id, directory))).toEqual({ ok: false }) // ni lo puede quitar
      expect(Objetivo.obtener(a.id)).toBeDefined()
      expect(yield* json(yield* del(a.id, directory))).toEqual({ ok: true })
      expect(yield* json(yield* get(a.id, directory))).toEqual({ objetivo: null })
    }),
  )
  it.instance("sesión inexistente => 404 en las tres rutas; entradas inválidas => 400 y no se crea nada", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const sessions = yield* Session.Service
      const a = yield* sessions.create({ title: "a" })
      expect((yield* get("ses_noexiste", directory)).status).toBe(404)
      expect((yield* post("ses_noexiste", directory, { condicion: "x" })).status).toBe(404)
      expect((yield* del("ses_noexiste", directory)).status).toBe(404)
      expect((yield* post(a.id, directory, {})).status).toBe(400)
      expect((yield* post(a.id, directory, { condicion: "x", tope: 0 })).status).toBe(400)
      expect((yield* post(a.id, directory, { condicion: "x".repeat(2001) })).status).toBe(400)
      expect((yield* post(a.id, directory, { reanudar: true })).status).toBe(400) // nada que reanudar
      expect(Objetivo.obtener(a.id)).toBeUndefined()
    }),
  )
  it.instance("reanudar vuelve a activar un objetivo detenido, pero no uno cumplido", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const sessions = yield* Session.Service
      const a = yield* sessions.create({ title: "a" })
      yield* post(a.id, directory, { condicion: "x" })
      Objetivo.finalizar(a.id, "bloqueado")
      const resp = yield* post(a.id, directory, { reanudar: true })
      const r = yield* json<{ objetivo: { estado: string } }>(resp)
      if (!r.objetivo) throw new Error(`status ${resp.status} ${JSON.stringify(r)}`)
      expect(r.objetivo.estado).toBe("activo")
      Objetivo.finalizar(a.id, "cumplido")
      expect((yield* post(a.id, directory, { reanudar: true })).status).toBe(400)
    }),
  )
})
