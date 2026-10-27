// Lazunox (Ola 7 — 7.12, decisión D3): tareas programadas y espera, atadas a la sesión. Núcleo PURO (sin Effect ni reloj propio:
// todo recibe `ahora`), pensado para probarse con un reloj falso.
//
// Semántica acotada (copia de Claude Code, sin su nube): cron de 5 campos en hora local, recurrente o de una vez; hasta 50 por
// sesión; caducan a los 7 días; solo disparan con la sesión inactiva (si está ocupada esperan al siguiente turno libre, como UN
// solo disparo atrasado); NO recuperan disparos perdidos (si pasaron más de 5 minutos del momento previsto, esa vez se salta);
// llevan un retraso aleatorio pequeño. Nada de esto aprueba permisos: el disparo es un turno normal que pasa por la puerta del plan y
// por los permisos de siempre. Lo persistente (que sobreviva a un reinicio) lo ejecuta Rutinas de la app, no el motor.

export const activo = (env: NodeJS.ProcessEnv = process.env) => env.LAZUNOX_PROGRAMADAS === "1"

export const MAX_POR_SESION = 50
export const CADUCA_MS = 7 * 24 * 3600_000
export const GRACIA_MS = 5 * 60_000
export const JITTER_MAX_MS = 30_000
export const PROMPT_MAX = 2000
export const ESPERA_MIN_S = 60
export const ESPERA_MAX_S = 3600
/** Tope de disparos de una tarea recurrente (aunque no haya caducado): una orden mal puesta no puede gastar sin límite. */
export const DISPAROS_MAX = 200

export class ErrorProgramada extends Error {}
const fallo = (m: string): never => {
  throw new ErrorProgramada(m)
}

// ------------------------------------------------------------------------------------------------ cron

type Campo = { min: number; max: number }
const CAMPOS: Campo[] = [
  { min: 0, max: 59 }, // minuto
  { min: 0, max: 23 }, // hora
  { min: 1, max: 31 }, // día del mes
  { min: 1, max: 12 }, // mes
  { min: 0, max: 7 }, // día de la semana (0 y 7 = domingo)
]
const NOMBRES = ["minuto", "hora", "día del mes", "mes", "día de la semana"]

export type Cron = {
  texto: string
  minutos: Set<number>
  horas: Set<number>
  dias: Set<number>
  meses: Set<number>
  semana: Set<number>
  diasLibres: boolean
  semanaLibre: boolean
}

function expandir(texto: string, c: Campo, nombre: string): Set<number> {
  const out = new Set<number>()
  for (const parte of texto.split(",")) {
    const m = /^(\*|\d+|\d+-\d+)(?:\/(\d+))?$/.exec(parte)
    if (!m) return fallo(`Campo de cron inválido en ${nombre}: "${parte}".`)
    const paso = m[2] === undefined ? 1 : Number(m[2])
    if (!Number.isInteger(paso) || paso < 1) return fallo(`El paso de ${nombre} debe ser un entero positivo.`)
    let desde = c.min
    let hasta = c.max
    if (m[1] !== "*") {
      const [a, b] = m[1]!.split("-")
      desde = Number(a)
      hasta = b === undefined ? (m[2] === undefined ? desde : c.max) : Number(b)
    }
    if (desde < c.min || hasta > c.max || desde > hasta) return fallo(`${nombre}: "${parte}" fuera de rango (${c.min}-${c.max}).`)
    for (let v = desde; v <= hasta; v += paso) out.add(v)
  }
  return out
}

/** Valida y compila un cron de 5 campos. Sin nombres (JAN, MON) ni atajos (@daily): lo que no se entiende se rechaza. */
export function parsearCron(texto: string): Cron {
  const campos = texto.trim().split(/\s+/)
  if (campos.length !== 5) return fallo(`El cron debe tener 5 campos (minuto hora día-del-mes mes día-de-la-semana); trae ${campos.length}.`)
  const [min, hora, dia, mes, sem] = campos.map((t, i) => expandir(t, CAMPOS[i]!, NOMBRES[i]!)) as Set<number>[]
  const semana = new Set([...sem!].map((d) => (d === 7 ? 0 : d)))
  return {
    texto: campos.join(" "),
    minutos: min!,
    horas: hora!,
    dias: dia!,
    meses: mes!,
    semana,
    diasLibres: campos[2] === "*",
    semanaLibre: campos[4] === "*",
  }
}

