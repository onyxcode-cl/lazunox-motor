import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION_WRITE from "./todowrite.txt"
import { Todo } from "../session/todo"
import { ShellTool } from "./shell"

export const Parameters = Schema.Struct({
  todos: Schema.mutable(Schema.Array(Todo.Info)).annotate({ description: "The updated todo list" }),
})

type Metadata = {
  todos: Todo.Info[]
}

// ---------------------------------------------------------------------------------------------------------------------
// Lazunox (2D, P09 + P35): plan ejecutable. Funciones PURAS (sin Effect) para que se prueben solas.
//   - Como mucho una tarea `in_progress` (si llegan más, se normaliza: la primera queda y las demás pasan a `pending`).
//   - `verificar` que empieza con `$ ` es un comando: al marcar la tarea `completed` se corre con la herramienta `shell`
//     usando el MISMO contexto de la llamada (permiso normal, topes del plan y del ayudante, soloLectura). Nunca hay otra vía
//     para ejecutar: si el permiso se niega, el comando no corre y la tarea queda `in_progress` (amenaza S2).
// ---------------------------------------------------------------------------------------------------------------------

export const PREFIJO_COMANDO = "$ "
/** Tope del texto de salida del comando de verificación que vuelve al modelo. */
export const SALIDA_MAX = 2000

/** El comando de un `verificar` que empieza con `$ ` (sin el prefijo). Texto libre o vacío => `undefined`. */
export function comandoDeVerificar(verificar: string | undefined): string | undefined {
  if (verificar === undefined || !verificar.startsWith(PREFIJO_COMANDO)) return undefined
  const comando = verificar.slice(PREFIJO_COMANDO.length).trim()
  return comando === "" ? undefined : comando
}

/**
 * Normaliza en vez de fallar (regresión de tokens, lazunox.11): si llegan varias `in_progress` se queda la PRIMERA y las demás pasan
 * a `pending`, con un aviso de una línea. Rechazar la llamada entera hacía que el modelo reescribiera toda la lista una y otra vez.
 */
export function normalizarEnCurso(todos: ReadonlyArray<Todo.Info>): { todos: Todo.Info[]; aviso?: string } {
  const indices = todos.flatMap((t, i) => (t.status === "in_progress" ? [i] : []))
  if (indices.length <= 1) return { todos: todos.map((t) => ({ ...t })) }
  const resto = new Set(indices.slice(1))
  return {
    todos: todos.map((t, i) => (resto.has(i) ? { ...t, status: "pending" } : { ...t })),
    aviso: `Aviso: había ${indices.length} tareas in_progress; se dejó solo «${todos[indices[0]!]!.content}» y las demás pasaron a pending.`,
  }
}

/** Salida corta de una lista sin cambios: no se repite al modelo lo que acaba de enviar. */
export function resumenLista(todos: ReadonlyArray<Todo.Info>): string {
  const n = (s: string) => todos.filter((t) => t.status === s).length
  return `Lista guardada: ${todos.length} tareas (${n("completed")} completed, ${n("in_progress")} in_progress, ${n("pending")} pending).`
}

// ---------------------------------------------------------------------------------------------------------------------
// Lazunox (6.6, H11): dependencias entre tareas de la MISMA lista. Pura. Rechaza la lista entera (nada se guarda) si hay ids
// repetidos o mal formados, más de 10 dependencias, ids inexistentes, ciclos, o una tarea `in_progress`/`completed` cuyas
// dependencias no están `completed`.
// ---------------------------------------------------------------------------------------------------------------------

export const DEPENDENCIAS_MAX = 10
const ID_VALIDO = /^[A-Za-z0-9_.-]{1,40}$/

