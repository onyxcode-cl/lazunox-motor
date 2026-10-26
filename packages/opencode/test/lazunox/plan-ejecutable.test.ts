// Lazunox 2D (P09 + P35): plan ejecutable. Funciones puras + la herramienta `todowrite` con shell real y base de datos real.
// Incluye la amenaza S2: `verificar` NO es una vía para ejecutar sin permiso.
import { afterEach, describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Cause, Effect, Exit, Layer } from "effect"
import fs from "fs"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Plugin } from "../../src/plugin"
import { SessionProgreso } from "../../src/session/progreso"
import { Session } from "../../src/session/session"
import { MessageID } from "../../src/session/schema"
import { Todo } from "../../src/session/todo"
import type { TurnoDatos } from "../../src/session/turnos"
import {
  aplicarFallos,
  comandoDeVerificar,
  informe,
  porVerificar,
  provisional,
  TodoWriteTool,
  validarEnCurso,
} from "../../src/tool/todo"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances, TestInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const t = (content: string, status = "pending", extra: Partial<Todo.Info> = {}): Todo.Info => ({
  content,
  status,
  priority: "medium",
  ...extra,
})

describe("plan ejecutable: funciones puras", () => {
  test("comandoDeVerificar solo reconoce el prefijo «$ » y un comando no vacío", () => {
    expect(comandoDeVerificar("$ bun test")).toBe("bun test")
    expect(comandoDeVerificar("$   ls  ")).toBe("ls")
    expect(comandoDeVerificar("$ ")).toBeUndefined()
    expect(comandoDeVerificar("$")).toBeUndefined()
    expect(comandoDeVerificar("$bun test")).toBeUndefined()
    expect(comandoDeVerificar(" $ bun test")).toBeUndefined()
    expect(comandoDeVerificar("revisar a mano")).toBeUndefined()
    expect(comandoDeVerificar(undefined)).toBeUndefined()
  })

  test("como mucho una tarea in_progress", () => {
    expect(validarEnCurso([t("a", "in_progress"), t("b")])).toBeUndefined()
    expect(validarEnCurso([])).toBeUndefined()
    expect(validarEnCurso([t("a", "in_progress"), t("b", "in_progress")])).toContain("Solo una tarea")
  })

  test("porVerificar: solo lo que pasa a completed con comando; lo ya hecho no se repite", () => {
    const previas = [t("a", "completed", { verificar: "$ echo a" }), t("b", "in_progress", { verificar: "$ echo b" })]
    const nuevas = [
      t("a", "completed", { verificar: "$ echo a" }),
      t("b", "completed", { verificar: "$ echo b" }),
      t("c", "completed", { verificar: "texto libre" }),
      t("d", "completed"),
      t("e", "pending", { verificar: "$ echo e" }),
    ]
    expect(porVerificar(previas, nuevas)).toEqual([{ indice: 1, comando: "echo b" }])
    // Si cambia el comando de una tarea ya hecha, se vuelve a verificar.
    expect(porVerificar(previas, [t("a", "completed", { verificar: "$ echo otro" })])).toEqual([
      { indice: 0, comando: "echo otro" },
    ])
  })

  test("aplicarFallos: la tarea que falló vuelve a in_progress y no quedan dos en curso", () => {
    const lista = [t("a", "completed"), t("b", "completed"), t("c", "in_progress"), t("d")]
    const r = aplicarFallos(lista, new Set([1]))
    expect(r.map((x) => x.status)).toEqual(["completed", "in_progress", "pending", "pending"])
    expect(r.filter((x) => x.status === "in_progress").length).toBe(1)
    // Dos fallos: queda solo el primero en curso.
    const dos = aplicarFallos([t("a", "completed"), t("b", "completed")], new Set([0, 1]))
    expect(dos.map((x) => x.status)).toEqual(["in_progress", "pending"])
    // Sin fallos no cambia nada (y no muta la entrada).
    expect(aplicarFallos(lista, new Set()).map((x) => x.status)).toEqual(lista.map((x) => x.status))
    expect(lista[2]!.status).toBe("in_progress")
  })

  test("provisional deja en curso lo que aún no se comprobó; informe resume OK y fallos", () => {
    const lista = [t("a", "completed", { verificar: "$ true" })]
    expect(provisional(lista, [{ indice: 0, comando: "true" }])[0]!.status).toBe("in_progress")
    const texto = informe(lista, [{ indice: 0, comando: "false", ok: false, salida: "boom", exit: 1 }])
    expect(texto).toContain("FALLÓ")
    expect(texto).toContain("in_progress")
    expect(texto).toContain("boom")
    expect(informe(lista, [])).toBe("")
  })
})