function coincideDia(c: Cron, d: Date): boolean {
  const dom = c.dias.has(d.getDate())
  const dow = c.semana.has(d.getDay())
  // Cron clásico: si ambos están restringidos, basta con que coincida uno.
  if (!c.diasLibres && !c.semanaLibre) return dom || dow
  return dom && dow
}

/** Siguiente instante (estrictamente posterior a `desde`, a minuto exacto, hora local) en que el cron dispara. `undefined` si no hay en 5 años. */
export function proximoCron(c: Cron, desde: number): number | undefined {
  const t = new Date(desde)
  t.setSeconds(0, 0)
  t.setMinutes(t.getMinutes() + 1)
  const limite = desde + 5 * 366 * 24 * 3600_000
  for (let i = 0; i < 200_000 && t.getTime() <= limite; i++) {
    if (!c.meses.has(t.getMonth() + 1)) {
      t.setMonth(t.getMonth() + 1, 1)
      t.setHours(0, 0, 0, 0)
      continue
    }
    if (!coincideDia(c, t)) {
      t.setDate(t.getDate() + 1)
      t.setHours(0, 0, 0, 0)
      continue
    }
    if (!c.horas.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0)
      continue
    }
    if (!c.minutos.has(t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1, 0, 0)
      continue
    }
    return t.getTime()
  }
  return undefined
}

// ------------------------------------------------------------------------------------------------ registro

export type Tarea = {
  id: string
  /** Texto del cron; ausente en las esperas (`esperar_y_continuar`). */
  cron?: string
  tipo: "recurrente" | "una_vez" | "espera"
  prompt: string
  creado: number
  caduca: number
  /** Instante previsto del próximo disparo (ya con el retraso aleatorio). */
  proximo: number
  disparos: number
}

const registros = new Map<string, Map<string, Tarea>>()
const SESIONES_MAX = 500

const de = (sessionID: string) => {
  let r = registros.get(sessionID)
  if (!r) {
    if (registros.size >= SESIONES_MAX) registros.delete(registros.keys().next().value!)
    r = new Map()
    registros.set(sessionID, r)
  }
  return r
}

export const reiniciarParaPruebas = () => registros.clear()
export const sesionesConTareas = () => [...registros].filter(([, r]) => r.size > 0).map(([id]) => id)

const retraso = (rng: () => number) => Math.floor(rng() * JITTER_MAX_MS)
const idNuevo = (usados: Map<string, Tarea>) => {
  for (let i = 0; i < 100; i++) {
    const id = crypto.randomUUID().replaceAll("-", "").slice(0, 8)
    if (!usados.has(id)) return id
  }
  return fallo("No se pudo generar un id único.")
}

function validarPrompt(prompt: unknown): string {
  if (typeof prompt !== "string" || prompt.trim() === "") return fallo("Falta el texto de lo que hay que hacer en cada disparo.")
  if (prompt.length > PROMPT_MAX) return fallo(`El texto supera ${PROMPT_MAX} caracteres.`)
  return prompt.trim()
}

export function programar(
  sessionID: string,
  input: { cron: string; prompt: string; unaVez?: boolean },
  ahora: number,
  rng: () => number = Math.random,
): Tarea {
  const prompt = validarPrompt(input.prompt)
  const cron = parsearCron(input.cron)
  const r = de(sessionID)
  limpiarCaducadas(sessionID, ahora)
  if (r.size >= MAX_POR_SESION) return fallo(`Ya hay ${MAX_POR_SESION} tareas programadas en esta sesión; borra alguna antes (borrar_programada).`)
  const base = proximoCron(cron, ahora)
  if (base === undefined) return fallo("Ese cron no vuelve a disparar en los próximos años.")
  const t: Tarea = {
    id: idNuevo(r),
    cron: cron.texto,
    tipo: input.unaVez ? "una_vez" : "recurrente",
    prompt,
    creado: ahora,
    caduca: ahora + CADUCA_MS,
    proximo: base + retraso(rng),
    disparos: 0,
  }
  r.set(t.id, t)
  return { ...t }
}

/** `esperar_y_continuar`: un solo disparo entre 60 s y 1 h. Cuenta como una tarea más (mismo tope y misma caducidad). */
export function esperar(sessionID: string, input: { segundos: number; prompt: string }, ahora: number, rng: () => number = Math.random): Tarea {
  const prompt = validarPrompt(input.prompt)
  if (!Number.isFinite(input.segundos) || input.segundos < ESPERA_MIN_S || input.segundos > ESPERA_MAX_S)
    return fallo(`La espera debe estar entre ${ESPERA_MIN_S} y ${ESPERA_MAX_S} segundos.`)
  const r = de(sessionID)
  limpiarCaducadas(sessionID, ahora)
  if (r.size >= MAX_POR_SESION) return fallo(`Ya hay ${MAX_POR_SESION} tareas programadas en esta sesión; borra alguna antes.`)
  const t: Tarea = {
    id: idNuevo(r),
    tipo: "espera",
    prompt,
    creado: ahora,
    caduca: ahora + CADUCA_MS,
    proximo: ahora + Math.floor(input.segundos * 1000) + Math.floor(rng() * 5000),
    disparos: 0,
  }
  r.set(t.id, t)
  return { ...t }
}

