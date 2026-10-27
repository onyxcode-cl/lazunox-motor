// Lazunox (Ola 7 — 7.9): diferencias de instrucciones por hash con LÍNEA BASE FIJA (idea de OpenCode 2.x).
//
// Antes: el motor releía AGENTS.md/CLAUDE.md y la lista de habilidades en cada paso y los ponía en el prompt del sistema. Si el
// archivo cambiaba a mitad de sesión, el sistema cambiaba entero (se perdía la caché del prompt) y, además, el modelo no tenía
// ninguna señal de que algo había cambiado: la regla vieja seguía repetida en su propio historial (banco T29: 2 de 3 fallan).
// Ahora, por sesión: el sistema se queda con la línea base (la primera lectura), y cuando una fuente cambia se persiste UN aviso
// con SOLO lo añadido, cambiado o quitado, en el mensaje de la persona en curso (como el aviso 6.7). La línea base no se mueve,
// así el prefijo de la caché no cambia. Tras compactar (cambia el primer mensaje visible) se toma una línea base nueva.
// `LAZUNOX_INSTRUCCIONES_DIFF=0` lo apaga (vuelve a releer todo en el sistema).
import { createHash } from "crypto"
import { structuredPatch } from "diff"

export const activo = (env: NodeJS.ProcessEnv = process.env) => env.LAZUNOX_INSTRUCCIONES_DIFF !== "0"

export const DIFF_MAX_BYTES_ARCHIVO = 4096
export const AVISO_MAX_BYTES = 12 * 1024
const SESIONES_MAX = 500
const CIERRE = "</aviso-instrucciones>"

type Fuente = { texto: string; hash: string }
type Estado = {
  epoca: string
  /** Lo que lleva el sistema (no se mueve dentro de una época). */
  base: string[]
  baseSkills: string | undefined
  /** Última versión que el modelo ya conoce (la línea base, o lo que dijo el último aviso). */
  conocido: Map<string, Fuente>
  conocidoSkills: Map<string, string>
  fuentesBase: Map<string, Fuente>
  skillsBase: Map<string, string>
  /** Mensaje de la persona donde se persistió el último aviso: si desaparece (rebobinar), se vuelve a avisar. */
  anunciadoEn?: string
}

const estados = new Map<string, Estado>()

export const huella = (texto: string) => createHash("sha256").update(texto).digest("hex")

/** Clave estable de cada entrada de `Instruction.system()`: su primera línea («Instructions from: <origen>»). */
function claves(entradas: readonly string[]) {
  const vistas = new Map<string, number>()
  return entradas.map((texto) => {
    const base = texto.split("\n", 1)[0]!
    const n = vistas.get(base) ?? 0
    vistas.set(base, n + 1)
    return { clave: n === 0 ? base : `${base} #${n + 1}`, texto }
  })
}

const fuentes = (entradas: readonly string[]) =>
  new Map(claves(entradas).map((e) => [e.clave, { texto: e.texto, hash: huella(e.texto) } as Fuente]))

/** Nombres y descripciones de la lista de habilidades (`<skill><name>…<description>…`). */
export function habilidadesDe(texto: string | undefined): Map<string, string> {
  const out = new Map<string, string>()
  if (!texto) return out
  for (const m of texto.matchAll(/<skill>\s*<name>([\s\S]*?)<\/name>\s*<description>([\s\S]*?)<\/description>/g)) out.set(m[1]!.trim(), m[2]!.trim())
  return out
}

const cuerpo = (entrada: string) => entrada.slice(entrada.indexOf("\n") + 1)
const origen = (clave: string) => clave.replace(/^Instructions from: /, "")

function recortar(texto: string, max: number) {
  if (Buffer.byteLength(texto, "utf-8") <= max) return texto
  const b = Buffer.from(texto, "utf-8").subarray(0, max).toString("utf-8").replace(/\uFFFD$/, "")
  return `${b}\n[…recortado; lee el archivo si necesitas el resto]`
}

/** Líneas añadidas (+) y quitadas (−) entre dos versiones, con una línea de contexto. */
export function diferencia(antes: string, despues: string): string {
  const parche = structuredPatch("a", "b", antes, despues, "", "", { context: 1 })
  return parche.hunks
    .map((h) => [`@@ línea ${h.newStart} @@`, ...h.lines.filter((l) => !l.startsWith("\\"))].join("\n"))
    .join("\n")
}

const sinCierre = (t: string) => t.replaceAll(CIERRE, "</aviso-instrucciones >")

