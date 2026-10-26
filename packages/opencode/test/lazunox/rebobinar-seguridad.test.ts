// Lazunox: regresiones de la revisión de seguridad de la ola 2B (rebobinar/deshacer fallan CERRADO, segundo rebobinado, refs, candado).
// Repositorio git temporal REAL, instantáneas reales, mensajes reales; nada de git simulado.
import { afterEach, describe, expect } from "bun:test"
import { $ } from "bun"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { Storage } from "../../src/storage/storage"
import { BackgroundJob } from "../../src/background/job"
import { McpElicitation } from "../../src/mcp/elicitation"
import { Permission } from "../../src/permission"
import { Question } from "../../src/question"
import { SessionRebobinar } from "../../src/session/rebobinar"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, type SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { SessionSummary } from "../../src/session/summary"
import { SessionTurnos } from "../../src/session/turnos"
import { Snapshot } from "../../src/snapshot"
import { ShellBackground, type Job } from "../../src/tool/shell/background"
import { disposeAllInstances, TestInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { arbolExiste, conEntorno, escribir, existe, gitSnap, gitdirSnap, leer, turno } from "./rebobinar-util"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        Snapshot.node,
        Storage.node,
        FSUtil.node,
        Session.node,
        SessionSummary.node,
        SessionTurnos.node,
        SessionRevert.node,
        SessionRebobinar.node,
        SessionRunState.node,
        SessionProjector.node,
        BackgroundJob.node,
        Permission.node,
        Question.node,
        McpElicitation.node,
        CrossSpawnSpawner.node,
      ]),
    ),
    testInstanceStoreLayer,
  ),
)

