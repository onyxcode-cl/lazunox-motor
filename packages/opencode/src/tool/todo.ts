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
//   - Como mucho una tarea `in_progress`.
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

/** `undefined` si la lista es válida; si no, el motivo (más de una tarea `in_progress`). */
export function validarEnCurso(todos: ReadonlyArray<Todo.Info>): string | undefined {
  const en = todos.filter((t) => t.status === "in_progress")
  if (en.length <= 1) return undefined
  return `Solo una tarea puede estar in_progress a la vez y hay ${en.length}: ${en.map((t) => `«${t.content}»`).join(", ")}. Deja una sola in_progress y vuelve a llamar a todowrite.`
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

              const invalida = validarEnCurso(params.todos)
              if (invalida) throw new Error(invalida)

              const previas = yield* todo.get(ctx.sessionID)
              const pendientes = porVerificar(previas, params.todos)
              let final: Todo.Info[] = params.todos.map((t) => ({ ...t }))
              const resultados: ResultadoVerificacion[] = []

              if (pendientes.length > 0) {
                // Estado provisional guardado ANTES de correr nada: si el permiso se niega o la llamada se cancela, la tarea
                // ya quedó en curso (nunca «hecha» sin comprobar).
                yield* todo.update({ sessionID: ctx.sessionID, todos: provisional(params.todos, pendientes) })
                // El shell recibe el contexto de ESTA llamada: mismas reglas de permiso, mismos topes y `soloLectura`. Su
                // `metadata` se anula para que su salida no pise la de la lista.
                const shellCtx = { ...ctx, metadata: () => Effect.void } as unknown as Tool.Context
                for (const p of pendientes) {
                  const r = yield* shell.execute({ command: p.comando }, shellCtx)
                  const exit = (r.metadata as { exit?: number | null }).exit ?? null
                  resultados.push({ indice: p.indice, comando: p.comando, ok: exit === 0, salida: r.output, exit })
                }
                final = aplicarFallos(params.todos, new Set(resultados.filter((r) => !r.ok).map((r) => r.indice)))
              }

              yield* todo.update({ sessionID: ctx.sessionID, todos: final })

              return {
                title: `${final.filter((x) => x.status !== "completed").length} todos`,
                output: JSON.stringify(final, null, 2) + informe(params.todos, resultados),
                metadata: {
                  todos: final,
                },
              }
            }),
        } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
      })
  }),
)
