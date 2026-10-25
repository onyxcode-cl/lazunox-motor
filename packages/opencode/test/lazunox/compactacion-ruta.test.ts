import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Schema } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { BackgroundJob } from "@/background/job"
import { Permission } from "@/permission"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { Database } from "@opencode-ai/core/database/database"
import { MessageID } from "@/session/schema"
import { SummarizePayload } from "../../src/server/routes/instance/httpapi/groups/session"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "../server/httpapi-layer"
import { userMsg } from "./compactacion-util"

// C1: POST /session/{id}/summarize responde 409 {motivo} en momentos inseguros, ya no consolida un revert pendiente en silencio
// y acepta el cuerpo sin modelo (la app llamaba así desde Code y recibía 400).
const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(LayerNode.group([Session.node, Database.node, BackgroundJob.node, Permission.node, SessionStatus.node])),
    httpApiLayer,
  ),
)

const json = <T>(response: HttpClientResponse.HttpClientResponse) => response.json.pipe(Effect.map((v) => v as T))
const resumir = (sessionID: string, directory: string, body: unknown) =>
  requestInDirectory(`/session/${sessionID}/summarize`, directory, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("POST /session/{id}/summarize", () => {
  it.instance("el cuerpo sin providerID/modelID es válido (antes daba 400 y «Compactar historial» de Code no funcionaba)", () =>
    Effect.sync(() => {
      expect(() => Schema.decodeUnknownSync(SummarizePayload)({})).not.toThrow()
      expect(() => Schema.decodeUnknownSync(SummarizePayload)({ auto: true, upTo: "msg_abc" })).not.toThrow()
      expect(() => Schema.decodeUnknownSync(SummarizePayload)({ upTo: 5 })).toThrow()
    }),
  )

  it.instance("revert pendiente: 409 motivo «revert» y el revert NO se consolida", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const ssn = yield* Session.Service
      const s = yield* ssn.create({})
      const u1 = yield* userMsg(s.id, "uno")
      yield* userMsg(s.id, "dos")
      yield* ssn.setRevert({ sessionID: s.id, revert: { messageID: u1.id }, summary: undefined })

      const res = yield* resumir(s.id, directory, {})
      expect(res.status).toBe(409)
      expect(yield* json(res)).toMatchObject({ motivo: "revert", sessionID: s.id })
      expect((yield* ssn.get(s.id)).revert?.messageID).toBe(u1.id)
      // Los mensajes «ocultos» siguen ahí: antes el cleanup los borraba antes de compactar.
      expect((yield* ssn.messages({ sessionID: s.id })).length).toBe(2)
    }),
  )

  it.instance("sesión ocupada: 409 motivo «ocupada»", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const s = yield* (yield* Session.Service).create({})
      yield* (yield* SessionStatus.Service).set(s.id, { type: "busy" })
      const res = yield* resumir(s.id, directory, { providerID: "test", modelID: "test-model" })
      expect(res.status).toBe(409)
      expect(yield* json(res)).toMatchObject({ motivo: "ocupada" })
    }),
  )

  it.instance("permiso pendiente: 409 motivo «pendiente»; el de otra sesión no bloquea", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const ssn = yield* Session.Service
      const a = yield* ssn.create({})
      const b = yield* ssn.create({})
      const perm = yield* Permission.Service
      yield* perm
        .ask({ sessionID: a.id, permission: "bash", patterns: ["ls"], always: [], metadata: {}, ruleset: [] })
        .pipe(Effect.ignore, Effect.forkChild)
      yield* Effect.yieldNow
      expect((yield* perm.list()).length).toBe(1)

      const res = yield* resumir(a.id, directory, {})
      expect(res.status).toBe(409)
      expect(yield* json(res)).toMatchObject({ motivo: "pendiente" })

      // La sesión b no tiene nada pendiente: sigue su camino (aquí falla por otro motivo, nunca por 409).
      const otra = yield* resumir(b.id, directory, { upTo: MessageID.ascending() })
      expect(otra.status).not.toBe(409)
    }),
  )

  it.instance("upTo inexistente: 400 con kind «invalido», sin crear ninguna compactación y resolviendo el modelo de la sesión", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const ssn = yield* Session.Service
      const s = yield* ssn.create({})
      yield* userMsg(s.id, "uno")
      yield* userMsg(s.id, "dos")
      const res = yield* resumir(s.id, directory, { upTo: MessageID.ascending() })
      expect(res.status).toBe(400)
      expect(yield* json(res)).toMatchObject({ kind: "invalido", field: "upTo" })
      expect((yield* ssn.messages({ sessionID: s.id })).length).toBe(2)
    }),
  )
})