const creados: string[] = []
afterEach(async () => {
  for (const job of ShellBackground.all()) job.running = false
  for (const job of ShellBackground.all()) await Effect.runPromise(ShellBackground.disposeDirectory(job.directory))
  await disposeAllInstances()
  for (const dir of creados.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

const nuevaSesion = Effect.gen(function* () {
  return (yield* Session.Service.use((s) => s.create({}))).id
})

/** Dos turnos: T1 cambia a.txt y crea n.txt (con comando); T2 cambia b.txt. */
const dosTurnos = Effect.fn("dosTurnos")(function* (resumir = true) {
  const tmp = yield* TestInstance
  const d = tmp.directory
  const sessionID = yield* nuevaSesion
  yield* escribir(`${d}/a.txt`, "A0")
  yield* escribir(`${d}/b.txt`, "B0")
  const t1 = yield* turno({
    sessionID,
    dir: d,
    resumir,
    herramientas: [
      { tool: "edit", input: { filePath: `${d}/a.txt` } },
      { tool: "bash", input: { command: "echo hola > n.txt" } },
    ],
    mutar: Effect.gen(function* () {
      yield* escribir(`${d}/a.txt`, "A1")
      yield* escribir(`${d}/n.txt`, "N1")
    }),
  })
  const t2 = yield* turno({
    sessionID,
    dir: d,
    resumir,
    herramientas: [{ tool: "edit", input: { filePath: `${d}/b.txt` } }],
    mutar: escribir(`${d}/b.txt`, "B1"),
  })
  return { d, sessionID, t1, t2 }
})


const reb = SessionRebobinar.Service
const refsRevert = (sessionID: SessionID) =>
  gitSnap("for-each-ref", "--format=%(refname) %(objectname)", `refs/lazunox/${sessionID}/revert/`).pipe(
    Effect.map((r) => r.out.split("\n").filter(Boolean)),
  )
const borrarRefsQue = (sessionID: SessionID, quiero: (ref: string, tree: string) => boolean) =>
  Effect.gen(function* () {
    const todas = yield* gitSnap("for-each-ref", "--format=%(refname) %(objectname)", `refs/lazunox/${sessionID}/`)
    for (const linea of todas.out.split("\n").filter(Boolean)) {
      const [ref, tree] = linea.split(" ")
      if (ref && tree && quiero(ref, tree)) yield* gitSnap("update-ref", "-d", ref)
    }
  })

describe("A: deshacer falla CERRADO", () => {
  it.instance(
    "si el árbol de «después» caducó, deshacer da 409 caducado y NO pisa lo que la persona editó",
    Effect.gen(function* () {
      const { d, sessionID, t1 } = yield* dosTurnos(true)
      yield* escribir(`${d}/otro.txt`, "otro0") // estado único: sus árboles no coinciden con los de ningún turno
      yield* (yield* reb).rebobinar({ sessionID, messageID: t1.user.id, modo: "codigo" })
      expect(yield* leer(`${d}/a.txt`)).toBe("A0")
      // Las refs de rebobinar existen mientras se pueda deshacer.
      expect((yield* refsRevert(sessionID)).map((l) => l.split(" ")[0]?.split("/").pop()).toSorted()).toEqual([
        "after",
        "snapshot",
      ])
      yield* escribir(`${d}/a.txt`, "A-persona")
      yield* (yield* Snapshot.Service).track() // que el índice ya no proteja el árbol de «después»
      // Simula la poda: sin la ref, gc se lleva el árbol de «después».
      yield* borrarRefsQue(sessionID, (ref) => ref.endsWith("/revert/after"))
      yield* gitSnap("gc", "--prune=now")
      const error = yield* (yield* reb).deshacer({ sessionID }).pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "SnapshotExpiredError" })
      expect(yield* leer(`${d}/a.txt`)).toBe("A-persona")
    }),
    { git: true },
  )

  it.instance(
    "las refs del rebobinado se sueltan al deshacer",
    Effect.gen(function* () {
      const { sessionID, t1 } = yield* dosTurnos(true)
      yield* (yield* reb).rebobinar({ sessionID, messageID: t1.user.id, modo: "codigo" })
      expect((yield* refsRevert(sessionID)).length).toBe(2)
      yield* (yield* reb).deshacer({ sessionID })
      expect(yield* refsRevert(sessionID)).toEqual([])
    }),
    { git: true },
  )

  it.instance(
    "patchEstricto: un árbol inexistente FALLA (patch devuelve files vacío)",
    Effect.gen(function* () {
      yield* dosTurnos(true)
      const snap = yield* Snapshot.Service
      const falso = "0123456789abcdef0123456789abcdef01234567"
      expect((yield* snap.patch(falso)).files).toEqual([])
      const error = yield* snap.patchEstricto(falso).pipe(Effect.flip)
      expect(error._tag).toBe("SnapshotExpiredError")
      const ahora = yield* snap.track()
      expect((yield* snap.patchEstricto(ahora!)).files).toEqual([])
    }),
    { git: true },
  )
})

describe("C: segundo rebobinado con un revert pendiente", () => {
  it.instance(
    "lo que la persona editó después del primero se respeta (conflicto), no se restaura a ciegas",
    Effect.gen(function* () {
      const { d, sessionID, t1, t2 } = yield* dosTurnos(true)
      yield* (yield* reb).rebobinar({ sessionID, messageID: t2.user.id, modo: "todo" })
      expect(yield* leer(`${d}/b.txt`)).toBe("B0")
      yield* escribir(`${d}/b.txt`, "B-persona")
      const r = yield* (yield* reb).rebobinar({ sessionID, messageID: t1.user.id, modo: "todo" })
      expect(yield* leer(`${d}/b.txt`)).toBe("B-persona")
      expect(r.omitidos.filter((o) => o.file === "b.txt")).toEqual([{ file: "b.txt", motivo: "conflicto" }])
      expect(yield* leer(`${d}/a.txt`)).toBe("A0")
      expect(yield* existe(`${d}/n.txt`)).toBe(false)
      // Con «sobrescribir» sí se pisa.
      yield* (yield* reb).deshacer({ sessionID, sobrescribir: ["b.txt"] })
      expect(yield* leer(`${d}/b.txt`)).toBe("B1")
    }),
    { git: true },
  )

  it.instance(
    "si falta un árbol del segundo rebobinado, falla ANTES de restaurar nada",
    Effect.gen(function* () {
      const { d, sessionID, t1, t2 } = yield* dosTurnos(true)
      yield* (yield* reb).rebobinar({ sessionID, messageID: t2.user.id, modo: "todo" })
      expect(yield* leer(`${d}/b.txt`)).toBe("B0")
      yield* borrarRefsQue(sessionID, (_ref, tree) => tree === t1.from)
      yield* gitSnap("gc", "--prune=now")
      expect(yield* arbolExiste(t1.from)).toBe(false)
      const revert = yield* SessionRevert.Service
      const error = yield* revert.revertir({ sessionID, messageID: t1.user.id }).pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "SnapshotExpiredError" })
      // El restaurado previo (b.txt -> B1) NO se aplicó.
      expect(yield* leer(`${d}/b.txt`)).toBe("B0")
    }),
    { git: true },
  )
})