// --- progreso por turno ---------------------------------------------------------------------------------------------

const turno = (id: string, opts: { archivos?: number; todos?: string[]; fallida?: boolean } = {}): TurnoDatos => {
  const parts: unknown[] = []
  if (opts.todos) {
    parts.push({
      type: "tool",
      tool: "todowrite",
      state: {
        status: opts.fallida ? "error" : "completed",
        metadata: { todos: opts.todos.map((status) => ({ content: "x", status, priority: "low" })) },
      },
    })
  }
  return {
    user: { id } as never,
    mensajes: [{ info: { role: "user" } as never, parts: [] }, { info: { role: "assistant" } as never, parts: parts as never }],
    parches: opts.archivos ? [{ hash: "h", files: Array.from({ length: opts.archivos }, (_, i) => `f${i}`) }] : [],
    herramientas: [],
  }
}

describe("progreso por turno (P35)", () => {
  test("archivos tocados o tareas completadas nuevas cuentan; leer o hablar no", () => {
    const p = SessionProgreso.progresoPorTurno([
      turno("m1", { archivos: 2 }),
      turno("m2"),
      turno("m3", { todos: ["completed", "in_progress"] }),
      turno("m4", { todos: ["completed", "in_progress"] }),
      turno("m5", { todos: ["completed", "completed"] }),
    ])
    expect(p.map((x) => x.huboProgreso)).toEqual([true, false, true, false, true])
    expect(p[0]!.motivos).toEqual(["archivos"])
    expect(p[2]!.motivos).toEqual(["tareas"])
    expect(p[4]!.nuevasCompletadas).toBe(1)
  })

  test("una llamada a todowrite con error no cuenta, y una verificación fallida (queda in_progress) tampoco", () => {
    const p = SessionProgreso.progresoPorTurno([
      turno("m1", { todos: ["completed"], fallida: true }),
      turno("m2", { todos: ["in_progress"] }),
    ])
    expect(p.map((x) => x.huboProgreso)).toEqual([false, false])
  })

  test("3 turnos seguidos sin progreso => bloqueado; menos de 3 turnos nunca", () => {
    const sin = (n: number) => Array.from({ length: n }, (_, i) => turno(`s${i}`))
    expect(SessionProgreso.estaBloqueado(SessionProgreso.progresoPorTurno(sin(2)))).toBe(false)
    expect(SessionProgreso.estaBloqueado(SessionProgreso.progresoPorTurno(sin(3)))).toBe(true)
    const conAvance = [turno("a", { archivos: 1 }), ...sin(2)]
    expect(SessionProgreso.turnosSinProgreso(SessionProgreso.progresoPorTurno(conAvance))).toBe(2)
    expect(SessionProgreso.estaBloqueado(SessionProgreso.progresoPorTurno(conAvance))).toBe(false)
    expect(SessionProgreso.estaBloqueado(SessionProgreso.progresoPorTurno([...conAvance, turno("z")]))).toBe(true)
    expect(SessionProgreso.estaBloqueado([], 0)).toBe(false)
  })
})

// --- herramienta con shell real -------------------------------------------------------------------------------------

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        Todo.node,
        Session.node,
        SessionProjector.node,
        CrossSpawnSpawner.node,
        FSUtil.node,
        Plugin.node,
        Truncate.node,
        Config.node,
        Agent.node,
        RuntimeFlags.node,
      ]),
    ),
    testInstanceStoreLayer,
  ),
)
const posix = process.platform !== "win32"

