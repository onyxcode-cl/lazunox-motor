// Lazunox R2: rebobinar por turno (tres modos, revisión previa, conflictos, protegidos, 409, deshacer).
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
import { Effect, Layer } from "effect"
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
import { arbolExiste, conEntorno, escribir, existe, gitSnap, leer, turno } from "./rebobinar-util"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        Snapshot.node,
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
const sesionInfo = (sessionID: SessionID) => Session.Service.use((s) => s.get(sessionID))

describe("revisión previa (GET rebobinar/{messageID})", () => {
  it.instance(
    "lista los archivos, el origen, comandos y que es restaurable",
    Effect.gen(function* () {
      const { d, sessionID, t1 } = yield* dosTurnos()
      const r = yield* (yield* reb).revision({ sessionID, messageID: t1.user.id })
      expect(r.restaurable).toBe(true)
      expect(r.motivo).toBeUndefined()
      expect(r.bloqueado).toBeUndefined()
      expect(r.archivos.map((a) => a.file).toSorted()).toEqual(["a.txt", "b.txt", "n.txt"])
      expect(r.archivos.find((a) => a.file === "n.txt")).toMatchObject({ status: "added", origen: "comando" })
      expect(r.archivos.find((a) => a.file === "a.txt")).toMatchObject({ status: "modified", origen: "herramienta" })
      expect(r.comandos).toBe(true)
      expect(r.conflictos).toEqual([])
      expect(r.protegidos).toEqual([])
      expect(r.mensajes).toBe(4)
      // La revisión es de solo lectura: no cambió nada.
      expect(yield* leer(`${d}/a.txt`)).toBe("A1")
      expect((yield* sesionInfo(sessionID)).revert).toBeUndefined()
    }),
    { git: true },
  )

  it.instance(
    "un mensaje que no es de la persona da Invalido; uno inexistente, NoEncontrado",
    Effect.gen(function* () {
      const { sessionID, t1 } = yield* dosTurnos()
      const svc = yield* reb
      const malo = yield* svc.revision({ sessionID, messageID: t1.assistant.id }).pipe(Effect.flip)
      expect(malo._tag).toBe("RebobinarInvalido")
      const noExiste = yield* svc.revision({ sessionID, messageID: MessageID.make("msg_noexiste") }).pipe(Effect.flip)
      expect(noExiste._tag).toBe("TurnoNoEncontrado")
    }),
    { git: true },
  )

  it.instance(
    "conflicto: lo que la persona cambió DESPUÉS del último paso; protegido: .mcp.json",
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const d = tmp.directory
      const sessionID = yield* nuevaSesion
      yield* escribir(`${d}/a.txt`, "A0")
      const t1 = yield* turno({
        sessionID,
        dir: d,
        mutar: Effect.gen(function* () {
          yield* escribir(`${d}/a.txt`, "A1")
          yield* escribir(`${d}/.mcp.json`, "{}")
        }),
      })
      yield* escribir(`${d}/a.txt`, "A-persona")
      const r = yield* (yield* reb).revision({ sessionID, messageID: t1.user.id })
      expect(r.conflictos).toEqual(["a.txt"])
      expect(r.protegidos).toEqual([".mcp.json"])
      expect(r.archivos.map((a) => a.file).toSorted()).toEqual([".mcp.json", "a.txt"])
    }),
    { git: true },
  )

  it.instance(
    "commitsDespues: avisa de los commits hechos desde el inicio del turno (solo lectura)",
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const d = tmp.directory
      const sessionID = yield* nuevaSesion
      yield* escribir(`${d}/a.txt`, "A0")
      const t1 = yield* turno({ sessionID, dir: d, creado: Date.now() - 10_000, mutar: escribir(`${d}/a.txt`, "A1") })
      yield* Effect.promise(async () => {
        await $`git add -A && git commit -m "mi commit de persona"`.cwd(d).quiet()
      })
      const r = yield* (yield* reb).revision({ sessionID, messageID: t1.user.id })
      expect(r.commitsDespues.length).toBeGreaterThanOrEqual(1)
      expect(r.commitsDespues.map((c) => c.asunto)).toContain("mi commit de persona")
      expect(r.commitsDespues[0]!.hash).toHaveLength(12)
      // y rebobinar NO toca el historial del repo de la persona
      const antes = yield* Effect.promise(async () => (await $`git rev-parse HEAD`.cwd(d).text()).trim())
      yield* (yield* reb).rebobinar({ sessionID, messageID: t1.user.id, modo: "todo" })
      const despues = yield* Effect.promise(async () => (await $`git rev-parse HEAD`.cwd(d).text()).trim())
      expect(despues).toBe(antes)
    }),
    { git: true },
  )
})

