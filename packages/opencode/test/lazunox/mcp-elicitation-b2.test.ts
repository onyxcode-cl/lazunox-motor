// Formularios MCP, fase B2: cliente MCP, llamadas vivas, atribución, temporizador pausable y Detener.
// Servidor real por stdio (test/fixture/mcp-elicitation-stdio.ts) contra el servicio MCP real y McpInvocar.run.
import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Exit, Fiber } from "effect"
import { MCP } from "../../src/mcp/index"
import { McpElicitation } from "../../src/mcp/elicitation"
import { McpInvocar } from "../../src/mcp/invocar"
import * as EnCurso from "../../src/mcp/en-curso"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { SessionID } from "../../src/session/schema"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const fixture = path.join(import.meta.dir, "../fixture/mcp-elicitation-stdio.ts")
const S1 = SessionID.make("ses_uno")
const S2 = SessionID.make("ses_dos")

const it = testEffect(LayerNode.compile(LayerNode.group([MCP.node, McpElicitation.node, EventV2Bridge.node])))

const ENV = ["LAZUNOX_MCP_ELICITATION", "LAZUNOX_ELICITATION_TIMEOUT_MS"] as const
const guardado = Object.fromEntries(ENV.map((k) => [k, process.env[k]]))
afterEach(async () => {
  for (const k of ENV) {
    if (guardado[k] === undefined) delete process.env[k]
    else process.env[k] = guardado[k]
  }
  await disposeAllInstances()
})

const activar = () => {
  process.env.LAZUNOX_MCP_ELICITATION = "1"
}

const conectar = Effect.gen(function* () {
  const mcp = yield* MCP.Service
  yield* mcp.add("srv", { type: "local", command: [process.execPath, fixture] })
  return mcp
})

const capturar = Effect.gen(function* () {
  const events = yield* EventV2Bridge.Service
  const log: Array<{ type: string; data: Record<string, any> }> = []
  const off = yield* events.listen((e) => {
    if (e.type.startsWith("mcp.elicitation.")) log.push({ type: e.type, data: e.data as Record<string, any> })
    return Effect.void
  })
  yield* Effect.addFinalizer(() => off)
  return log
})

const esperarPendientes = (n: number) =>
  Effect.gen(function* () {
    const svc = yield* McpElicitation.Service
    for (let i = 0; i < 600; i++) {
      const l = yield* svc.list()
      if (l.length === n) return l
      yield* Effect.sleep("10 millis")
    }
    throw new Error(`no llegaron ${n} pendientes`)
  })

const esperar = (cond: () => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 600; i++) {
      if (cond()) return
      yield* Effect.sleep("10 millis")
    }
    throw new Error("condición no cumplida")
  })

function llamar(
  mcp: MCP.Interface,
  tool: string,
  args: Record<string, unknown>,
  o: { sessionID?: SessionID; callID?: string; abort?: AbortSignal; timeout?: number } = {},
) {
  return Effect.gen(function* () {
    const entry = (yield* mcp.tools())[`srv_${tool}`]
    if (!entry) throw new Error(`falta srv_${tool}`)
    return yield* McpInvocar.run({
      key: `srv_${tool}`,
      entry: o.timeout !== undefined ? { ...entry, timeout: o.timeout } : entry,
      args,
      opts: { toolCallId: o.callID ?? "call-1", abortSignal: o.abort, messages: [] } as any,
      ctx: { sessionID: o.sessionID ?? S1, ask: () => Effect.void },
      messageID: "msg_1",
      plugin: { trigger: ((_n: string, _i: unknown, out: unknown) => Effect.succeed(out)) as any },
      truncate: { output: (text: string) => Effect.succeed({ content: text, truncated: false }) } as any,
      agent: { name: "build", mode: "primary", options: {}, permission: [] } as any,
      processor: { completeToolCall: () => Effect.void },
    })
  })
}

const texto = (out: { output: string }) => JSON.parse(out.output)
const tipos = (log: Array<{ type: string }>) => log.map((e) => e.type)

// ---------------------------------------------------------------------------------------------------------------------
// Funciones puras del registro de llamadas vivas y del temporizador
// ---------------------------------------------------------------------------------------------------------------------

