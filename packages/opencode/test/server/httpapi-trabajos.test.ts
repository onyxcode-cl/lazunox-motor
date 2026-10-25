import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { Database } from "@opencode-ai/core/database/database"
import { ShellBackground, type Job } from "../../src/tool/shell/background"
import { TrabajosDisco } from "../../src/tool/shell/trabajos-disco"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

// Lazunox: rutas GET/POST /experimental/session/{sessionID}/trabajos (contrato motor-app, plan 1.7).
const it = testEffect(
  Layer.mergeAll(LayerNode.compile(LayerNode.group([Session.node, Database.node, BackgroundJob.node])), httpApiLayer),
)

const json = <T>(response: HttpClientResponse.HttpClientResponse) => response.json.pipe(Effect.map((v) => v as T))
type Vista = { id: string; tipo: string; titulo: string; estado: string; codigo: number | null; inicio: number; fin: number | null }

const get = (sessionID: string, directory: string) =>
  requestInDirectory(`/experimental/session/${sessionID}/trabajos`, directory)
const reanudar = (sessionID: string, id: string, directory: string) =>
  requestInDirectory(`/experimental/session/${sessionID}/trabajos/${id}/reanudar`, directory, { method: "POST" })
const terminar = (sessionID: string, id: string, directory: string) =>
  requestInDirectory(`/experimental/session/${sessionID}/trabajos/${id}/terminar`, directory, { method: "POST" })

const fakeShell = (over: Partial<Job> & Pick<Job, "id" | "sessionID" | "directory">): Job => {
  const job: Job = {
    command: "sleep 100",
    startedAt: Date.now(),
    file: "",
    written: 0,
    capped: false,
    readOffset: 0,
    running: true,
    code: null,
    finished: Promise.resolve(),
    kill: Effect.void,
    ...over,
  }
  job.kill = Effect.sync(() => {
    job.running = false
    job.reason = "terminated"
    job.finishedAt = Date.now()
  })
  return job
}

const created: string[] = []
afterEach(async () => {
  // Los falsos viven en el registro global del proceso: se sacan para no alterar el cupo de otras pruebas.
  for (const job of ShellBackground.all()) job.running = false // sin lápida al limpiar
  for (const job of ShellBackground.all()) await Effect.runPromise(ShellBackground.disposeDirectory(job.directory))
  for (const id of created.splice(0)) TrabajosDisco.removeMarker(id)
  await disposeAllInstances()
  await resetDatabase()
})

