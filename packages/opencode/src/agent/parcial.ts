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

export function marcarParcial(texto: string, maxTurns: number): string {
  const cabecera = `[PARCIAL: el ayudante llegó a su límite de ${maxTurns} turnos; lo siguiente es lo que alcanzó a hacer y puede estar incompleto.]`
  return texto.startsWith("[PARCIAL:") ? texto : `${cabecera}\n${texto}`
}
