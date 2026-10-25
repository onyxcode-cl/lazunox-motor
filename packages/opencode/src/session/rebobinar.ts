// Lazunox: rebobinar por turno con tres modos, revisión previa y deshacer. Plan PLAN-REBOBINAR-Y-COMPACTACION.md, 2.A.4-2.A.7.
// Rutas (grupo experimental): GET …/rebobinar/{messageID} (revisión, solo lectura), POST …/rebobinar, POST …/rebobinar/deshacer.
//
// Reglas que no se negocian:
//  - Un objeto ausente NUNCA borra un archivo: el punto «caducó» y no se toca nada (ver snapshot/index.ts).
//  - No se hace reset, stash, commit ni checkout de ramas; `.git` no se toca. Los commits posteriores solo se avisan.
//  - Los archivos que cambiaron DESPUÉS del último paso de la sesión (conflictos) y las rutas protegidas se saltan
//    salvo que la persona los pida en `sobrescribir`.
//  - Se niega (409) si la sesión, una hija o un trabajo de fondo están en marcha, o hay permiso/pregunta/formulario pendiente.
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer, Semaphore } from "effect"
import path from "path"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { McpElicitation } from "@/mcp/elicitation"
import { Permission } from "@/permission"
import { activo as rutasProtegidasActivo, esProtegida } from "@/permission/rutas-protegidas"
import { Question } from "@/question"
import { Snapshot } from "@/snapshot"
import { Trabajos } from "@/tool/trabajos"
import { Session } from "./session"
import type { MessageID, SessionID } from "./schema"
import { SessionRevert } from "./revert"
import { SessionRunState } from "./run-state"
import { activo, agrupar, arbolesDe, NoEncontrado, origenes, type Archivo, type TurnoDatos } from "./turnos"

export type Modo = "todo" | "conversacion" | "codigo"

export class Invalido extends Error {
  readonly _tag = "RebobinarInvalido"
}
/** 409: `motivo` = ocupada | hija-ocupada | trabajo-vivo | pendiente | caducado | sin-git | sin-instantaneas | revert-pendiente | nada-que-deshacer */
export class Conflicto extends Error {
  readonly _tag = "RebobinarConflictoInterno"
  constructor(
    readonly motivo: string,
    message: string,
  ) {
    super(message)
  }
}

export interface Revision {
  archivos: Archivo[]
  conflictos: string[]
  protegidos: string[]
  comandos: boolean
  commitsDespues: { hash: string; asunto: string }[]
  ayudantesActivos: { tipo: "sesion" | "ayudante" | "shell" | "celda"; id: string; titulo: string }[]
  mensajes: number
  restaurable: boolean
  motivo?: string
  bloqueado?: string
}

export interface Resultado {
  modo: Modo
  restaurados: string[]
  borrados: string[]
  omitidos: { file: string; motivo: string }[]
  mensajesOcultos: number
  puedeDeshacer: boolean
}

export interface ResultadoDeshacer {
  restaurados: string[]
  borrados: string[]
  omitidos: { file: string; motivo: string }[]
  conflictos: string[]
}

type Errores = NoEncontrado | Invalido | Conflicto | Session.NotFound | Snapshot.ExpiredError

export interface Interface {
  readonly revision: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<Revision, Errores>
  readonly rebobinar: (input: {
    sessionID: SessionID
    messageID: MessageID
    modo: Modo
    sobrescribir?: readonly string[]
  }) => Effect.Effect<Resultado, Errores>
  readonly deshacer: (input: {
    sessionID: SessionID
    sobrescribir?: readonly string[]
  }) => Effect.Effect<ResultadoDeshacer, Errores>
}

export class Service extends Context.Service<Service, Interface>()("@lazunox/SessionRebobinar") {}

const ES_COMANDO = (tool: string) =>
  tool === "bash" || tool.startsWith("bash_") || tool === "execute" || tool === "execute_wait"

