// Lazunox (2D, P35): progreso por turno. Módulo PURO (sin Effect, sin disco): a partir de los turnos que arma `agrupar` en
// `session/turnos.ts` dice si cada turno AVANZÓ o no, para que el modo objetivo (3A) marque `bloqueado` tras N turnos sin avance.
//
// Un turno avanza si cumple AL MENOS UNA de estas señales (todas salen de lo que ya quedó en los mensajes, no de lo que el
// modelo dice que hizo):
//   - archivos: algún parche del turno tocó archivos (la herramienta de edición dejó una parte `patch` con `files`).
//   - tareas: el número de tareas `completed` de la última lista guardada con éxito por `todowrite` en ese turno SUBIÓ respecto
//     a la última lista conocida de turnos anteriores. Se lee de `metadata.todos` de la herramienta (la lista FINAL: una tarea
//     cuya verificación falló ya viene como `in_progress`, así que no cuenta).
// Una orden de solo lectura (un `ls`) NO cuenta como avance: solo archivos y tareas.
import type { TurnoDatos } from "./turnos"

export const TURNOS_SIN_AVANCE = 3

export interface ProgresoTurno {
  messageID: string
  archivos: number
  completadas: number
  nuevasCompletadas: number
  huboProgreso: boolean
  motivos: Array<"archivos" | "tareas">
}

interface TodoMin {
  status?: unknown
}

/** Las tareas de la última llamada a `todowrite` COMPLETADA con éxito en el turno (o `undefined` si no hubo). */
export function ultimaListaDelTurno(turno: Pick<TurnoDatos, "mensajes">): TodoMin[] | undefined {
  let lista: TodoMin[] | undefined
  for (const mensaje of turno.mensajes) {
    if (mensaje.info.role !== "assistant") continue
    for (const part of mensaje.parts) {
      if (part.type !== "tool" || part.tool !== "todowrite") continue
      const state = part.state as { status?: string; metadata?: { todos?: unknown } }
      if (state.status !== "completed") continue
      const todos = state.metadata?.todos
      if (Array.isArray(todos)) lista = todos as TodoMin[]
    }
  }
  return lista
}

const contarCompletadas = (lista: TodoMin[]) => lista.filter((t) => t?.status === "completed").length

/** Un registro por turno, en el mismo orden que `turnos`. */
export function progresoPorTurno(turnos: ReadonlyArray<TurnoDatos>): ProgresoTurno[] {
  let anterior = 0
  return turnos.map((turno) => {
    const archivos = turno.parches.reduce((n, p) => n + p.files.length, 0)
    const lista = ultimaListaDelTurno(turno)
    const completadas = lista ? contarCompletadas(lista) : anterior
    const nuevasCompletadas = Math.max(0, completadas - anterior)
    if (lista) anterior = completadas
    const motivos: ProgresoTurno["motivos"] = []
    if (archivos > 0) motivos.push("archivos")
    if (nuevasCompletadas > 0) motivos.push("tareas")
    return {
      messageID: turno.user.id,
      archivos,
      completadas,
      nuevasCompletadas,
      huboProgreso: motivos.length > 0,
      motivos,
    }
  })
}

/** Cuántos turnos seguidos, contando desde el último, no tuvieron progreso. */
export function turnosSinProgreso(progreso: ReadonlyArray<Pick<ProgresoTurno, "huboProgreso">>): number {
  let n = 0
  for (let i = progreso.length - 1; i >= 0 && !progreso[i]!.huboProgreso; i--) n++
  return n
}

/** `true` si los últimos `umbral` turnos (3 por defecto) no avanzaron. Con menos turnos que el umbral nunca está bloqueado. */
export function estaBloqueado(
  progreso: ReadonlyArray<Pick<ProgresoTurno, "huboProgreso">>,
  umbral: number = TURNOS_SIN_AVANCE,
): boolean {
  return umbral > 0 && progreso.length >= umbral && turnosSinProgreso(progreso) >= umbral
}

export * as SessionProgreso from "./progreso"
