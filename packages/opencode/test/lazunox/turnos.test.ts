// Lazunox R1: resumen por turno y puntos de control duraderos. Repo git temporal real; `git gc --prune=now` de verdad.
import { afterEach, describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, Layer } from "effect"
import { Session } from "../../src/session/session"
import { SessionSummary } from "../../src/session/summary"
import { SessionTurnos } from "../../src/session/turnos"
import { Snapshot } from "../../src/snapshot"
import { disposeAllInstances, TestInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { arbolExiste, conEntorno, escribir, gitSnap, turno } from "./rebobinar-util"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        Snapshot.node,
        FSUtil.node,
        Session.node,
        SessionSummary.node,
        SessionTurnos.node,
        SessionProjector.node,
        CrossSpawnSpawner.node,
      ]),
    ),
    testInstanceStoreLayer,
  ),
)

afterEach(async () => {
  await disposeAllInstances()
})

describe("turnos y puntos de control (R1)", () => {
  it.instance(
    "las refs de un turno sobreviven a git gc --prune=now (sin ellas el árbol se pierde)",
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const sessions = yield* Session.Service
      const sessionID = (yield* sessions.create({})).id
      yield* escribir(`${tmp.directory}/a.txt`, "A0")
      const t1 = yield* turno({ sessionID, dir: tmp.directory, mutar: escribir(`${tmp.directory}/a.txt`, "A1") })
      // Un turno «sin resumir» no tiene refs: su árbol cae con gc.
      const t2 = yield* turno({
        sessionID,
        dir: tmp.directory,
        mutar: escribir(`${tmp.directory}/a.txt`, "A2"),
        resumir: false,
      })
      // (el árbol del estado actual lo protege el índice del repo de instantáneas: se avanza un turno más)
      yield* turno({ sessionID, dir: tmp.directory, mutar: escribir(`${tmp.directory}/a.txt`, "A3"), resumir: false })
      yield* gitSnap("gc", "--prune=now")
      expect(yield* arbolExiste(t1.from)).toBe(true)
      expect(yield* arbolExiste(t1.to)).toBe(true)
      expect(yield* arbolExiste(t2.to)).toBe(false) // control: sin ref, gc se lo lleva
    }),
    { git: true },
  )

  it.instance(
    "tope: con LAZUNOX_CHECKPOINTS_MAX=3 el turno 4 borra las refs del más viejo",
    conEntorno(
      { LAZUNOX_CHECKPOINTS_MAX: "3" },
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const sessions = yield* Session.Service
        const sessionID = (yield* sessions.create({})).id
        yield* escribir(`${tmp.directory}/a.txt`, "A0")
        const hechos = []
        for (let i = 1; i <= 4; i++) {
          hechos.push(yield* turno({ sessionID, dir: tmp.directory, mutar: escribir(`${tmp.directory}/a.txt`, `A${i}`) }))
        }
        const refs = (yield* gitSnap("for-each-ref", "--format=%(refname)", `refs/lazunox/${sessionID}/`)).out
          .split("\n")
          .filter(Boolean)
        const turnosConRef = new Set(refs.map((ref) => ref.split("/")[3]))
        expect(turnosConRef.size).toBe(3)
        expect(turnosConRef.has(hechos[0]!.user.id)).toBe(false)
        expect(turnosConRef.has(hechos[3]!.user.id)).toBe(true)
        yield* gitSnap("gc", "--prune=now")
        expect(yield* arbolExiste(hechos[3]!.from)).toBe(true)
        // El turno más viejo ya no es restaurable y el servicio lo dice.
        const lista = yield* (yield* SessionTurnos.Service).listar({ sessionID })
        expect(lista.length).toBe(4)
        expect(lista[0]!.restaurable).toBe(false)
        expect(lista[0]!.motivo).toBe("caducado")
        expect(lista[3]!.restaurable).toBe(true)
      }),
    ),
    { git: true },
  )

  it.instance(
    "por defecto el tope es 100",
    Effect.sync(() => {
      expect(SessionTurnos.puntosMax({} as NodeJS.ProcessEnv)).toBe(100)
      expect(SessionTurnos.puntosMax({ LAZUNOX_CHECKPOINTS_MAX: "7" } as unknown as NodeJS.ProcessEnv)).toBe(7)
      expect(SessionTurnos.puntosMax({ LAZUNOX_CHECKPOINTS_MAX: "abc" } as unknown as NodeJS.ProcessEnv)).toBe(100)
      expect(SessionTurnos.activo({ LAZUNOX_REBOBINAR: "0" } as unknown as NodeJS.ProcessEnv)).toBe(false)
      expect(SessionTurnos.activo({} as NodeJS.ProcessEnv)).toBe(true)
    }),
    { git: true },
  )

  it.instance(
    "origen: herramienta (edit nombra el archivo), comando (bash en el turno) y otro",
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const sessions = yield* Session.Service
      const sessionID = (yield* sessions.create({})).id
      const d = tmp.directory
      yield* escribir(`${d}/a.txt`, "A0")
      yield* escribir(`${d}/c.txt`, "C0")
      // Turno 1: edit sobre a.txt + bash que crea b.txt.
      yield* turno({
        sessionID,
        dir: d,
        herramientas: [
          { tool: "edit", input: { filePath: `${d}/a.txt` } },
          { tool: "bash", input: { command: "echo x > b.txt" } },
        ],
        mutar: Effect.gen(function* () {
          yield* escribir(`${d}/a.txt`, "A1")
          yield* escribir(`${d}/b.txt`, "B1")
        }),
      })
      // Turno 2: ninguna herramienta; alguien más cambió c.txt.
      yield* turno({ sessionID, dir: d, mutar: escribir(`${d}/c.txt`, "C1") })
      // Turno 3: apply_patch nombra un archivo nuevo.
      yield* turno({
        sessionID,
        dir: d,
        herramientas: [
          { tool: "apply_patch", input: { patchText: "*** Begin Patch\n*** Add File: nuevo.txt\n+hola\n*** End Patch" } },
        ],
        mutar: escribir(`${d}/nuevo.txt`, "hola\n"),
      })
      const lista = yield* (yield* SessionTurnos.Service).listar({ sessionID })
      const origen = (i: number, file: string) => lista[i]!.files.find((item) => item.file === file)?.origen
      expect(origen(0, "a.txt")).toBe("herramienta")
      expect(origen(0, "b.txt")).toBe("comando")
      expect(origen(1, "c.txt")).toBe("otro")
      expect(origen(2, "nuevo.txt")).toBe("herramienta")
      expect(lista[0]!.files.find((item) => item.file === "a.txt")).toMatchObject({ status: "modified", additions: 1, deletions: 1 })
      expect(lista[0]!.files.find((item) => item.file === "b.txt")?.status).toBe("added")
      expect(lista.every((item) => item.restaurable)).toBe(true)
    }),
    { git: true },
  )

  it.instance(
    "más de 500 archivos en un turno: se devuelven 500 y truncated=true",
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const sessions = yield* Session.Service
      const sessionID = (yield* sessions.create({})).id
      yield* turno({
        sessionID,
        dir: tmp.directory,
        mutar: Effect.forEach(
          Array.from({ length: 510 }, (_, i) => i),
          (i) => escribir(`${tmp.directory}/lote/f${i}.txt`, `${i}`),
          { concurrency: 16 },
        ),
      })
      const lista = yield* (yield* SessionTurnos.Service).listar({ sessionID })
      expect(lista[0]!.files.length).toBe(500)
      expect(lista[0]!.truncated).toBe(true)
    }),
    { git: true },
  )

  it.instance(
    "carpeta sin git: restaurable=false, motivo sin-git",
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const sessionID = (yield* sessions.create({})).id
      // Sin git no hay instantáneas: el turno no tiene árboles, solo mensajes.
      const user = yield* sessions.updateMessage({
        id: (yield* Effect.promise(() => import("../../src/session/schema"))).MessageID.ascending(),
        role: "user" as const,
        sessionID,
        agent: "default",
        model: { providerID: "openai" as never, modelID: "gpt-4" as never },
        time: { created: Date.now() },
      })
      const lista = yield* (yield* SessionTurnos.Service).listar({ sessionID })
      expect(lista).toHaveLength(1)
      expect(lista[0]).toMatchObject({ messageID: user.id, files: [], truncated: false, restaurable: false, motivo: "sin-git" })
    }),
  )

  it.instance(
    "paginación con antesDe y diff de un archivo con contexto 3",
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const sessions = yield* Session.Service
      const sessionID = (yield* sessions.create({})).id
      const d = tmp.directory
      const lineas = Array.from({ length: 40 }, (_, i) => `linea ${i}`).join("\n") + "\n"
      yield* escribir(`${d}/g.txt`, lineas)
      const hechos = []
      hechos.push(yield* turno({ sessionID, dir: d, mutar: escribir(`${d}/g.txt`, lineas.replace("linea 20", "CAMBIO 20")) }))
      hechos.push(yield* turno({ sessionID, dir: d, mutar: escribir(`${d}/h.txt`, "x") }))
      hechos.push(yield* turno({ sessionID, dir: d, mutar: escribir(`${d}/i.txt`, "y") }))
      const svc = yield* SessionTurnos.Service
      const antes = yield* svc.listar({ sessionID, antesDe: hechos[2]!.user.id })
      expect(antes.map((item) => item.messageID)).toEqual([hechos[0]!.user.id, hechos[1]!.user.id])
      const uno = yield* svc.listar({ sessionID, limite: 1 })
      expect(uno.map((item) => item.messageID)).toEqual([hechos[2]!.user.id])
      const diff = yield* svc.diff({ sessionID, messageID: hechos[0]!.user.id, file: "g.txt" })
      expect(diff.patch).toContain("-linea 20")
      expect(diff.patch).toContain("+CAMBIO 20")
      expect(diff.patch).toContain(" linea 17") // 3 líneas de contexto
      expect(diff.patch).not.toContain("linea 5\n") // y no el archivo entero
      expect(diff.truncated).toBe(false)
      const fuera = yield* svc.diff({ sessionID, messageID: hechos[0]!.user.id, file: "h.txt" }).pipe(Effect.flip)
      expect(fuera._tag).toBe("TurnoNoEncontrado")
    }),
    { git: true },
  )

  it.instance(
    "borrar la sesión borra sus refs",
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const sessions = yield* Session.Service
      const sessionID = (yield* sessions.create({})).id
      yield* escribir(`${tmp.directory}/a.txt`, "A0")
      yield* turno({ sessionID, dir: tmp.directory, mutar: escribir(`${tmp.directory}/a.txt`, "A1") })
      const antes = (yield* gitSnap("for-each-ref", `refs/lazunox/${sessionID}/`)).out
      expect(antes.length).toBeGreaterThan(0)
      yield* sessions.remove(sessionID)
      const despues = (yield* gitSnap("for-each-ref", `refs/lazunox/${sessionID}/`)).out
      expect(despues).toBe("")
    }),
    { git: true },
  )
})