describe("tres modos (POST rebobinar)", () => {
  it.instance(
    "todo: restaura archivos (y borra los creados) y oculta los mensajes",
    Effect.gen(function* () {
      const { d, sessionID, t1 } = yield* dosTurnos()
      const r = yield* (yield* reb).rebobinar({ sessionID, messageID: t1.user.id, modo: "todo" })
      expect(r.modo).toBe("todo")
      expect(yield* leer(`${d}/a.txt`)).toBe("A0")
      expect(yield* leer(`${d}/b.txt`)).toBe("B0")
      expect(yield* existe(`${d}/n.txt`)).toBe(false)
      expect(r.restaurados.toSorted()).toEqual(["a.txt", "b.txt"])
      expect(r.borrados).toEqual(["n.txt"])
      expect(r.omitidos).toEqual([])
      expect(r.mensajesOcultos).toBe(4)
      expect(r.puedeDeshacer).toBe(true)
      expect((yield* sesionInfo(sessionID)).revert?.messageID).toBe(t1.user.id)
    }),
    { git: true },
  )

  it.instance(
    "conversacion: oculta mensajes y NO toca ningún archivo",
    Effect.gen(function* () {
      const { d, sessionID, t1 } = yield* dosTurnos()
      const r = yield* (yield* reb).rebobinar({ sessionID, messageID: t1.user.id, modo: "conversacion" })
      expect(r.restaurados).toEqual([])
      expect(r.borrados).toEqual([])
      expect(yield* leer(`${d}/a.txt`)).toBe("A1")
      expect(yield* leer(`${d}/n.txt`)).toBe("N1")
      expect((yield* sesionInfo(sessionID)).revert?.messageID).toBe(t1.user.id)
      // Deshacer una «solo conversación» tampoco toca archivos (aunque la persona haya editado mientras).
      yield* escribir(`${d}/a.txt`, "A-persona")
      const u = yield* (yield* reb).deshacer({ sessionID })
      expect(u.restaurados).toEqual([])
      expect(yield* leer(`${d}/a.txt`)).toBe("A-persona")
      expect((yield* sesionInfo(sessionID)).revert).toBeUndefined()
    }),
    { git: true },
  )

  it.instance(
    "codigo: restaura archivos, deja los mensajes y deja UNA nota para el modelo; deshacer la quita",
    Effect.gen(function* () {
      const { d, sessionID, t1 } = yield* dosTurnos()
      const r = yield* (yield* reb).rebobinar({ sessionID, messageID: t1.user.id, modo: "codigo" })
      expect(yield* leer(`${d}/a.txt`)).toBe("A0")
      expect(yield* existe(`${d}/n.txt`)).toBe(false)
      expect(r.mensajesOcultos).toBe(0)
      const info = yield* sesionInfo(sessionID)
      expect(info.revert).toBeUndefined() // los mensajes siguen
      const mensajes = yield* Session.Service.use((s) => s.messages({ sessionID }))
      expect(mensajes.length).toBe(4)
      // La nota se entrega una sola vez.
      const revert = yield* SessionRevert.Service
      const nota = yield* revert.consumirNota(sessionID)
      expect(nota).toContain("antes del turno 1")
      expect(nota).toContain("a.txt")
      expect(nota).toContain("n.txt")
      expect(yield* revert.consumirNota(sessionID)).toBeUndefined()

      // Deshacer deja todo como estaba tras los dos turnos.
      yield* revert.guardarNota(sessionID, "otra nota")
      const u = yield* (yield* reb).deshacer({ sessionID })
      expect(yield* leer(`${d}/a.txt`)).toBe("A1")
      expect(yield* leer(`${d}/n.txt`)).toBe("N1")
      expect(yield* leer(`${d}/b.txt`)).toBe("B1")
      expect(u.conflictos).toEqual([])
      expect(yield* revert.consumirNota(sessionID)).toBeUndefined() // ya no aplica
      // Y ya no hay nada más que deshacer.
      const otra = yield* (yield* reb).deshacer({ sessionID }).pipe(Effect.flip)
      expect(otra).toMatchObject({ _tag: "RebobinarConflictoInterno", motivo: "nada-que-deshacer" })
    }),
    { git: true },
  )

  it.instance(
    "un conflicto se salta salvo que venga en sobrescribir",
    Effect.gen(function* () {
      const { d, sessionID, t1 } = yield* dosTurnos()
      yield* escribir(`${d}/a.txt`, "A-persona")
      const r = yield* (yield* reb).rebobinar({ sessionID, messageID: t1.user.id, modo: "codigo" })
      expect(yield* leer(`${d}/a.txt`)).toBe("A-persona") // respetado
      expect(r.omitidos).toEqual([{ file: "a.txt", motivo: "conflicto" }])
      expect(yield* leer(`${d}/b.txt`)).toBe("B0") // el resto sí se restauró
      yield* (yield* reb).deshacer({ sessionID })

      const r2 = yield* (yield* reb).rebobinar({
        sessionID,
        messageID: t1.user.id,
        modo: "codigo",
        sobrescribir: ["a.txt"],
      })
      expect(r2.omitidos).toEqual([])
      expect(yield* leer(`${d}/a.txt`)).toBe("A0")
    }),
    { git: true },
  )

  it.instance(
    "una ruta protegida (.mcp.json) se salta salvo que venga en sobrescribir",
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const d = tmp.directory
      const sessionID = yield* nuevaSesion
      yield* escribir(`${d}/a.txt`, "A0")
      const t1 = yield* turno({
        sessionID,
        dir: d,
        mutar: Effect.gen(function* () {
          yield* escribir(`${d}/a.txt`, "A1")
          yield* escribir(`${d}/.mcp.json`, '{"mcpServers":{}}')
        }),
      })
      const r = yield* (yield* reb).rebobinar({ sessionID, messageID: t1.user.id, modo: "todo" })
      expect(yield* leer(`${d}/a.txt`)).toBe("A0")
      expect(yield* existe(`${d}/.mcp.json`)).toBe(true) // NO se borró
      expect(r.omitidos).toEqual([{ file: ".mcp.json", motivo: "protegido" }])
      yield* (yield* reb).deshacer({ sessionID })
      const r2 = yield* (yield* reb).rebobinar({
        sessionID,
        messageID: t1.user.id,
        modo: "todo",
        sobrescribir: [".mcp.json"],
      })
      expect(r2.omitidos).toEqual([])
      expect(yield* existe(`${d}/.mcp.json`)).toBe(false)
    }),
    { git: true },
  )

  it.instance(
    "enlace simbólico a otra carpeta: no se borra nada fuera del proyecto",
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const d = tmp.directory
      const sessionID = yield* nuevaSesion
      const fuera = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "lzx-fuera-")))
      creados.push(fuera)
      yield* escribir(`${fuera}/f.txt`, "NO TOCAR")
      yield* escribir(`${d}/a.txt`, "A0")
      // El turno crea sub/f.txt; después `sub` pasa a ser un enlace a una carpeta ajena que tiene su propio f.txt.
      const t1 = yield* turno({ sessionID, dir: d, mutar: escribir(`${d}/sub/f.txt`, "mio") })
      yield* Effect.promise(async () => {
        await fs.rm(`${d}/sub`, { recursive: true, force: true })
        await fs.symlink(fuera, `${d}/sub`)
      })
      const r = yield* (yield* reb).rebobinar({ sessionID, messageID: t1.user.id, modo: "todo" })
      expect(yield* leer(`${fuera}/f.txt`)).toBe("NO TOCAR")
      expect(r.omitidos.map((o) => o.motivo)).toContain("enlace-simbolico")
    }),
    { git: true },
  )

  it.instance(
    "punto caducado (árbol podado por gc): 409 caducado, no se toca nada; «solo conversación» sigue disponible",
    Effect.gen(function* () {
      const { d, sessionID, t1 } = yield* dosTurnos(false) // sin resumir = sin refs duraderas
      // Un turno más para que el índice no proteja el árbol actual.
      yield* turno({ sessionID, dir: d, resumir: false, mutar: escribir(`${d}/c.txt`, "C1") })
      yield* gitSnap("gc", "--prune=now")
      expect(yield* arbolExiste(t1.from)).toBe(false)
      const svc = yield* reb
      const r = yield* svc.revision({ sessionID, messageID: t1.user.id })
      expect(r).toMatchObject({ restaurable: false, motivo: "caducado" })
      const error = yield* svc.rebobinar({ sessionID, messageID: t1.user.id, modo: "todo" }).pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "RebobinarConflictoInterno", motivo: "caducado" })
      expect(yield* leer(`${d}/a.txt`)).toBe("A1")
      expect(yield* existe(`${d}/n.txt`)).toBe(true)
      const conv = yield* svc.rebobinar({ sessionID, messageID: t1.user.id, modo: "conversacion" })
      expect(conv.modo).toBe("conversacion")
    }),
    { git: true },
  )

  it.instance(
    "con refs duraderas, un turno de «hace 8 días» sigue siendo restaurable tras gc --prune=now",
    Effect.gen(function* () {
      const { d, sessionID, t1 } = yield* dosTurnos(true)
      yield* turno({ sessionID, dir: d, resumir: false, mutar: escribir(`${d}/c.txt`, "C1") })
      yield* gitSnap("gc", "--prune=now")
      expect(yield* arbolExiste(t1.from)).toBe(true)
      const r = yield* (yield* reb).rebobinar({ sessionID, messageID: t1.user.id, modo: "codigo" })
      expect(r.omitidos).toEqual([])
      expect(yield* leer(`${d}/a.txt`)).toBe("A0")
    }),
    { git: true },
  )

  it.instance(
    "carpeta sin git: solo «conversacion»; todo y codigo dan 409 sin-git",
    Effect.gen(function* () {
      const sessionID = yield* nuevaSesion
      const sessions = yield* Session.Service
      const user = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user" as const,
        sessionID,
        agent: "default",
        model: { providerID: "openai" as never, modelID: "gpt-4" as never },
        time: { created: Date.now() },
      })
      const svc = yield* reb
      const r = yield* svc.revision({ sessionID, messageID: user.id })
      expect(r).toMatchObject({ restaurable: false, motivo: "sin-git" })
      const e = yield* svc.rebobinar({ sessionID, messageID: user.id, modo: "todo" }).pipe(Effect.flip)
      expect(e).toMatchObject({ motivo: "sin-git" })
      const ok = yield* svc.rebobinar({ sessionID, messageID: user.id, modo: "conversacion" })
      expect(ok.modo).toBe("conversacion")
    }),
  )
})