describe("registro de llamadas vivas", () => {
  const cliente = () => ({})
  const llamada = (client: object, sessionID: string, callID: string): EnCurso.LiveCall => ({
    key: "srv_form",
    sessionID,
    messageID: "m",
    callID,
    abort: undefined,
    client,
  })

  test("atribución: 0 llamadas, 1 llamada, varias de la misma sesión y varias sesiones", () => {
    const c = cliente()
    expect(EnCurso.atribuir(c)).toEqual({ kind: "ninguna" })

    const a = llamada(c, "ses_1", "c1")
    EnCurso.registrar("enter", a)
    expect(EnCurso.atribuir(c)).toMatchObject({ kind: "sesion", sessionID: "ses_1", callID: "c1" })

    const b = llamada(c, "ses_1", "c2")
    EnCurso.registrar("enter", b)
    const dos = EnCurso.atribuir(c)
    expect(dos).toMatchObject({ kind: "sesion", sessionID: "ses_1", callID: undefined })

    const d = llamada(c, "ses_2", "c3")
    EnCurso.registrar("enter", d)
    expect(EnCurso.atribuir(c)).toEqual({ kind: "ambigua", sesiones: ["ses_1", "ses_2"] })

    EnCurso.registrar("exit", d)
    EnCurso.registrar("exit", b)
    EnCurso.registrar("exit", a)
    expect(EnCurso.atribuir(c)).toEqual({ kind: "ninguna" })
  })

  test("cada cliente tiene sus propias llamadas", () => {
    const c1 = cliente()
    const c2 = cliente()
    EnCurso.registrar("enter", llamada(c1, "ses_1", "c1"))
    expect(EnCurso.atribuir(c2)).toEqual({ kind: "ninguna" })
  })

  test("alSalir avisa al terminar la llamada, aunque el aviso falle", () => {
    const c = cliente()
    const vistas: string[] = []
    EnCurso.alSalir(c, (call) => {
      vistas.push(String(call.callID))
      throw new Error("falla el aviso")
    })
    const a = llamada(c, "ses_1", "c1")
    EnCurso.registrar("enter", a)
    EnCurso.registrar("exit", a)
    expect(vistas).toEqual(["c1"])
    expect(EnCurso.atribuir(c)).toEqual({ kind: "ninguna" })
  })

  test("senalDeAborto combina las señales de las llamadas", () => {
    const c = cliente()
    const x = new AbortController()
    const y = new AbortController()
    const a = { ...llamada(c, "s", "1"), abort: x.signal }
    const b = { ...llamada(c, "s", "2"), abort: y.signal }
    expect(EnCurso.senalDeAborto([llamada(c, "s", "0")])).toBeUndefined()
    expect(EnCurso.senalDeAborto([a])).toBe(x.signal)
    const juntas = EnCurso.senalDeAborto([a, b])!
    expect(juntas.aborted).toBe(false)
    y.abort()
    expect(juntas.aborted).toBe(true)
  })
})

