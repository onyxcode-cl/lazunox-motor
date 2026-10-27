import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Programadas } from "@/session/programadas"
import { LazunoxWake, type WakeOps } from "./lazunox-wake"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionID } from "../session/schema"
import { InstanceState } from "@/effect/instance-state"

// Lazunox (Ola 7 — 7.12, D3): herramientas `programar`, `listar_programadas`, `borrar_programada` y `esperar_y_continuar`. Solo con
// LAZUNOX_PROGRAMADAS=1 (apagado por defecto: cuatro definiciones más en cada petición y turnos sin supervisión; ver LAZUNOX.md).
// El núcleo (cron, topes, caducidad, disparos perdidos) está en `session/programadas.ts`; aquí viven las herramientas y el reloj que
// las dispara. Un disparo es un turno normal (`ops.prompt` con una parte sintética, igual que el aviso de un shell en segundo plano):
// pasa por la puerta del plan y por los permisos de siempre, y nunca aprueba nada.

export const PROGRAMAR_TOOL = "programar"
export const LISTAR_TOOL = "listar_programadas"
export const BORRAR_TOOL = "borrar_programada"
export const ESPERAR_TOOL = "esperar_y_continuar"

/** Reloj y periodo del vigilante; las pruebas los sustituyen. */
export const reloj = {
  ahora: () => Date.now(),
  periodoMs: () => Math.min(60_000, Math.max(20, Number.parseInt(process.env.LAZUNOX_PROGRAMADAS_TICK_MS ?? "", 10) || 15_000)),
}

type Info = { ops: WakeOps; agent: string; directorio: string }
const sesiones = new Map<string, Info>()
const vigilantes = new Set<string>()

export const _reiniciarParaPruebas = () => {
  sesiones.clear()
  vigilantes.clear()
  Programadas.reiniciarParaPruebas()
}

const hora = (t: number) => new Date(t).toString().replace(/ GMT.*$/, "")

const PROGRAMAR_DESCRIPTION = [
  "Schedule a prompt to run later in THIS session (cron, 5 fields, local time: minute hour day-of-month month day-of-week).",
  "It only fires while the engine is running and the session is idle; missed times are not recovered; it expires after 7 days; max 50 per session.",
  "When it fires you receive an automatic notice (not a new message from the user) and normal permissions apply. Use una_vez for a single run.",
].join(" ")
const LISTAR_DESCRIPTION = "List the scheduled tasks of this session (id, cron, next run, runs so far)."
const BORRAR_DESCRIPTION = "Delete a scheduled task of this session by id (from programar or listar_programadas), or all of them with id \"todas\"."
const ESPERAR_DESCRIPTION =
  "Pause and continue later in THIS session: after 60 s to 1 hour the session wakes up with your prompt (once). Use it to wait for something external instead of polling. Ends your turn."

export const ProgramarParameters = Schema.Struct({
  cron: Schema.String.annotate({ description: "5-field cron, e.g. \"*/30 * * * *\" or \"0 9 * * 1-5\"" }),
  tarea: Schema.String.annotate({ description: "What to do each time it fires (max 2000 chars)" }),
  una_vez: Schema.optional(Schema.Boolean).annotate({ description: "Run only once (default false = recurring)" }),
})
export const BorrarParameters = Schema.Struct({
  id: Schema.String.annotate({ description: "Task id, or \"todas\" to delete all of this session's tasks" }),
})
export const EsperarParameters = Schema.Struct({
  segundos: Schema.Number.annotate({ description: "Seconds to wait, 60 to 3600" }),
  tarea: Schema.String.annotate({ description: "What to do when you wake up" }),
})
const SinParametros = Schema.Struct({})

/** Un paso del vigilante: dispara lo vencido. Exportado para las pruebas. */
export const paso = Effect.fn("Programadas.paso")(function* (directorio: string, sessions: Session.Interface, status: SessionStatus.Interface) {
  const ocupadas = yield* status.list()
  const ahora = reloj.ahora()
  const debidas = Programadas.vencidas(ahora, (id) => sesiones.get(id)?.directorio === directorio && !ocupadas.has(SessionID.make(id)))
  for (const v of debidas) {
    const info = sesiones.get(v.sessionID)
    if (!info) continue
    const id = SessionID.make(v.sessionID)
    const existe = yield* sessions.get(id).pipe(Effect.option)
    if (existe._tag === "None") {
      Programadas.borrarTodas(v.sessionID)
      sesiones.delete(v.sessionID)
      continue
    }
    // Siempre el agente que la persona usó por última vez (si cambió a modo plan, el disparo entra en modo plan).
    const mensajes = yield* sessions.messages({ sessionID: id, limit: 20 }).pipe(Effect.orElseSucceed(() => []))
    const agente = mensajes.findLast((m) => m.info.role === "user")?.info
    yield* LazunoxWake.send(info.ops, {
      sessionID: id,
      agent: agente && "agent" in agente && typeof agente.agent === "string" ? agente.agent : info.agent,
      text: Programadas.textoDisparo(v.tarea, ahora),
      what: `tarea programada ${v.tarea.id}`,
    })
  }
})