describe("G: candado por sesión", () => {
  it.instance(
    "dos rebobinados simultáneos de la misma sesión terminan en un estado coherente",
    Effect.gen(function* () {
      const { d, sessionID, t2 } = yield* dosTurnos(true)
      const svc = yield* reb
      const pedir = svc.rebobinar({ sessionID, messageID: t2.user.id, modo: "todo" })
      yield* Effect.all([pedir, pedir], { concurrency: 2 })
      expect(yield* leer(`${d}/b.txt`)).toBe("B0")
      expect(yield* leer(`${d}/a.txt`)).toBe("A1")
      yield* svc.deshacer({ sessionID })
      expect(yield* leer(`${d}/b.txt`)).toBe("B1")
    }),
    { git: true },
  )
})

/** Dos turnos que tocan AMBOS b.txt: T1 deja a=A1,b=B1; T2 deja b=B2 (el repro del verificador). */
const dosTurnosConB = Effect.fn("dosTurnosConB")(function* () {
  const tmp = yield* TestInstance
  const d = tmp.directory
  const sessionID = yield* nuevaSesion
  yield* escribir(`${d}/a.txt`, "A0")
  yield* escribir(`${d}/b.txt`, "B0")
  const t1 = yield* turno({
    sessionID,
    dir: d,
    herramientas: [{ tool: "edit", input: { filePath: `${d}/b.txt` } }],
    mutar: Effect.gen(function* () {
      yield* escribir(`${d}/a.txt`, "A1")
      yield* escribir(`${d}/b.txt`, "B1")
    }),
  })
  const t2 = yield* turno({
    sessionID,
    dir: d,
    herramientas: [{ tool: "edit", input: { filePath: `${d}/b.txt` } }],
    mutar: escribir(`${d}/b.txt`, "B2"),
  })
  return { d, sessionID, t1, t2 }
})

describe("C (ola 2C): el archivo omitido por conflicto no se restaura por la puerta de atrás", () => {
  it.instance(
    "ruta normal (revertir sin opciones): lo que la persona escribió tras el primer revert se respeta y el informe no se contradice",
    Effect.gen(function* () {
      const { d, sessionID, t1, t2 } = yield* dosTurnosConB()
      const revert = yield* SessionRevert.Service
      yield* revert.revertir({ sessionID, messageID: t2.user.id })
      expect(yield* leer(`${d}/b.txt`)).toBe("B1")
      yield* escribir(`${d}/b.txt`, "B-persona")
      const r = yield* revert.revertir({ sessionID, messageID: t1.user.id })
      expect(yield* leer(`${d}/b.txt`)).toBe("B-persona")
      expect(r.omitidos.filter((o) => o.file === "b.txt")).toEqual([{ file: "b.txt", motivo: "conflicto" }])
      expect(r.restaurados).not.toContain("b.txt")
      expect(yield* leer(`${d}/a.txt`)).toBe("A0")
    }),
    { git: true },
  )
})