describe("rutas de trabajos", () => {
  it.instance("lista solo los trabajos de la sesión, con orden y tope de 50", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const base = Date.now() - 10_000_000
      for (let i = 0; i < 55; i++) {
        const id = `sh_t${i}x`
        created.push(id)
        ShellBackground.register(fakeShell({ id, sessionID: "ses_uno", directory, startedAt: base + i * 1000 }))
      }
      ShellBackground.register(fakeShell({ id: "sh_ajeno", sessionID: "ses_dos", directory }))
      yield* BackgroundJob.Service.use((jobs) =>
        jobs.start({ id: "cm_celda1", type: "code-mode", metadata: { sessionID: "ses_dos", titulo: "Code Mode: x" }, run: Effect.never }),
      )

      const res = yield* get("ses_uno", directory)
      expect(res.status).toBe(200)
      const { trabajos } = yield* json<{ trabajos: Vista[] }>(res)
      expect(trabajos.length).toBe(50)
      expect(trabajos[0]!.id).toBe("sh_t54x")
      expect(trabajos.map((t) => t.inicio)).toEqual(trabajos.map((t) => t.inicio).toSorted((a, b) => b - a))
      expect(trabajos.every((t) => t.tipo === "shell" && t.estado === "en_curso" && t.codigo === null && t.fin === null)).toBe(true)
      expect(trabajos.find((t) => t.id === "sh_ajeno")).toBeUndefined()

      const dos = yield* json<{ trabajos: Vista[] }>(yield* get("ses_dos", directory))
      expect(dos.trabajos.map((t) => t.id).toSorted()).toEqual(["cm_celda1", "sh_ajeno"])
      const celda = dos.trabajos.find((t) => t.id === "cm_celda1")!
      expect(celda).toMatchObject({ tipo: "celda", estado: "en_curso", titulo: "Code Mode: x" })
    }),
  )

  it.instance("terminar: válido, ajeno, inexistente y repetido", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      created.push("sh_mio1", "sh_otro1")
      ShellBackground.register(fakeShell({ id: "sh_mio1", sessionID: "ses_uno", directory }))
      ShellBackground.register(fakeShell({ id: "sh_otro1", sessionID: "ses_dos", directory }))
      yield* BackgroundJob.Service.use((jobs) =>
        jobs.start({ id: "cm_mia1", type: "code-mode", metadata: { sessionID: "ses_uno" }, run: Effect.never }),
      )

      expect(yield* json(yield* terminar("ses_uno", "sh_otro1", directory))).toEqual({ ok: false })
      expect(ShellBackground.get("sh_otro1")!.running).toBe(true)
      expect(yield* json(yield* terminar("ses_uno", "sh_noexiste", directory))).toEqual({ ok: false })
      expect(yield* json(yield* terminar("ses_uno", "cm_noexiste", directory))).toEqual({ ok: false })

      expect(yield* json(yield* terminar("ses_uno", "sh_mio1", directory))).toEqual({ ok: true })
      expect(yield* json(yield* terminar("ses_uno", "sh_mio1", directory))).toEqual({ ok: false })
      expect(yield* json(yield* terminar("ses_uno", "cm_mia1", directory))).toEqual({ ok: true })
      expect(yield* json(yield* terminar("ses_uno", "cm_mia1", directory))).toEqual({ ok: false })

      const { trabajos } = yield* json<{ trabajos: Vista[] }>(yield* get("ses_uno", directory))
      expect(trabajos.find((t) => t.id === "sh_mio1")).toMatchObject({ estado: "terminado_por_ti" })
      expect(trabajos.find((t) => t.id === "cm_mia1")).toMatchObject({ estado: "terminado_por_ti" })
    }),
  )

  it.instance("los trabajos perdidos tras un reinicio salen como «perdido» solo para su sesión", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      TrabajosDisco.writeTombstone({ id: "sh_perdidoA", tipo: "shell", sessionID: "ses_uno", directory, titulo: "npm run dev", inicio: 5 })
      created.push("sh_perdidoA")
      const mio = yield* json<{ trabajos: Vista[] }>(yield* get("ses_uno", directory))
      expect(mio.trabajos.find((t) => t.id === "sh_perdidoA")).toMatchObject({ estado: "perdido", tipo: "shell", titulo: "npm run dev" })
      const otro = yield* json<{ trabajos: Vista[] }>(yield* get("ses_dos", directory))
      expect(otro.trabajos.find((t) => t.id === "sh_perdidoA")).toBeUndefined()
      TrabajosDisco.pruneTombstones(Date.now() + TrabajosDisco.LAPIDA_TTL_MS + 1)
    }),
  )
  it.instance("un ayudante perdido sale como tipo «ayudante»; reanudar exige pertenencia a la sesión (lápida ajena o forjada: no_existe)", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const sessions = yield* Session.Service
      const padre = yield* sessions.create({ title: "padre" })
      const otra = yield* sessions.create({ title: "otra" })
      const hija = yield* sessions.create({ parentID: padre.id, title: "hija" })
      created.push(hija.id)
      TrabajosDisco.writeTombstone({ id: hija.id, tipo: "ayudante", sessionID: padre.id, directory, titulo: "hija", inicio: 7 })

      const mio = yield* json<{ trabajos: Vista[] }>(yield* get(padre.id, directory))
      expect(mio.trabajos.find((t) => t.id === hija.id)).toMatchObject({ tipo: "ayudante", estado: "perdido", titulo: "hija" })
      const ajeno = yield* json<{ trabajos: Vista[] }>(yield* get(otra.id, directory))
      expect(ajeno.trabajos.find((t) => t.id === hija.id)).toBeUndefined()

      expect(yield* json(yield* reanudar(otra.id, hija.id, directory))).toEqual({ ok: false, motivo: "no_existe" })
      expect(yield* json(yield* reanudar(padre.id, "ses_noexiste", directory))).toEqual({ ok: false, motivo: "no_existe" })
      expect(yield* json(yield* reanudar(padre.id, "sh_perdidoX", directory))).toEqual({ ok: false, motivo: "no_existe" })
      // lápida forjada para la sesión «otra» con una hija que cuelga de «padre»
      TrabajosDisco.writeTombstone({ id: hija.id, tipo: "ayudante", sessionID: otra.id, directory, titulo: "forjada", inicio: 7 })
      expect(yield* json(yield* reanudar(otra.id, hija.id, directory))).toEqual({ ok: false, motivo: "no_existe" })
      TrabajosDisco.removeTombstone(hija.id)
    }),
  )
})