afterEach(async () => {
  await disposeAllInstances()
})

const contexto = (
  sessionID: Session.Info["id"],
  opts: { ask?: (permission: string) => Effect.Effect<void>; extra?: Record<string, unknown> } = {},
) => ({
  sessionID,
  messageID: MessageID.make("msg_plan_ejecutable"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  extra: opts.extra,
  metadata: () => Effect.void,
  ask: (req: { permission: string }) => (opts.ask ? opts.ask(req.permission) : Effect.void),
})

const herramienta = Effect.gen(function* () {
  return yield* (yield* TodoWriteTool).init()
})

const fallo = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.exit,
    Effect.map((exit) => {
      if (Exit.isSuccess(exit)) throw new Error("se esperaba un fallo")
      const err = Cause.squash(exit.cause)
      return err instanceof Error ? err : new Error(String(err))
    }),
  )

const estados = (sessionID: Session.Info["id"]) =>
  Effect.gen(function* () {
    return (yield* (yield* Todo.Service).get(sessionID)).map((x) => x.status)
  })

describe.skipIf(!posix)("todowrite con verificar (shell real)", () => {
  it.instance(
    "un comando que sale 0 deja la tarea completed y corrió de verdad",
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const sessionID = (yield* (yield* Session.Service).create({})).id
      const tool = yield* herramienta
      const r = yield* tool.execute(
        { todos: [t("crear marca", "completed", { verificar: "$ touch marca.txt && echo listo" })] },
        contexto(sessionID),
      )
      expect(fs.existsSync(path.join(tmp.directory, "marca.txt"))).toBe(true)
      expect(r.output).toContain("verificación OK")
      expect(r.metadata.todos[0]!.status).toBe("completed")
      expect(yield* estados(sessionID)).toEqual(["completed"])
    }),
  )

  it.instance(
    "si el comando falla la tarea queda in_progress, se informa y la salida vuelve al modelo",
    Effect.gen(function* () {
      const sessionID = (yield* (yield* Session.Service).create({})).id
      const tool = yield* herramienta
      const r = yield* tool.execute(
        {
          todos: [
            t("pasar pruebas", "completed", { verificar: "$ echo rotas >&2; exit 3" }),
            t("siguiente", "pending"),
          ],
        },
        contexto(sessionID),
      )
      expect(r.output).toContain("FALLÓ")
      expect(r.output).toContain("código 3")
      expect(r.output).toContain("rotas")
      expect(r.metadata.todos.map((x) => x.status)).toEqual(["in_progress", "pending"])
      expect(yield* estados(sessionID)).toEqual(["in_progress", "pending"])
    }),
  )

  it.instance(
    "S2: si el permiso de shell se NIEGA el comando no corre y la tarea queda in_progress",
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const sessionID = (yield* (yield* Session.Service).create({})).id
      const tool = yield* herramienta
      const preguntas: string[] = []
      const ctx = contexto(sessionID, {
        ask: (permission) => {
          preguntas.push(permission)
          return permission === "bash" ? Effect.die(new Error("RejectedError")) : Effect.void
        },
      })
      const error = yield* fallo(
        tool.execute({ todos: [t("peligro", "completed", { verificar: "$ touch intruso.txt" })] }, ctx),
      )
      expect(error.message).toContain("RejectedError")
      expect(preguntas).toContain("bash") // el comando SÍ pasó por el permiso de shell
      expect(fs.existsSync(path.join(tmp.directory, "intruso.txt"))).toBe(false)
      expect(yield* estados(sessionID)).toEqual(["in_progress"]) // nunca «hecha» sin comprobar
    }),
  )

  it.instance(
    "S2: en modo solo lectura (plan) un verificar que escribe no corre",
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const sessionID = (yield* (yield* Session.Service).create({})).id
      const tool = yield* herramienta
      const error = yield* fallo(
        tool.execute(
          { todos: [t("escribir", "completed", { verificar: "$ echo hola > x.txt" })] },
          contexto(sessionID, { extra: { soloLectura: true } }),
        ),
      )
      expect(error.message).toContain("Modo plan")
      expect(fs.existsSync(path.join(tmp.directory, "x.txt"))).toBe(false)
      expect(yield* estados(sessionID)).toEqual(["in_progress"])
    }),
  )

  it.instance(
    "S2: un verificar que sale del proyecto pregunta external_directory y, negado, no corre",
    Effect.gen(function* () {
      const sessionID = (yield* (yield* Session.Service).create({})).id
      const tool = yield* herramienta
      const fuera = path.join(path.dirname(path.resolve("/tmp")), "tmp", `lzx-2d-fuera-${Date.now()}.txt`)
      const preguntas: string[] = []
      const ctx = contexto(sessionID, {
        ask: (permission) => {
          preguntas.push(permission)
          return permission === "external_directory" ? Effect.die(new Error("RejectedError")) : Effect.void
        },
      })
      yield* fallo(tool.execute({ todos: [t("fuera", "completed", { verificar: `$ touch ${fuera}` })] }, ctx))
      expect(preguntas[0]).toBe("todowrite")
      expect(preguntas).toContain("external_directory")
      expect(fs.existsSync(fuera)).toBe(false)
    }),
  )

  it.instance(
    "un verificar sin «$ » es texto: no ejecuta nada y la tarea queda completed",
    Effect.gen(function* () {
      const sessionID = (yield* (yield* Session.Service).create({})).id
      const tool = yield* herramienta
      const preguntas: string[] = []
      const r = yield* tool.execute(
        { todos: [t("revisar", "completed", { verificar: "touch no-debe-existir.txt" })] },
        contexto(sessionID, { ask: (p) => (preguntas.push(p), Effect.void) }),
      )
      expect(preguntas).toEqual(["todowrite"])
      expect(r.output).not.toContain("Verificación")
      expect(yield* estados(sessionID)).toEqual(["completed"])
    }),
  )

  it.instance(
    "más de una tarea in_progress se rechaza y no se guarda nada",
    Effect.gen(function* () {
      const sessionID = (yield* (yield* Session.Service).create({})).id
      const tool = yield* herramienta
      const error = yield* fallo(
        tool.execute({ todos: [t("a", "in_progress"), t("b", "in_progress")] }, contexto(sessionID)),
      )
      expect(error.message).toContain("Solo una tarea")
      expect(yield* estados(sessionID)).toEqual([])
    }),
  )

  it.instance(
    "reescribir la lista no repite la verificación de lo que ya estaba completed",
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const sessionID = (yield* (yield* Session.Service).create({})).id
      const tool = yield* herramienta
      const todos = [t("contar", "completed", { verificar: "$ echo x >> cuenta.txt" })]
      yield* tool.execute({ todos }, contexto(sessionID))
      yield* tool.execute({ todos: [...todos, t("otra")] }, contexto(sessionID))
      const lineas = fs.readFileSync(path.join(tmp.directory, "cuenta.txt"), "utf8").trim().split("\n")
      expect(lineas.length).toBe(1)
    }),
  )

  it.instance(
    "verificar y bloqueado se guardan y vuelven a leerse",
    Effect.gen(function* () {
      const sessionID = (yield* (yield* Session.Service).create({})).id
      const tool = yield* herramienta
      yield* tool.execute(
        { todos: [t("a", "pending", { verificar: "texto", bloqueado: true }), t("b", "pending")] },
        contexto(sessionID),
      )
      const guardadas = yield* (yield* Todo.Service).get(sessionID)
      expect(guardadas[0]).toEqual({ content: "a", status: "pending", priority: "medium", verificar: "texto", bloqueado: true })
      expect(guardadas[1]).toEqual({ content: "b", status: "pending", priority: "medium" })
    }),
  )
})