describe("deshacer (POST rebobinar/deshacer)", () => {
  it.instance(
    "vuelve solo a los archivos tocados: lo que la persona cambió después se respeta",
    Effect.gen(function* () {
      const { d, sessionID, t1 } = yield* dosTurnos()
      yield* escribir(`${d}/otro.txt`, "otro0")
      yield* (yield* reb).rebobinar({ sessionID, messageID: t1.user.id, modo: "todo" })
      yield* escribir(`${d}/otro.txt`, "otro-persona") // archivo que el rebobinado no tocó
      yield* escribir(`${d}/b.txt`, "B-persona") // archivo que SÍ tocó, cambiado después
      const u = yield* (yield* reb).deshacer({ sessionID })
      expect(yield* leer(`${d}/otro.txt`)).toBe("otro-persona")
      expect(yield* leer(`${d}/b.txt`)).toBe("B-persona") // conflicto: se salta
      expect(u.conflictos).toEqual(["b.txt"])
      expect(yield* leer(`${d}/a.txt`)).toBe("A1")
      expect(yield* leer(`${d}/n.txt`)).toBe("N1")
      expect((yield* sesionInfo(sessionID)).revert).toBeUndefined()
    }),
    { git: true },
  )

  it.instance(
    "el árbol queda igual que antes de rebobinar (todos los archivos)",
    Effect.gen(function* () {
      const { d, sessionID, t1 } = yield* dosTurnos()
      const leerTodo = Effect.gen(function* () {
        return [yield* leer(`${d}/a.txt`), yield* leer(`${d}/b.txt`), yield* leer(`${d}/n.txt`)]
      })
      const antes = yield* leerTodo
      yield* (yield* reb).rebobinar({ sessionID, messageID: t1.user.id, modo: "todo" })
      expect(yield* existe(`${d}/n.txt`)).toBe(false)
      yield* (yield* reb).deshacer({ sessionID })
      expect(yield* leerTodo).toEqual(antes)
    }),
    { git: true },
  )
})