const asegurarVigilante = Effect.fn("Programadas.vigilante")(function* (directorio: string, sessions: Session.Interface, status: SessionStatus.Interface) {
  if (vigilantes.has(directorio)) return
  vigilantes.add(directorio)
  const vuelta = Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(`${reloj.periodoMs()} millis`)
      if (Programadas.sesionesConTareas().length === 0) return
      yield* paso(directorio, sessions, status).pipe(Effect.catchCause((c) => Effect.logWarning("programadas: fallo en el vigilante", { c })))
    }
  }).pipe(Effect.ensuring(Effect.sync(() => void vigilantes.delete(directorio))))
  yield* Effect.forkDetach(vuelta)
})

const registrar = Effect.fn("Programadas.registrar")(function* (ctx: Tool.Context, sessions: Session.Interface, status: SessionStatus.Interface) {
  const ops = LazunoxWake.opsFrom(ctx.extra)
  if (!ops) throw new Error("Las tareas programadas no están disponibles en este modo (no hay forma de despertar la sesión).")
  const directorio = yield* InstanceState.directory
  sesiones.set(String(ctx.sessionID), { ops, agent: ctx.agent, directorio })
  yield* asegurarVigilante(directorio, sessions, status)
})

const fila = (t: Programadas.Tarea) =>
  `${t.id}  ${t.tipo === "espera" ? "espera" : t.cron}  ${t.tipo}  próximo: ${hora(t.proximo)}  disparos: ${t.disparos}  «${t.prompt.length > 80 ? `${t.prompt.slice(0, 80)}…` : t.prompt}»`

export const ProgramarTool = Tool.define(
  PROGRAMAR_TOOL,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const status = yield* SessionStatus.Service
    return {
    description: PROGRAMAR_DESCRIPTION,
    parameters: ProgramarParameters,
    execute: (params: Schema.Schema.Type<typeof ProgramarParameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const ahora = reloj.ahora()
        // Valida ANTES de pedir permiso (un cron roto no molesta a la persona).
        Programadas.parsearCron(params.cron)
        yield* ctx.ask({
          permission: PROGRAMAR_TOOL,
          patterns: [params.cron.trim()],
          always: [],
          metadata: { cron: params.cron, tarea: params.tarea.slice(0, 500), una_vez: params.una_vez === true },
        })
        yield* registrar(ctx, sessions, status)
        const t = Programadas.programar(String(ctx.sessionID), { cron: params.cron, prompt: params.tarea, unaVez: params.una_vez === true }, ahora)
        return {
          title: t.id,
          metadata: { id: t.id },
          output: `Tarea ${t.id} programada (${t.cron}${t.tipo === "una_vez" ? ", una vez" : ""}). Próximo disparo: ${hora(t.proximo)}. Solo dispara con la sesión inactiva y mientras el motor siga abierto; caduca a los 7 días.`,
        }
      }).pipe(Effect.orDie),
    }
  }),
)

export const ListarTool = Tool.define(
  LISTAR_TOOL,
  Effect.sync(() => ({
    description: LISTAR_DESCRIPTION,
    parameters: SinParametros,
    execute: (_params: Record<string, never>, ctx: Tool.Context) =>
      Effect.sync(() => {
        const lista = Programadas.listar(String(ctx.sessionID), reloj.ahora())
        return {
          title: `${lista.length} programadas`,
          metadata: { total: lista.length },
          output: lista.length === 0 ? "No hay tareas programadas en esta sesión." : lista.map(fila).join("\n"),
        }
      }),
  })),
)

export const BorrarTool = Tool.define(
  BORRAR_TOOL,
  Effect.sync(() => ({
    description: BORRAR_DESCRIPTION,
    parameters: BorrarParameters,
    execute: (params: Schema.Schema.Type<typeof BorrarParameters>, ctx: Tool.Context) =>
      Effect.sync(() => {
        const sid = String(ctx.sessionID)
        if (params.id === "todas") {
          const n = Programadas.borrarTodas(sid)
          return { title: "todas", metadata: { borradas: n }, output: `Borradas ${n} tareas programadas.` }
        }
        // Solo las de ESTA sesión: un id ajeno o inexistente da la misma respuesta.
        const ok = Programadas.borrar(sid, params.id.trim())
        if (!ok) throw new Error(`No hay ninguna tarea programada con id "${params.id}" en esta sesión.`)
        return { title: params.id, metadata: { borradas: 1 }, output: `Tarea ${params.id} borrada.` }
      }).pipe(Effect.orDie),
  })),
)

export const EsperarTool = Tool.define(
  ESPERAR_TOOL,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const status = yield* SessionStatus.Service
    return {
    description: ESPERAR_DESCRIPTION,
    parameters: EsperarParameters,
    execute: (params: Schema.Schema.Type<typeof EsperarParameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        yield* registrar(ctx, sessions, status)
        const t = Programadas.esperar(String(ctx.sessionID), { segundos: params.segundos, prompt: params.tarea }, reloj.ahora())
        return {
          title: t.id,
          metadata: { id: t.id },
          output: `Me despertaré hacia ${hora(t.proximo)} con tu tarea. Termina tu turno ahora (no sigas consultando). Si la persona escribe antes, la espera sigue vigente; bórrala con borrar_programada si ya no hace falta.`,
        }
      }).pipe(Effect.orDie),
    }
  }),
)