describe("A (ola 2C): sin punto de control no se aplica nada", () => {
  it.instance(
    "si git no puede guardar el estado actual, revertir falla (caducado) ANTES de tocar archivos",
    Effect.gen(function* () {
      const { d, sessionID, t2 } = yield* dosTurnosConB()
      const gitdir = yield* gitdirSnap
      // Índice corrupto: `git write-tree` falla y track() no devuelve ningún árbol.
      yield* Effect.promise(() => fs.writeFile(path.join(gitdir, "index"), "basura"))
      const revert = yield* SessionRevert.Service
      const error = yield* revert.revertir({ sessionID, messageID: t2.user.id }).pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "SnapshotExpiredError" })
      expect(yield* leer(`${d}/b.txt`)).toBe("B2")
      expect((yield* (yield* Session.Service).get(sessionID)).revert).toBeUndefined()
    }),
    { git: true },
  )

  it.instance(
    "si el registro del revert perdió el árbol de «después», deshacer falla CERRADO y no pisa lo que la persona editó",
    Effect.gen(function* () {
      const { d, sessionID, t1 } = yield* dosTurnos(true)
      yield* (yield* reb).rebobinar({ sessionID, messageID: t1.user.id, modo: "codigo" })
      const storage = yield* Storage.Service
      const clave = ["lazunox_revert", sessionID]
      const registro = yield* storage.read<{ files: string[]; after?: string; snapshot?: string }>(clave)
      yield* storage.write(clave, { files: registro.files, snapshot: registro.snapshot })
      yield* escribir(`${d}/a.txt`, "A-persona")
      const error = yield* (yield* reb).deshacer({ sessionID }).pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "SnapshotExpiredError" })
      expect(yield* leer(`${d}/a.txt`)).toBe("A-persona")
    }),
    { git: true },
  )
})

describe("G (ola 2C): el candado por sesión cubre revert/unrevert", () => {
  it.instance(
    "revertir por la ruta normal espera a quien tiene el candado, y se libera si el dueño se interrumpe",
    Effect.gen(function* () {
      const { d, sessionID, t2 } = yield* dosTurnosConB()
      const revert = yield* SessionRevert.Service
      const puerta = yield* Deferred.make<void>()
      const dueno = yield* Effect.forkScoped(revert.conCandado(sessionID, Deferred.await(puerta)))
      yield* Effect.sleep("50 millis")
      const pedido = yield* Effect.forkScoped(revert.revertir({ sessionID, messageID: t2.user.id }))
      yield* Effect.sleep("300 millis")
      expect(yield* leer(`${d}/b.txt`)).toBe("B2") // aún no corrió: el candado está tomado
      yield* Deferred.succeed(puerta, undefined)
      yield* Fiber.join(dueno)
      yield* Fiber.join(pedido)
      expect(yield* leer(`${d}/b.txt`)).toBe("B1")
      // Interrupción: el dueño muere con el candado puesto y el siguiente no se queda colgado.
      const colgado = yield* Effect.forkScoped(revert.conCandado(sessionID, Effect.never))
      yield* Effect.sleep("50 millis")
      yield* Fiber.interrupt(colgado)
      yield* revert.deshacer({ sessionID })
      expect(yield* leer(`${d}/b.txt`)).toBe("B2")
    }),
    { git: true },
  )

  it.instance(
    "rebobinar y deshacer reutilizan el candado sin pedirlo otra vez (no hay bloqueo mutuo)",
    Effect.gen(function* () {
      const { d, sessionID, t2 } = yield* dosTurnosConB()
      yield* (yield* reb).rebobinar({ sessionID, messageID: t2.user.id, modo: "todo" })
      expect(yield* leer(`${d}/b.txt`)).toBe("B1")
      yield* (yield* reb).deshacer({ sessionID })
      expect(yield* leer(`${d}/b.txt`)).toBe("B2")
    }),
    { git: true },
  )
})