describe("409: no se rebobina con trabajo en curso", () => {
  const fakeShell = (sessionID: string, directory: string): Job => {
    const job: Job = {
      id: "sh_rebobinar1",
      sessionID,
      directory,
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
    }
    job.kill = Effect.sync(() => {
      job.running = false
    })
    return job
  }

  it.instance(
    "la sesión está trabajando: ocupada",
    Effect.gen(function* () {
      const { sessionID, t1 } = yield* dosTurnos()
      const state = yield* SessionRunState.Service
      yield* state.ensureRunning(sessionID, Effect.never, Effect.never).pipe(Effect.forkScoped)
      yield* Effect.sleep("100 millis")
      const svc = yield* reb
      expect((yield* svc.revision({ sessionID, messageID: t1.user.id })).bloqueado).toBe("ocupada")
      const e = yield* svc.rebobinar({ sessionID, messageID: t1.user.id, modo: "todo" }).pipe(Effect.flip)
      expect(e).toMatchObject({ _tag: "RebobinarConflictoInterno", motivo: "ocupada" })
    }),
    { git: true },
  )

  it.instance(
    "una hija ocupada: hija-ocupada, y aparece en ayudantesActivos",
    Effect.gen(function* () {
      const { d, sessionID, t1 } = yield* dosTurnos()
      const sessions = yield* Session.Service
      const hija = yield* sessions.create({ parentID: sessionID, title: "Ayudante de prueba" })
      const state = yield* SessionRunState.Service
      yield* state.ensureRunning(hija.id, Effect.never, Effect.never).pipe(Effect.forkScoped)
      yield* Effect.sleep("100 millis")
      const svc = yield* reb
      const r = yield* svc.revision({ sessionID, messageID: t1.user.id })
      expect(r.bloqueado).toBe("hija-ocupada")
      expect(r.ayudantesActivos).toEqual([{ tipo: "sesion", id: hija.id, titulo: "Ayudante de prueba" }])
      const e = yield* svc.rebobinar({ sessionID, messageID: t1.user.id, modo: "codigo" }).pipe(Effect.flip)
      expect(e).toMatchObject({ motivo: "hija-ocupada" })
      expect(yield* leer(`${d}/a.txt`)).toBe("A1")
    }),
    { git: true },
  )

  it.instance(
    "un comando en segundo plano de la sesión: trabajo-vivo",
    Effect.gen(function* () {
      const { d, sessionID, t1 } = yield* dosTurnos()
      ShellBackground.register(fakeShell(sessionID, d))
      const svc = yield* reb
      const r = yield* svc.revision({ sessionID, messageID: t1.user.id })
      expect(r.bloqueado).toBe("trabajo-vivo")
      expect(r.ayudantesActivos.map((a) => a.id)).toEqual(["sh_rebobinar1"])
      const e = yield* svc.rebobinar({ sessionID, messageID: t1.user.id, modo: "todo" }).pipe(Effect.flip)
      expect(e).toMatchObject({ motivo: "trabajo-vivo" })
      expect(yield* leer(`${d}/a.txt`)).toBe("A1")
    }),
    { git: true },
  )

  it.instance(
    "un permiso pendiente: pendiente",
    Effect.gen(function* () {
      const { sessionID, t1 } = yield* dosTurnos()
      const permission = yield* Permission.Service
      yield* permission
        .ask({
          sessionID,
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
        })
        .pipe(Effect.forkScoped)
      yield* Effect.sleep("100 millis")
      const svc = yield* reb
      expect((yield* svc.revision({ sessionID, messageID: t1.user.id })).bloqueado).toBe("pendiente")
      const e = yield* svc.rebobinar({ sessionID, messageID: t1.user.id, modo: "todo" }).pipe(Effect.flip)
      expect(e).toMatchObject({ motivo: "pendiente" })
    }),
    { git: true },
  )
})

describe("interruptor LAZUNOX_REBOBINAR=0", () => {
  it.instance(
    "apaga las rutas (NoEncontrado)",
    conEntorno(
      { LAZUNOX_REBOBINAR: "0" },
      Effect.gen(function* () {
        const sessionID = yield* nuevaSesion
        const e = yield* (yield* reb).revision({ sessionID, messageID: MessageID.make("msg_x") }).pipe(Effect.flip)
        expect(e._tag).toBe("TurnoNoEncontrado")
      }),
    ),
    { git: true },
  )
})
