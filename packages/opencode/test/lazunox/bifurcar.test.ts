// Lazunox 5D (P26): la ruta de fork YA existe en el motor (`POST /session/{id}/fork`, cuerpo opcional `{messageID}`). Aquí se
// fija su contrato y se prueba su relación con rebobinar: el fork copia los mensajes ANTERIORES al indicado (el indicado no
// entra), nunca arrastra el estado `revert` ni los permisos de la sesión de origen, y los errores son 404/400.
import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Database } from "@opencode-ai/core/database/database"
import { Effect, Layer } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { Session } from "../../src/session/session"
import { SessionSummary } from "../../src/session/summary"
import { Snapshot } from "../../src/snapshot"
import { MessageV2 } from "../../src/session/message-v2"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "../server/httpapi-layer"
import { escribir, turno } from "./rebobinar-util"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        Session.node,
        Snapshot.node,
        SessionSummary.node,
        FSUtil.node,
        SessionProjector.node,
        Database.node,
        MessageV2.node,
      ]),
    ),
    httpApiLayer,
  ),
)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const json = <T>(res: HttpClientResponse.HttpClientResponse) => res.json.pipe(Effect.map((v) => v as T))
const post = (url: string, directory: string, body?: unknown) =>
  requestInDirectory(url, directory, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
const textos = (sessionID: Session.Info["id"]) =>
  MessageV2.filterCompactedEffect(sessionID).pipe(
    Effect.map((ms) =>
      ms.filter((m) => m.info.role === "user").flatMap((m) => m.parts.filter((p) => p.type === "text").map((p: any) => p.text)),
    ),
  )

describe("5D: fork de sesión (contrato de la ruta existente)", () => {
  it.instance(
    "fork con messageID copia solo lo anterior; sin messageID copia todo; el origen no cambia",
    () =>
      Effect.gen(function* () {
        const { directory: d } = yield* TestInstance
        const origen = (yield* Session.Service.use((s) => s.create({ title: "origen" }))).id
        yield* escribir(`${d}/a.txt`, "A0")
        const t1 = yield* turno({ sessionID: origen, dir: d, texto: "uno", mutar: escribir(`${d}/a.txt`, "A1") })
        const t2 = yield* turno({ sessionID: origen, dir: d, texto: "dos", mutar: escribir(`${d}/a.txt`, "A2") })
        const t3 = yield* turno({ sessionID: origen, dir: d, texto: "tres", mutar: escribir(`${d}/a.txt`, "A3") })

        const res = yield* post(`/session/${origen}/fork`, d, { messageID: t3.user.id })
        expect(res.status).toBe(200)
        const hijo = yield* json<Session.Info>(res)
        expect(hijo.id).not.toBe(origen)
        expect(hijo.title).toBe("origen (fork #1)")
        expect(hijo.revert).toBeUndefined()
        expect(yield* textos(hijo.id)).toEqual(["uno", "dos"]) // el mensaje indicado NO entra
        // los mensajes copiados son nuevos (ids propios, sessionID del fork)
        const ms = yield* MessageV2.filterCompactedEffect(hijo.id)
        expect(ms.every((m) => m.info.sessionID === hijo.id)).toBe(true)
        expect(ms.some((m) => [t1.user.id, t2.user.id, t1.assistant.id].includes(m.info.id as any))).toBe(false)

        const todo = yield* json<Session.Info>(yield* post(`/session/${origen}/fork`, d))
        expect(yield* textos(todo.id)).toEqual(["uno", "dos", "tres"])
        // el origen sigue intacto
        expect(yield* textos(origen)).toEqual(["uno", "dos", "tres"])
        expect(t3.user.id).toBeDefined()
      }),
    { git: true },
  )

  it.instance(
    "errores: sesión inexistente = 404; cuerpo inválido = 400",
    () =>
      Effect.gen(function* () {
        const { directory: d } = yield* TestInstance
        const origen = (yield* Session.Service.use((s) => s.create({}))).id
        expect((yield* post(`/session/ses_noexiste/fork`, d, {})).status).toBe(404)
        expect((yield* post(`/session/${origen}/fork`, d, { messageID: 5 })).status).toBe(400)
        expect((yield* requestInDirectory(`/session/${origen}/fork`, d, { method: "POST", body: "{no es json" })).status).toBe(400)
      }),
    { git: true },
  )

  it.instance(
    "rebobinar + fork: el fork NO hereda `revert`, ni permisos de la sesión de origen",
    () =>
      Effect.gen(function* () {
        const { directory: d } = yield* TestInstance
        const sessions = yield* Session.Service
        const origen = (
          yield* sessions.create({ title: "origen", permission: [{ permission: "bash", pattern: "*", action: "allow" }] })
        ).id
        yield* escribir(`${d}/a.txt`, "A0")
        const t1 = yield* turno({ sessionID: origen, dir: d, texto: "uno", mutar: escribir(`${d}/a.txt`, "A1") })
        const t2 = yield* turno({ sessionID: origen, dir: d, texto: "dos", mutar: escribir(`${d}/a.txt`, "A2") })
        const base = `/experimental/session/${origen}`
        expect((yield* post(`${base}/rebobinar`, d, { messageID: t2.user.id, modo: "todo" })).status).toBe(200)
        expect((yield* sessions.get(origen)).revert).toBeDefined()

        // Bifurcar desde el punto rebobinado: solo lo anterior a «dos».
        const hijo = yield* json<Session.Info>(yield* post(`/session/${origen}/fork`, d, { messageID: t2.user.id }))
        expect(hijo.revert).toBeUndefined()
        expect(hijo.permission).toBeUndefined()
        expect(yield* textos(hijo.id)).toEqual(["uno"])
        expect(t1.user.id).toBeDefined()
        // El estado de rebobinar del origen sigue ahí y el fork no lo toca.
        expect((yield* sessions.get(origen)).revert).toBeDefined()
        expect((yield* sessions.get(hijo.id)).revert).toBeUndefined()

        // Sin messageID sobre una sesión rebobinada: el corte es el punto de rebobinado (lo deshecho NO resucita en el fork).
        const completo = yield* json<Session.Info>(yield* post(`/session/${origen}/fork`, d))
        expect(completo.revert).toBeUndefined()
        expect(yield* textos(completo.id)).toEqual(["uno"])
        // Tras deshacer el rebobinado, el fork sin messageID vuelve a copiar todo.
        expect((yield* post(`${base}/rebobinar/deshacer`, d, {})).status).toBe(200)
        const tras = yield* json<Session.Info>(yield* post(`/session/${origen}/fork`, d))
        expect(yield* textos(tras.id)).toEqual(["uno", "dos"])
      }),
    { git: true },
  )
})
