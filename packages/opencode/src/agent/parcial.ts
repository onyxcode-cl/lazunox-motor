/**
 * Lazunox (2A, P06): `max_turns` marca la salida «parcial».
 *
 * Un ayudante con `max_turns` (= `steps` del agente) recibe en su último turno la orden de responder solo con texto
 * (`MAX_STEPS_PROMPT`, session/prompt.ts). Si llegó a ese tope, el informe que recibe el padre debe decir que está
 * incompleto, para que no lo tome por un trabajo terminado. Pura: la usa la herramienta `task` con el número de turnos
 * del asistente (un mensaje de asistente por turno) de la sesión del ayudante.
 */
export function esParcial(input: { maxTurns?: number; turnosDados: number }): boolean {
  const tope = input.maxTurns
  return tope !== undefined && Number.isFinite(tope) && tope > 0 && input.turnosDados >= tope
}

/**
 * Lazunox (Ola 7, 7.10): con `taskId` la cabecera dice cómo continuarlo (`task` con ese `task_id` retoma la MISMA sesión del ayudante,
 * con todo su historial y sin ampliar sus permisos). El `taskId` lo pone el motor (un id de sesión), nunca el ayudante.
 */
export function marcarParcial(texto: string, maxTurns: number, taskId?: string): string {
  const seguir = taskId ? ` Para continuarlo, llama a task con task_id "${taskId}" y dile qué falta.` : ""
  const cabecera = `[PARCIAL: el ayudante llegó a su límite de ${maxTurns} turnos; lo siguiente es lo que alcanzó a hacer y puede estar incompleto.${seguir}]`
  return texto.startsWith("[PARCIAL:") ? texto : `${cabecera}\n${texto}`
}

/**
 * Lazunox (Ola 7, 7.10, idea de OpenCode 2.x): en el ÚLTIMO paso permitido el motor ya añadía el aviso de pasos agotados, pero
 * dejaba las herramientas en modo automático: un modelo que las llamaba igual alargaba el bucle más allá del tope. Ahora, además,
 * fuerza `toolChoice: "none"` SIN quitar la lista de herramientas (para no romper la caché del prompt).
 * `LAZUNOX_ULTIMO_PASO_SIN_HERRAMIENTAS=0` lo apaga.
 */
export const ultimoPasoSinHerramientas = (env: NodeJS.ProcessEnv = process.env) => env.LAZUNOX_ULTIMO_PASO_SIN_HERRAMIENTAS !== "0"