export type PasoEntrada = {
  sessionID: string
  /** Id del primer mensaje visible del historial: cambia cuando se compacta. */
  epoca: string
  instrucciones: readonly string[]
  habilidades?: string
  /** Ids de los mensajes visibles (para saber si un aviso anterior sigue en el historial). */
  visibles?: ReadonlySet<string>
}
export type PasoSalida = { sistema: string[]; habilidades: string | undefined; aviso?: string }

/** Calcula el sistema (línea base) y, si algo cambió desde lo último que el modelo conoce, el aviso con las diferencias. */
export function paso(entrada: PasoEntrada): PasoSalida {
  const actuales = fuentes(entrada.instrucciones)
  const skillsActuales = habilidadesDe(entrada.habilidades)
  let e = estados.get(entrada.sessionID)
  if (!e || e.epoca !== entrada.epoca) {
    e = {
      epoca: entrada.epoca,
      base: [...entrada.instrucciones],
      baseSkills: entrada.habilidades,
      conocido: actuales,
      conocidoSkills: skillsActuales,
      fuentesBase: actuales,
      skillsBase: skillsActuales,
    }
    estados.delete(entrada.sessionID)
    estados.set(entrada.sessionID, e)
    if (estados.size > SESIONES_MAX) estados.delete(estados.keys().next().value!)
    return { sistema: e.base, habilidades: e.baseSkills }
  }
  if (e.anunciadoEn && entrada.visibles && !entrada.visibles.has(e.anunciadoEn)) {
    // El mensaje con el aviso ya no está (rebobinar): el modelo vuelve a conocer solo la línea base.
    e.conocido = e.fuentesBase
    e.conocidoSkills = e.skillsBase
    e.anunciadoEn = undefined
  }
  const aviso = construirAviso(e, actuales, skillsActuales)
  if (aviso) {
    e.conocido = actuales
    e.conocidoSkills = skillsActuales
  }
  return { sistema: e.base, habilidades: e.baseSkills, ...(aviso ? { aviso } : {}) }
}

function construirAviso(e: Estado, actuales: Map<string, Fuente>, skills: Map<string, string>): string | undefined {
  const bloques: string[] = []
  for (const [clave, ahora] of actuales) {
    const antes = e.conocido.get(clave)
    if (!antes) {
      bloques.push(`- NUEVO ${origen(clave)}:\n${recortar(cuerpo(ahora.texto), DIFF_MAX_BYTES_ARCHIVO)}`)
    } else if (antes.hash !== ahora.hash) {
      bloques.push(`- CAMBIÓ ${origen(clave)} (+ añadido, - quitado):\n${recortar(diferencia(cuerpo(antes.texto), cuerpo(ahora.texto)), DIFF_MAX_BYTES_ARCHIVO)}`)
    }
  }
  for (const clave of e.conocido.keys()) {
    if (!actuales.has(clave)) bloques.push(`- YA NO EXISTE ${origen(clave)}: ignora lo que decía el prompt del sistema sobre ese archivo.`)
  }
  const nuevas = [...skills].filter(([n]) => !e.conocidoSkills.has(n))
  const quitadas = [...e.conocidoSkills.keys()].filter((n) => !skills.has(n))
  if (nuevas.length) bloques.push(`- HABILIDADES NUEVAS (cárgalas con la herramienta skill si la tarea encaja):\n${nuevas.map(([n, d]) => `  ${n}: ${d.slice(0, 200)}`).join("\n")}`)
  if (quitadas.length) bloques.push(`- HABILIDADES QUE YA NO ESTÁN DISPONIBLES: ${quitadas.join(", ")}`)
  if (bloques.length === 0) return undefined
  const texto = recortar(
    [
      "<aviso-instrucciones>",
      "Las instrucciones del proyecto cambiaron durante esta sesión. Lo que sigue sustituye, desde ahora, a lo que decía el prompt del sistema sobre esas fuentes; aplícalo aunque el historial anterior diga otra cosa.",
      sinCierre(bloques.join("\n")),
      CIERRE,
    ].join("\n"),
    AVISO_MAX_BYTES,
  )
  return texto.endsWith(CIERRE) ? texto : texto + "\n" + CIERRE
}

/** Apunta dónde quedó persistido el último aviso. */
export const anunciadoEn = (sessionID: string, messageID: string) => {
  const e = estados.get(sessionID)
  if (e) e.anunciadoEn = messageID
}

/** Para pruebas y para olvidar una sesión borrada. */
export const olvidar = (sessionID: string) => void estados.delete(sessionID)
export const _estado = (sessionID: string) => estados.get(sessionID)

export * as InstruccionesDiff from "./instrucciones-diff"