export function limpiarCaducadas(sessionID: string, ahora: number) {
  const r = registros.get(sessionID)
  if (!r) return
  for (const [id, t] of r) if (t.caduca <= ahora) r.delete(id)
}

export function listar(sessionID: string, ahora: number): Tarea[] {
  limpiarCaducadas(sessionID, ahora)
  return [...(registros.get(sessionID)?.values() ?? [])].map((t) => ({ ...t })).sort((a, b) => a.proximo - b.proximo)
}

export function borrar(sessionID: string, id: string): boolean {
  return registros.get(sessionID)?.delete(id) ?? false
}

export function borrarTodas(sessionID: string): number {
  const n = registros.get(sessionID)?.size ?? 0
  registros.delete(sessionID)
  return n
}

export type Vencida = { sessionID: string; tarea: Tarea }

/**
 * Lo que toca disparar ahora. `libre(sessionID)` dice si la sesión está inactiva: si no, la tarea espera (sigue vencida) al siguiente
 * turno libre. Una tarea cuyo momento previsto pasó hace más de GRACIA_MS NO se dispara tarde: esa vez se pierde y se calcula la
 * siguiente (las de una vez y las esperas, que no tienen siguiente, se borran). Devuelve las tareas a disparar ya avanzadas.
 */
export function vencidas(ahora: number, libre: (sessionID: string) => boolean, rng: () => number = Math.random): Vencida[] {
  const out: Vencida[] = []
  for (const [sessionID, r] of registros) {
    for (const t of [...r.values()]) {
      if (t.caduca <= ahora) {
        r.delete(t.id)
        continue
      }
      if (t.proximo > ahora) continue
      if (ahora - t.proximo > GRACIA_MS) {
        // Disparo perdido: no se recupera.
        avanzar(r, t, ahora, rng)
        continue
      }
      if (!libre(sessionID)) continue
      out.push({ sessionID, tarea: { ...t } })
      t.disparos++
      avanzar(r, t, ahora, rng)
    }
  }
  return out
}

/** Deja la tarea lista para su siguiente vez; las de una vez, las esperas y las que llegaron al tope se borran. `false` = borrada. */
function avanzar(r: Map<string, Tarea>, t: Tarea, ahora: number, rng: () => number): boolean {
  if (t.tipo !== "recurrente" || t.disparos >= DISPAROS_MAX) {
    r.delete(t.id)
    return false
  }
  const sig = proximoCron(parsearCron(t.cron!), ahora)
  if (sig === undefined) {
    r.delete(t.id)
    return false
  }
  t.proximo = sig + retraso(rng)
  return true
}

// ------------------------------------------------------------------------------------------------ texto del disparo

const neutral = (t: string) => t.replace(/<(\/?)(tarea_programada|system-reminder)\b/gi, "<​$1$2")

/**
 * Lo que recibe el modelo en el disparo. Es un turno sintético, NO un mensaje nuevo de la persona: lo escribió el propio modelo (o la
 * persona, a través de él) al programarlo, así que se presenta como tal, sin darle más autoridad que a cualquier otro turno.
 */
export function textoDisparo(t: Pick<Tarea, "id" | "tipo" | "cron" | "prompt" | "disparos">, ahora: number): string {
  const cuando = new Date(ahora).toISOString()
  return [
    `<tarea_programada id="${t.id}" tipo="${t.tipo}"${t.cron ? ` cron="${t.cron}"` : ""} disparo="${t.disparos + 1}" hora="${cuando}">`,
    "Esto es un aviso automático de una tarea que se programó antes en esta sesión. No es un mensaje nuevo de la persona ni una autorización:",
    "los permisos y las reglas de siempre aplican, y si la persona cambió de idea o la tarea ya no tiene sentido, dilo y bórrala con borrar_programada.",
    "Lo que se pidió hacer:",
    neutral(t.prompt),
    "</tarea_programada>",
  ].join("\n")
}

export * as Programadas from "./programadas"