const notaTexto = (ordinal: number, archivos: string[]) =>
  `La persona restauró estos archivos a como estaban antes del turno ${ordinal}: ${archivos.slice(0, 50).join(", ")}${
    archivos.length > 50 ? ` y ${archivos.length - 50} más` : ""
  }. Cualquier cambio que se hubiera hecho en ellos desde entonces ya no está: no trabajes sobre lo que recuerdes de esos archivos, vuelve a leerlos antes de editarlos.`

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snapshot = yield* Snapshot.Service
    const config = yield* Config.Service
    const revert = yield* SessionRevert.Service
    const state = yield* SessionRunState.Service
    const background = yield* BackgroundJob.Service
    const permission = yield* Permission.Service
    const question = yield* Question.Service
    const elicitation = yield* McpElicitation.Service

    // Un candado por sesión: la revisión y la aplicación de un rebobinado/deshacer no se intercalan con otro.
    const candados = new Map<string, Semaphore.Semaphore>()
    const candado = (sessionID: string) => {
      const actual = candados.get(sessionID)
      if (actual) return actual
      const nuevo = Semaphore.makeUnsafe(1)
      candados.set(sessionID, nuevo)
      return nuevo
    }

    const apagado = () => new NoEncontrado("Rebobinar por turno está desactivado (LAZUNOX_REBOBINAR=0)")

    /** La sesión y todas sus descendientes (hijas, nietas…). */
    const familia = Effect.fnUntraced(function* (sessionID: SessionID) {
      const todas: Session.Info[] = []
      const pendientes: SessionID[] = [sessionID]
      const vistos = new Set<string>([sessionID])
      while (pendientes.length) {
        const actual = pendientes.shift()!
        for (const hija of yield* sessions.children(actual)) {
          if (vistos.has(hija.id)) continue
          vistos.add(hija.id)
          todas.push(hija)
          pendientes.push(hija.id)
        }
      }
      return todas
    })

    /** Lo que impide rebobinar ahora mismo y los ayudantes vivos que se deben mostrar. */
    const bloqueos = Effect.fnUntraced(function* (sessionID: SessionID) {
      const ctx = yield* InstanceState.context
      const hijas = yield* familia(sessionID)
      const ids = new Set<string>([sessionID, ...hijas.map((item) => item.id)])
      const ocupada = (id: SessionID) =>
        state.assertNotBusy(id).pipe(Effect.match({ onFailure: () => true, onSuccess: () => false }))
      const ayudantes: Revision["ayudantesActivos"] = []
      const vistos = new Set<string>()
      const sumar = (item: Revision["ayudantesActivos"][number]) => {
        if (vistos.has(item.id)) return
        vistos.add(item.id)
        ayudantes.push(item)
      }
      const propiaOcupada = yield* ocupada(sessionID)
      let hijaOcupada = false
      for (const hija of hijas) {
        if (yield* ocupada(hija.id)) {
          hijaOcupada = true
          sumar({ tipo: "sesion", id: hija.id, titulo: hija.title })
        }
      }
      for (const job of yield* background.list()) {
        if (job.type !== "task" || job.status !== "running") continue
        const padre = job.metadata?.["parentSessionId"]
        if (typeof padre === "string" && ids.has(padre)) {
          hijaOcupada = true
          sumar({ tipo: "ayudante", id: job.id, titulo: job.title ?? "Ayudante" })
        }
      }
      let trabajoVivo = false
      for (const id of ids) {
        for (const trabajo of yield* Trabajos.listar(background, id, ctx.directory)) {
          if (trabajo.estado !== "en_curso") continue
          trabajoVivo = true
          sumar({ tipo: trabajo.tipo, id: trabajo.id, titulo: trabajo.titulo })
        }
      }
      const permisos = (yield* permission.list()).some((item) => ids.has(item.sessionID))
      const preguntas = (yield* question.list()).some((item) => ids.has(item.sessionID))
      const formularios = (yield* elicitation.list()).some((item) => ids.has(item.sessionID))
      const bloqueado = propiaOcupada
        ? "ocupada"
        : hijaOcupada
          ? "hija-ocupada"
          : trabajoVivo
            ? "trabajo-vivo"
            : permisos || preguntas || formularios
              ? "pendiente"
              : undefined
      return { bloqueado, ayudantes }
    })

    const mensajeDeBloqueo = (motivo: string) =>
      motivo === "ocupada"
        ? "La sesión está trabajando: espera a que termine o pulsa Detener."
        : motivo === "hija-ocupada"
          ? "Un ayudante de esta sesión sigue trabajando: espera a que termine o detenlo."
          : motivo === "trabajo-vivo"
            ? "Hay un comando o script en segundo plano de esta sesión: termínalo antes de rebobinar."
            : "Hay un permiso, pregunta o formulario pendiente: respóndelo antes de rebobinar."

    const analizar = Effect.fnUntraced(function* (sessionID: SessionID, messageID: MessageID) {
      yield* sessions.get(sessionID)
      const ctx = yield* InstanceState.context
      const mensajes = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
      const turnos = agrupar(mensajes)
      const indice = turnos.findIndex((item) => item.user.id === messageID)
      if (indice < 0) {
        if (mensajes.some((item) => item.info.id === messageID)) {
          return yield* Effect.fail(new Invalido("El mensaje indicado no es un mensaje de la persona."))
        }
        return yield* Effect.fail(new NoEncontrado(`Mensaje no encontrado: ${messageID}`))
      }
      const desde: TurnoDatos[] = turnos.slice(indice)
      const rel = (file: string) => path.relative(ctx.worktree, path.resolve(ctx.worktree, file)).replaceAll("\\", "/")
      const abs = (file: string) => path.join(ctx.worktree, file).replaceAll("\\", "/")

      const git = ctx.project.vcs === "git"
      const encendido = (yield* config.get()).snapshot !== false
      let motivo: string | undefined = !git ? "sin-git" : !encendido ? "sin-instantaneas" : undefined

      const parches = desde.flatMap((item) => item.parches)
      const arboles = Array.from(new Set(desde.flatMap((item) => [...arbolesDe(item)])))
      if (!motivo && arboles.length) {
        const existen = yield* snapshot.hasMany(arboles)
        if (arboles.some((tree) => !existen.has(tree))) motivo = "caducado"
      }

      // Archivos que el rebobinado tocaría: los de los parches de este turno y los siguientes, solo los que hoy difieren.
      const nombrados = new Set<string>()
      for (const parche of parches) for (const file of parche.files) nombrados.add(rel(file))
      let archivos: Archivo[] = []
      let conflictos: string[] = []
      if (!motivo && nombrados.size) {
        const inicio = desde[0]!.from ?? parches[0]?.hash
        const ahora = yield* snapshot.track()
        const filas = inicio && ahora ? yield* snapshot.numstat(inicio, ahora) : []
        const combinado: TurnoDatos = { ...desde[0]!, herramientas: desde.flatMap((item) => item.herramientas) }
        const { origen } = origenes(combinado, ctx.directory, ctx.worktree)
        archivos = filas
          .filter((fila) => nombrados.has(fila.file))
          .map((fila) => ({
            file: fila.file,
            status: fila.status,
            additions: fila.additions,
            deletions: fila.deletions,
            origen: origen(fila.file),
          }))
        // Conflicto = el archivo cambió después del último paso de la sesión (lo tocó la persona u otro proceso).
        let ultimo: string | undefined
        for (const mensaje of mensajes) {
          for (const part of mensaje.parts) if (part.type === "step-finish" && part.snapshot) ultimo = part.snapshot
        }
        if (ultimo) {
          // Falla CERRADO: si el árbol del último paso ya no existe o git no puede compararlo, NO se sabe qué cambió
          // la persona después: todos los archivos cuentan como conflicto (se saltan salvo `sobrescribir`).
          const cambiados = yield* snapshot.patchEstricto(ultimo).pipe(
            Effect.map((patch) => new Set(patch.files.map(rel)) as Set<string> | undefined),
            Effect.catchTag("SnapshotExpiredError", () => Effect.succeed(undefined as Set<string> | undefined)),
          )
          conflictos = archivos.filter((item) => !cambiados || cambiados.has(item.file)).map((item) => item.file)
        }
      }
      const protegidos = rutasProtegidasActivo()
        ? archivos.filter((item) => esProtegida(item.file)).map((item) => item.file)
        : []
      const comandos = desde.some((item) => item.herramientas.some((h) => ES_COMANDO(h.tool)))
      const commits = motivo === "sin-git" ? [] : yield* snapshot.commitsSince(desde[0]!.user.time.created)
      const { bloqueado, ayudantes } = yield* bloqueos(sessionID)

      const revision: Revision = {
        archivos,
        conflictos,
        protegidos,
        comandos,
        commitsDespues: commits.map((item) => ({ hash: item.hash.slice(0, 12), asunto: item.asunto.slice(0, 120) })),
        ayudantesActivos: ayudantes,
        mensajes: mensajes.length - mensajes.findIndex((item) => item.info.id === messageID),
        restaurable: !motivo,
        ...(motivo ? { motivo } : {}),
        ...(bloqueado ? { bloqueado } : {}),
      }
      return { revision, abs, rel, ordinal: indice + 1 }
    })

    const revision: Interface["revision"] = Effect.fn("SessionRebobinar.revision")(function* (input) {
      if (!activo()) return yield* Effect.fail(apagado())
      return (yield* analizar(input.sessionID, input.messageID)).revision
    })

    const rebobinar: Interface["rebobinar"] = Effect.fn("SessionRebobinar.rebobinar")(function* (input) {
      return yield* candado(input.sessionID).withPermits(1)(rebobinarSinCandado(input))
    })

    const rebobinarSinCandado: Interface["rebobinar"] = Effect.fnUntraced(function* (input) {
      if (!activo()) return yield* Effect.fail(apagado())
      const { revision: r, abs, rel, ordinal } = yield* analizar(input.sessionID, input.messageID)
      if (r.bloqueado) return yield* Effect.fail(new Conflicto(r.bloqueado, mensajeDeBloqueo(r.bloqueado)))
      const session = yield* sessions.get(input.sessionID)
      if (input.modo !== "conversacion") {
        if (r.motivo === "sin-git" || r.motivo === "sin-instantaneas") {
          return yield* Effect.fail(
            new Conflicto(
              r.motivo,
              r.motivo === "sin-git"
                ? "Esta carpeta no usa git: solo se puede volver atrás en la conversación, no en los archivos."
                : "Las instantáneas están desactivadas en la configuración: solo se puede volver atrás en la conversación.",
            ),
          )
        }
        if (r.motivo === "caducado") {
          return yield* Effect.fail(
            new Conflicto(
              "caducado",
              "El punto de control de este turno ya no existe: solo se puede volver atrás en la conversación.",
            ),
          )
        }
        if (input.modo === "codigo" && session.revert) {
          return yield* Effect.fail(
            new Conflicto(
              "revert-pendiente",
              "Ya hay un rebobinado pendiente: deshazlo o confírmalo antes de restaurar solo el código.",
            ),
          )
        }
      }
      const forzar = new Set((input.sobrescribir ?? []).map(rel))
      const saltar = new Map<string, string>()
      for (const file of r.conflictos) if (!forzar.has(file)) saltar.set(abs(file), "conflicto")
      for (const file of r.protegidos) if (!forzar.has(file)) saltar.set(abs(file), "protegido")

      const hecho = yield* revert
        .revertir(
          { sessionID: input.sessionID, messageID: input.messageID },
          input.modo === "conversacion"
            ? { files: false }
            : {
                skip: saltar,
                soloCodigo: input.modo === "codigo",
                forzar: new Set(Array.from(forzar, (file) => abs(file))),
              },
        )
        .pipe(
          Effect.catchTag("SessionBusyError", () => Effect.fail(new Conflicto("ocupada", mensajeDeBloqueo("ocupada")))),
        )
      if (input.modo === "codigo") {
        yield* revert.guardarNota(input.sessionID, notaTexto(ordinal, hecho.restaurados.concat(hecho.borrados)))
      }
      const mensajesOcultos = input.modo === "codigo" ? 0 : r.mensajes
      return {
        modo: input.modo,
        restaurados: hecho.restaurados,
        borrados: hecho.borrados,
        omitidos: hecho.omitidos,
        mensajesOcultos,
        puedeDeshacer: true,
      }
    })

    const deshacer: Interface["deshacer"] = Effect.fn("SessionRebobinar.deshacer")(function* (input) {
      return yield* candado(input.sessionID).withPermits(1)(deshacerSinCandado(input))
    })

    const deshacerSinCandado: Interface["deshacer"] = Effect.fnUntraced(function* (input) {
      if (!activo()) return yield* Effect.fail(apagado())
      yield* sessions.get(input.sessionID)
      const ctx = yield* InstanceState.context
      const { bloqueado } = yield* bloqueos(input.sessionID)
      if (bloqueado) return yield* Effect.fail(new Conflicto(bloqueado, mensajeDeBloqueo(bloqueado)))
      if (!(yield* revert.hayQueDeshacer(input.sessionID))) {
        return yield* Effect.fail(new Conflicto("nada-que-deshacer", "No hay ningún rebobinado que deshacer."))
      }
      const forzar = new Set(
        (input.sobrescribir ?? []).map((file) => path.join(ctx.worktree, file).replaceAll("\\", "/")),
      )
      const hecho = yield* revert
        .deshacer({ sessionID: input.sessionID, sobrescribir: forzar })
        .pipe(
          Effect.catchTag("SessionBusyError", () => Effect.fail(new Conflicto("ocupada", mensajeDeBloqueo("ocupada")))),
        )
      return {
        restaurados: hecho.restaurados,
        borrados: hecho.borrados,
        omitidos: hecho.omitidos,
        conflictos: hecho.omitidos.filter((item) => item.motivo === "conflicto").map((item) => item.file),
      }
    })

    return Service.of({ revision, rebobinar, deshacer })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Session.node,
    Snapshot.node,
    Config.node,
    SessionRevert.node,
    SessionRunState.node,
    BackgroundJob.node,
    Permission.node,
    Question.node,
    McpElicitation.node,
  ],
})

export * as SessionRebobinar from "./rebobinar"