/** `undefined` si las dependencias son válidas; si no, el motivo (siempre dice qué corregir). */
export function validarDependencias(todos: ReadonlyArray<Todo.Info>): string | undefined {
  const porId = new Map<string, number>()
  for (let i = 0; i < todos.length; i++) {
    const id = todos[i]!.id
    if (id === undefined) continue
    if (!ID_VALIDO.test(id)) return `El id «${id.slice(0, 60)}» no es válido: usa letras, números, «-», «_» o «.» (máximo 40). Corrige y vuelve a llamar a todowrite.`
    if (porId.has(id)) return `El id «${id}» está repetido en la lista: cada id debe ser único. Corrige y vuelve a llamar a todowrite.`
    porId.set(id, i)
  }
  const nombre = (i: number) => `«${todos[i]!.content}»`
  for (let i = 0; i < todos.length; i++) {
    const deps = todos[i]!.depende_de ?? []
    if (deps.length > DEPENDENCIAS_MAX)
      return `La tarea ${nombre(i)} depende de ${deps.length} tareas y el máximo es ${DEPENDENCIAS_MAX}. Agrupa o reparte el trabajo y vuelve a llamar a todowrite.`
    for (const d of deps) {
      if (!porId.has(d))
        return `La tarea ${nombre(i)} depende de «${String(d).slice(0, 60)}», que no es el id de ninguna tarea de esta lista. Dale ese id a la tarea (campo id) o quita la dependencia, y vuelve a llamar a todowrite.`
    }
  }
  // Ciclos (incluye la dependencia de una tarea consigo misma): búsqueda en profundidad con tres colores.
  const color = new Array<0 | 1 | 2>(todos.length).fill(0)
  const pila: number[] = []
  const visitar = (i: number): number[] | undefined => {
    color[i] = 1
    pila.push(i)
    for (const d of todos[i]!.depende_de ?? []) {
      const j = porId.get(d)!
      if (color[j] === 1) return [...pila.slice(pila.indexOf(j)), j]
      if (color[j] === 0) {
        const c = visitar(j)
        if (c) return c
      }
    }
    pila.pop()
    color[i] = 2
    return undefined
  }
  for (let i = 0; i < todos.length; i++) {
    if (color[i] !== 0) continue
    const ciclo = visitar(i)
    if (ciclo) return `Hay un ciclo de dependencias: ${ciclo.map(nombre).join(" -> ")}. Rompe el ciclo y vuelve a llamar a todowrite.`
  }
  // Orden: no se empieza ni se termina una tarea antes que sus dependencias.
  for (let i = 0; i < todos.length; i++) {
    const t = todos[i]!
    if (t.status !== "in_progress" && t.status !== "completed") continue
    const faltan = (t.depende_de ?? []).filter((d) => todos[porId.get(d)!]!.status !== "completed")
    if (faltan.length > 0)
      return `La tarea ${nombre(i)} está ${t.status} pero depende de tareas que aún no están completed: ${faltan.map((d) => `«${todos[porId.get(d)!]!.content}» (${d}, ${todos[porId.get(d)!]!.status})`).join(", ")}. Completa primero esas tareas (o quita la dependencia) y vuelve a llamar a todowrite.`
  }
  return undefined
}

export interface PorVerificar {
  indice: number
  comando: string
}

/**
 * Las tareas que pasan a `completed` con un comando por verificar. Una tarea que YA estaba `completed` con el mismo texto y el
 * mismo `verificar` no se vuelve a verificar al reescribir la lista (sería correr el comando en cada actualización).
 */
export function porVerificar(previas: ReadonlyArray<Todo.Info>, nuevas: ReadonlyArray<Todo.Info>): PorVerificar[] {
  const out: PorVerificar[] = []
  nuevas.forEach((todo, indice) => {
    if (todo.status !== "completed") return
    const comando = comandoDeVerificar(todo.verificar)
    if (!comando) return
    const yaHecha = previas.some(
      (p) => p.status === "completed" && p.content === todo.content && p.verificar === todo.verificar,
    )
    if (!yaHecha) out.push({ indice, comando })
  })
  return out
}

/**
 * Las tareas cuya verificación falló vuelven a `in_progress`. Como solo puede haber una, queda la primera que falló y las otras
 * `in_progress` (las que fallaron y las que el modelo ya tenía así) pasan a `pending`.
 */
export function aplicarFallos(todos: ReadonlyArray<Todo.Info>, fallos: ReadonlySet<number>): Todo.Info[] {
  if (fallos.size === 0) return todos.map((t) => ({ ...t }))
  const primero = Math.min(...fallos)
  return todos.map((t, i) => {
    if (i === primero) return { ...t, status: "in_progress" }
    if (fallos.has(i) || t.status === "in_progress") return { ...t, status: "pending" }
    return { ...t }
  })
}

