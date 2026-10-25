// Lazunox R2: contrato HTTP de las rutas de turnos y rebobinar (códigos 400/404/409 y forma de las respuestas).
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
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "../server/httpapi-layer"
import { conEntorno, escribir, leer, turno } from "./rebobinar-util"

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
const post = (url: string, directory: string, body: unknown) =>
  requestInDirectory(url, directory, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

describe("rutas de rebobinar (contrato)", () => {
  it.instance(
    "turnos, revisión, rebobinar, deshacer: códigos y forma",
    Effect.gen(function* () {
      const { directory: d } = yield* TestInstance
      const sessionID = (yield* Session.Service.use((s) => s.create({}))).id
      yield* escribir(`${d}/a.txt`, "A0")
      const t1 = yield* turno({
        sessionID,
        dir: d,
        herramientas: [{ tool: "edit", input: { filePath: `${d}/a.txt` } }],
        mutar: escribir(`${d}/a.txt`, "A1"),
      })
      const base = `/experimental/session/${sessionID}`

      // GET turnos
      const turnos = yield* get(`${base}/turnos`, d)
      expect(turnos.status).toBe(200)
      const lista = yield* json<any[]>(turnos)
      expect(lista).toHaveLength(1)
      expect(lista[0]).toMatchObject({
        messageID: t1.user.id,
        truncated: false,
        restaurable: true,
        files: [{ file: "a.txt", status: "modified", additions: 1, deletions: 1, origen: "herramienta" }],
      })
      expect(typeof lista[0].time).toBe("number")

      // GET turnos/{messageID}/diff
      const diff = yield* json<any>(yield* get(`${base}/turnos/${t1.user.id}/diff?file=a.txt`, d))
      expect(diff).toMatchObject({ file: "a.txt", status: "modified", binary: false, truncated: false })
      expect(diff.patch).toContain("+A1")
      expect((yield* get(`${base}/turnos/${t1.user.id}/diff?file=nada.txt`, d)).status).toBe(404)

      // GET rebobinar/{messageID}
      const rev = yield* json<any>(yield* get(`${base}/rebobinar/${t1.user.id}`, d))
      expect(Object.keys(rev).toSorted()).toEqual(
        [
          "archivos",
          "ayudantesActivos",
          "commitsDespues",
          "comandos",
          "conflictos",
          "mensajes",
          "protegidos",
          "restaurable",
        ].toSorted(),
      )
      expect(rev.restaurable).toBe(true)
      expect((yield* get(`${base}/rebobinar/msg_noexiste`, d)).status).toBe(404)
      expect((yield* get(`${base}/rebobinar/${t1.assistant.id}`, d)).status).toBe(400) // no es de la persona
      expect((yield* get(`/experimental/session/ses_noexiste/rebobinar/${t1.user.id}`, d)).status).toBe(404)

      // POST rebobinar: modo inválido = 400; mensaje inexistente = 404
      expect((yield* post(`${base}/rebobinar`, d, { messageID: t1.user.id, modo: "otro" })).status).toBe(400)
      expect((yield* post(`${base}/rebobinar`, d, { messageID: "msg_noexiste", modo: "todo" })).status).toBe(404)

      // deshacer sin nada = 409 con motivo
      const nada = yield* post(`${base}/rebobinar/deshacer`, d, {})
      expect(nada.status).toBe(409)
      expect(yield* json<any>(nada)).toMatchObject({ _tag: "RebobinarConflicto", motivo: "nada-que-deshacer" })

      // POST rebobinar ok
      const hecho = yield* post(`${base}/rebobinar`, d, { messageID: t1.user.id, modo: "todo" })
      expect(hecho.status).toBe(200)
      expect(yield* json<any>(hecho)).toEqual({
        modo: "todo",
        restaurados: ["a.txt"],
        borrados: [],
        omitidos: [],
        mensajesOcultos: 2,
        puedeDeshacer: true,
      })
      expect(yield* leer(`${d}/a.txt`)).toBe("A0")

      const deshecho = yield* post(`${base}/rebobinar/deshacer`, d, {})
      expect(deshecho.status).toBe(200)
      expect(yield* json<any>(deshecho)).toEqual({ restaurados: ["a.txt"], borrados: [], omitidos: [], conflictos: [] })
      expect(yield* leer(`${d}/a.txt`)).toBe("A1")
    }),
    { git: true },
  )

  it.instance(
    "LAZUNOX_REBOBINAR=0: las rutas nuevas responden 404",
    conEntorno(
      { LAZUNOX_REBOBINAR: "0" },
      Effect.gen(function* () {
        const { directory: d } = yield* TestInstance
        const sessionID = (yield* Session.Service.use((s) => s.create({}))).id
        const base = `/experimental/session/${sessionID}`
        expect((yield* get(`${base}/turnos`, d)).status).toBe(404)
        expect((yield* get(`${base}/rebobinar/msg_x`, d)).status).toBe(404)
        expect((yield* post(`${base}/rebobinar`, d, { messageID: "msg_x", modo: "todo" })).status).toBe(404)
        expect((yield* post(`${base}/rebobinar/deshacer`, d, {})).status).toBe(404)
      }),
    ),
    { git: true },
  )
})

const get = (url: string, directory: string) => requestInDirectory(url, directory)