describe("temporizador pausable", () => {
  const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms))

  test("corta al agotarse el tiempo", async () => {
    const t = EnCurso.crearTemporizador({ timeoutMs: 40, signal: undefined, activo: true })
    t.arrancar()
    expect(t.signal!.aborted).toBe(false)
    await dormir(120)
    expect(t.signal!.aborted).toBe(true)
    expect(String((t.signal!.reason as Error).message)).toContain("timed out")
    t.parar()
  })

  test("pausar detiene el tiempo y reanudar lo reinicia completo", async () => {
    const t = EnCurso.crearTemporizador({ timeoutMs: 60, signal: undefined, activo: true })
    t.arrancar()
    const reanudar = t.pausar()
    await dormir(200)
    expect(t.signal!.aborted).toBe(false)
    reanudar()
    reanudar() // idempotente
    await dormir(30)
    expect(t.signal!.aborted).toBe(false)
    await dormir(100)
    expect(t.signal!.aborted).toBe(true)
  })

  test("dos pausas anidadas: solo corre cuando se reanudan las dos", async () => {
    const t = EnCurso.crearTemporizador({ timeoutMs: 40, signal: undefined, activo: true })
    t.arrancar()
    const r1 = t.pausar()
    const r2 = t.pausar()
    r1()
    await dormir(120)
    expect(t.signal!.aborted).toBe(false)
    r2()
    await dormir(120)
    expect(t.signal!.aborted).toBe(true)
  })

  test("el progreso reinicia el tiempo y parar lo cancela", async () => {
    const t = EnCurso.crearTemporizador({ timeoutMs: 80, signal: undefined, activo: true })
    t.arrancar()
    for (let i = 0; i < 4; i++) {
      await dormir(40)
      t.onprogress()
    }
    expect(t.signal!.aborted).toBe(false)
    t.parar()
    await dormir(150)
    expect(t.signal!.aborted).toBe(false)
  })

  test("la señal del usuario también aborta la combinada; sin la variable todo pasa tal cual", () => {
    const user = new AbortController()
    const t = EnCurso.crearTemporizador({ timeoutMs: 1000, signal: user.signal, activo: true })
    user.abort()
    expect(t.signal!.aborted).toBe(true)
    expect(t.timeout).toBe(EnCurso.TOPE_SDK_MS)

    const off = EnCurso.crearTemporizador({ timeoutMs: 1234, signal: user.signal, activo: false })
    expect(off.activo).toBe(false)
    expect(off.signal).toBe(user.signal)
    expect(off.timeout).toBe(1234)
    expect(off.pausar()).toBeInstanceOf(Function)
  })

  test("conLlamadaViva registra al entrar y al salir (también con error) y expone pausar solo si está activo", async () => {
    const c = {}
    const fases: string[] = []
    let live: EnCurso.LiveCall | undefined
    const onCall: EnCurso.OnCall = (fase, call) => {
      fases.push(fase)
      live = call
    }
    const base = { key: "k", sessionID: "s", messageID: "m", callID: "c", abort: undefined, client: c }
    await Effect.runPromise(EnCurso.conLlamadaViva({ call: base, timeoutMs: 100, onCall, use: () => Effect.succeed(1) }))
    expect(fases).toEqual(["enter", "exit"])
    expect(live?.pausar).toBeUndefined()

    fases.length = 0
    const fallo = await Effect.runPromiseExit(
      EnCurso.conLlamadaViva({ call: base, timeoutMs: 100, onCall, use: () => Effect.fail("boom") }),
    )
    expect(Exit.isFailure(fallo)).toBe(true)
    expect(fases).toEqual(["enter", "exit"])

    process.env.LAZUNOX_MCP_ELICITATION = "1"
    try {
      await Effect.runPromise(EnCurso.conLlamadaViva({ call: base, timeoutMs: 100, onCall, use: () => Effect.succeed(1) }))
      expect(live?.pausar).toBeInstanceOf(Function)
    } finally {
      delete process.env.LAZUNOX_MCP_ELICITATION
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Con servidor real
// ---------------------------------------------------------------------------------------------------------------------

it.instance(
  "sin la variable el servidor NO ve la capacidad y no puede pedir formularios",
  () =>
    Effect.gen(function* () {
      delete process.env.LAZUNOX_MCP_ELICITATION
      const log = yield* capturar
      const mcp = yield* conectar
      const caps = texto(yield* llamar(mcp, "caps", {}))
      expect(caps.elicitation).toBeUndefined()
      expect(caps.roots).toBeDefined()
      const r = texto(yield* llamar(mcp, "form", {}))
      expect(r.error).toContain("does not support form elicitation")
      expect(log).toHaveLength(0)
    }),
  { git: true },
  30_000,
)

it.instance(
  "con la variable el servidor ve elicitation.form y no el modo url",
  () =>
    Effect.gen(function* () {
      activar()
      const mcp = yield* conectar
      const caps = texto(yield* llamar(mcp, "caps", {}))
      expect(caps.elicitation).toEqual({ form: {} })
    }),
  { git: true },
  30_000,
)

it.instance(
  "una llamada viva atribuye el formulario a su sesión y aceptar devuelve los valores al servidor",
  () =>
    Effect.gen(function* () {
      activar()
      const log = yield* capturar
      const mcp = yield* conectar
      const svc = yield* McpElicitation.Service
      const fiber = yield* llamar(mcp, "form", {}, { sessionID: S2, callID: "call_b" }).pipe(Effect.forkScoped)
      const [p] = yield* esperarPendientes(1)
      expect(p).toMatchObject({ sessionID: S2, server: "srv", callID: "call_b", message: "¿Quién eres?" })
      expect(p.fields.map((f) => f.name)).toEqual(["nombre", "edad"])
      yield* svc.reply({ requestID: p.id, action: "accept", content: { nombre: "Ana", edad: 7 } })
      const out = yield* Fiber.join(fiber)
      expect(texto(out)).toEqual({ action: "accept", content: { nombre: "Ana", edad: 7 } })
      expect(tipos(log)).toEqual(["mcp.elicitation.asked", "mcp.elicitation.replied"])
      // la llamada terminó: ya no hay llamadas vivas del cliente
      expect(EnCurso.atribuir((yield* mcp.tools())["srv_form"].client)).toEqual({ kind: "ninguna" })
    }),
  { git: true },
  30_000,
)

it.instance(
  "declinar y cancelar llegan al servidor como decline y cancel",
  () =>
    Effect.gen(function* () {
      activar()
      const mcp = yield* conectar
      const svc = yield* McpElicitation.Service
      for (const action of ["decline", "cancel"] as const) {
        const fiber = yield* llamar(mcp, "form", {}).pipe(Effect.forkScoped)
        const [p] = yield* esperarPendientes(1)
        yield* svc.reply({ requestID: p.id, action })
        expect(texto(yield* Fiber.join(fiber)).action).toBe(action)
      }
    }),
  { git: true },
  30_000,
)

it.instance(
  "solicitud sin llamada viva: decline y no se muestra nada",
  () =>
    Effect.gen(function* () {
      activar()
      const log = yield* capturar
      const mcp = yield* conectar
      yield* llamar(mcp, "late", {}) // la llamada termina; 150 ms después el servidor pide un formulario
      const entry = (yield* mcp.tools())["srv_late_result"]
      let resultado: any = "pendiente"
      yield* esperar(() => resultado !== "pendiente").pipe(
        Effect.timeoutOption("5 seconds"),
        Effect.raceFirst(
          Effect.gen(function* () {
            for (let i = 0; i < 400 && resultado === "pendiente"; i++) {
              const r = yield* Effect.promise(() => entry.client.callTool({ name: "late_result", arguments: {} }))
              const t = (r.content as any)[0].text
              resultado = t === '"pendiente"' || t === "pendiente" ? "pendiente" : JSON.parse(t)
              if (resultado === "pendiente") yield* Effect.sleep("25 millis")
            }
          }),
        ),
      )
      expect(resultado).toMatchObject({ action: "decline" })
      expect(tipos(log)).not.toContain("mcp.elicitation.asked")
      expect((yield* (yield* McpElicitation.Service).list()).length).toBe(0)
    }),
  { git: true },
  30_000,
)

it.instance(
  "llamadas vivas de varias sesiones: ambiguo, decline para todas y rejected/ambiguous por sesión, sin preguntar",
  () =>
    Effect.gen(function* () {
      activar()
      const log = yield* capturar
      const mcp = yield* conectar
      const a = yield* llamar(mcp, "form", {}, { sessionID: S1, callID: "ca" }).pipe(Effect.forkScoped)
      const b = yield* llamar(mcp, "form", {}, { sessionID: S2, callID: "cb" }).pipe(Effect.forkScoped)
      const ra = texto(yield* Fiber.join(a))
      const rb = texto(yield* Fiber.join(b))
      expect(ra.action).toBe("decline")
      expect(rb.action).toBe("decline")
      expect(tipos(log)).not.toContain("mcp.elicitation.asked")
      const rechazos = log.filter((e) => e.type === "mcp.elicitation.rejected")
      expect(new Set(rechazos.map((e) => e.data.sessionID))).toEqual(new Set([S1, S2]))
      for (const r of rechazos) expect(r.data.reason).toBe("ambiguous")
    }),
  { git: true },
  30_000,
)

it.instance(
  "un campo secreto se rechaza sin tarjeta (decline + rejected/secret)",
  () =>
    Effect.gen(function* () {
      activar()
      const log = yield* capturar
      const mcp = yield* conectar
      const schema = { type: "object", properties: { password: { type: "string", title: "Contraseña" } } }
      const r = texto(yield* llamar(mcp, "form", { schema }))
      expect(r.action).toBe("decline")
      expect(tipos(log)).toEqual(["mcp.elicitation.rejected"])
      expect(log[0].data.reason).toBe("secret")
    }),
  { git: true },
  30_000,
)

it.instance(
  "el modo url no llega a mostrarse: el cliente no lo anuncia y no hay tarjeta",
  () =>
    Effect.gen(function* () {
      activar()
      const log = yield* capturar
      const mcp = yield* conectar
      const r = texto(yield* llamar(mcp, "urlform", {}))
      expect(r.resultado?.action === "accept").toBeFalsy()
      expect(tipos(log)).not.toContain("mcp.elicitation.asked")
      expect((yield* (yield* McpElicitation.Service).list()).length).toBe(0)
    }),
  { git: true },
  30_000,
)

it.instance(
  "notifications/cancelled del servidor cierra el formulario con rejected/server-cancel",
  () =>
    Effect.gen(function* () {
      activar()
      const log = yield* capturar
      const mcp = yield* conectar
      const fiber = yield* llamar(mcp, "form", { abortAfterMs: 250 }).pipe(Effect.forkScoped)
      yield* esperarPendientes(1)
      yield* Fiber.join(fiber)
      // El cierre llega por la señal del SDK, en paralelo al resultado de la herramienta: se espera a que se asiente.
      yield* esperarPendientes(0)
      yield* esperar(() => log.some((e) => e.type === "mcp.elicitation.rejected"))
      expect(tipos(log)).toEqual(["mcp.elicitation.asked", "mcp.elicitation.rejected"])
      expect(log[1].data.reason).toBe("server-cancel")
    }),
  { git: true },
  30_000,
)

it.instance(
  "Detener la sesión con un formulario abierto: rejected/abort y el servidor recibe cancel",
  () =>
    Effect.gen(function* () {
      activar()
      const log = yield* capturar
      const mcp = yield* conectar
      const svc = yield* McpElicitation.Service
      const fiber = yield* llamar(mcp, "form", {}, { sessionID: S1 }).pipe(Effect.forkScoped)
      yield* esperarPendientes(1)
      // Otra sesión no se toca
      expect(yield* svc.cancelSession(S2, "abort")).toBe(0)
      expect(yield* svc.list()).toHaveLength(1)
      expect(yield* svc.cancelSession(S1, "abort")).toBe(1)
      const r = texto(yield* Fiber.join(fiber))
      expect(r.action).toBe("cancel")
      expect(tipos(log)).toEqual(["mcp.elicitation.asked", "mcp.elicitation.rejected"])
      expect(log[1].data).toMatchObject({ sessionID: S1, reason: "abort" })
      expect(yield* svc.list()).toHaveLength(0)
    }),
  { git: true },
  30_000,
)

it.instance(
  "abortar la llamada (señal del turno) cierra el formulario con rejected/abort",
  () =>
    Effect.gen(function* () {
      activar()
      const log = yield* capturar
      const mcp = yield* conectar
      const controller = new AbortController()
      const fiber = yield* llamar(mcp, "form", {}, { abort: controller.signal }).pipe(Effect.forkScoped)
      yield* esperarPendientes(1)
      controller.abort()
      const salida = yield* Fiber.await(fiber)
      expect(Exit.isFailure(salida)).toBe(true)
      yield* esperar(() => log.some((e) => e.type === "mcp.elicitation.rejected"))
      expect(log.find((e) => e.type === "mcp.elicitation.rejected")?.data.reason).toBe("abort")
      expect(yield* (yield* McpElicitation.Service).list()).toHaveLength(0)
    }),
  { git: true },
  30_000,
)

it.instance(
  "el timeout de la llamada no corre mientras hay un formulario abierto",
  () =>
    Effect.gen(function* () {
      activar()
      const mcp = yield* conectar
      const svc = yield* McpElicitation.Service
      let terminada = false
      const fiber = yield* llamar(mcp, "form", {}, { timeout: 300 }).pipe(
        Effect.ensuring(Effect.sync(() => (terminada = true))),
        Effect.forkScoped,
      )
      const [p] = yield* esperarPendientes(1)
      yield* Effect.sleep("800 millis") // más del doble del timeout de la llamada
      expect(terminada).toBe(false)
      yield* svc.reply({ requestID: p.id, action: "accept", content: { nombre: "Luz" } })
      expect(texto(yield* Fiber.join(fiber))).toMatchObject({ action: "accept", content: { nombre: "Luz" } })
    }),
  { git: true },
  30_000,
)

it.instance(
  "sin formulario, el temporizador propio sigue cortando una llamada lenta",
  () =>
    Effect.gen(function* () {
      activar()
      const mcp = yield* conectar
      const salida = yield* Effect.exit(llamar(mcp, "sleep", { ms: 1500 }, { timeout: 250 }))
      expect(Exit.isFailure(salida)).toBe(true)
      // y una rápida pasa
      expect((yield* llamar(mcp, "sleep", { ms: 20 }, { timeout: 2000 })).output).toBe("dormido")
    }),
  { git: true },
  30_000,
)

it.instance(
  "sin la variable la llamada se ejecuta como antes (timeout del SDK, sin registro de formularios)",
  () =>
    Effect.gen(function* () {
      delete process.env.LAZUNOX_MCP_ELICITATION
      const mcp = yield* conectar
      const salida = yield* Effect.exit(llamar(mcp, "sleep", { ms: 1500 }, { timeout: 250 }))
      expect(Exit.isFailure(salida)).toBe(true)
      expect((yield* llamar(mcp, "sleep", { ms: 20 }, { timeout: 2000 })).output).toBe("dormido")
    }),
  { git: true },
  30_000,
)