/** Las tareas con comando que quedan `in_progress` hasta comprobarlas (estado provisional que se guarda antes de correr nada). */
export function provisional(todos: ReadonlyArray<Todo.Info>, pendientes: ReadonlyArray<PorVerificar>): Todo.Info[] {
  return aplicarFallos(todos, new Set(pendientes.map((p) => p.indice)))
}

const recortar = (texto: string) => (texto.length <= SALIDA_MAX ? texto : `…${texto.slice(texto.length - SALIDA_MAX)}`)

export interface ResultadoVerificacion {
  indice: number
  comando: string
  ok: boolean
  salida: string
  exit: number | null
}

/** El texto que se agrega a la salida de la herramienta con el resultado de cada verificación. */
export function informe(todos: ReadonlyArray<Todo.Info>, resultados: ReadonlyArray<ResultadoVerificacion>): string {
  if (resultados.length === 0) return ""
  const lineas = resultados.map((r) => {
    const tarea = todos[r.indice]?.content ?? `#${r.indice + 1}`
    if (r.ok) return `- «${tarea}»: verificación OK (\`${r.comando}\`, código 0). Queda completed.`
    const codigo = r.exit === null ? "sin código (tiempo agotado o cancelado)" : `código ${r.exit}`
    return `- «${tarea}»: verificación FALLÓ (\`${r.comando}\`, ${codigo}). Queda in_progress; corrige y vuelve a marcarla.\n${recortar(r.salida)}`
  })
  return `\n\nVerificación:\n${lineas.join("\n")}`
}

export const TodoWriteTool = Tool.define(
  "todowrite",
  Effect.gen(function* () {
    const todo = yield* Todo.Service
    const shellInfo = yield* ShellTool

    return () =>
      Effect.gen(function* () {
        const shell = yield* Tool.init(shellInfo)
        return {
          description: DESCRIPTION_WRITE,
          parameters: Parameters,
          execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
            Effect.gen(function* () {
              yield* ctx.ask({
                permission: "todowrite",
                patterns: ["*"],
                always: ["*"],
                metadata: {},
              })

              const { todos: entrantes, aviso } = normalizarEnCurso(params.todos)
              const dependencias = validarDependencias(entrantes)
              if (dependencias) throw new Error(dependencias)

              const previas = yield* todo.get(ctx.sessionID)
              const pendientes = porVerificar(previas, entrantes)
              let final: Todo.Info[] = entrantes
              const resultados: ResultadoVerificacion[] = []

              if (pendientes.length > 0) {
                // Estado provisional guardado ANTES de correr nada: si el permiso se niega o la llamada se cancela, la tarea
                // ya quedó en curso (nunca «hecha» sin comprobar).
                yield* todo.update({ sessionID: ctx.sessionID, todos: provisional(entrantes, pendientes) })
                // El shell recibe el contexto de ESTA llamada: mismas reglas de permiso, mismos topes y `soloLectura`. Su
                // `metadata` se anula para que su salida no pise la de la lista.
                const shellCtx = { ...ctx, metadata: () => Effect.void } as unknown as Tool.Context
                for (const p of pendientes) {
                  const r = yield* shell.execute({ command: p.comando }, shellCtx)
                  const exit = (r.metadata as { exit?: number | null }).exit ?? null
                  resultados.push({ indice: p.indice, comando: p.comando, ok: exit === 0, salida: r.output, exit })
                }
                final = aplicarFallos(entrantes, new Set(resultados.filter((r) => !r.ok).map((r) => r.indice)))
              }

              yield* todo.update({ sessionID: ctx.sessionID, todos: final })

              return {
                title: `${final.filter((x) => x.status !== "completed").length} todos`,
                // Sin cambios respecto a lo enviado (ni aviso ni verificación): solo un resumen; si no, la lista final en JSON compacto.
                output:
                  (aviso === undefined && resultados.length === 0 ? resumenLista(final) : JSON.stringify(final)) +
                  (aviso ? `\n${aviso}` : "") +
                  informe(entrantes, resultados),
                metadata: {
                  todos: final,
                },
              }
            }),
        } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
      })
  }),
)
