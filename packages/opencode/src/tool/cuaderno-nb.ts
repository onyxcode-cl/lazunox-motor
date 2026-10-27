// Lazunox (Ola 7 — 7.15): núcleo puro de `cuaderno_editar`. Edita el JSON de un cuaderno Jupyter (.ipynb, nbformat 4) sin
// ejecutar nada. Valida antes y después, conserva metadatos, versión de formato, orden de claves y las salidas de las celdas
// que no toca. Sin dependencias del motor para poder probarlo solo.

export const MAX_BYTES_CUADERNO = 20 * 1024 * 1024
export const MAX_BYTES_CONTENIDO = 1024 * 1024
export const TIPOS = ["code", "markdown", "raw"] as const
export type TipoCelda = (typeof TIPOS)[number]

export type Operacion = {
  operacion: "reemplazar" | "insertar" | "borrar"
  celdaId?: string
  indice?: number
  tipo?: TipoCelda
  contenido?: string
}

type Celda = Record<string, unknown>
type Cuaderno = Record<string, unknown> & { cells: Celda[] }

export type Resultado = {
  texto: string
  resumen: string
  /** Texto legible de la celda (o de las celdas) antes y después, para el diff que ve la persona. */
  antes: string
  despues: string
  normalizado: boolean
}

export const activo = (env: NodeJS.ProcessEnv = process.env) => env.LAZUNOX_CUADERNO !== "0"

export class ErrorCuaderno extends Error {}
const fallo = (mensaje: string): never => {
  throw new ErrorCuaderno(mensaje)
}

const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

export function fuente(celda: Celda): string {
  const s = celda.source
  return Array.isArray(s) ? s.join("") : typeof s === "string" ? s : ""
}

/** Lista de líneas con su salto final, como las escribe Jupyter. */
export function aLineas(texto: string): string[] {
  return texto === "" ? [] : texto.split(/(?<=\n)/)
}

function validar(nb: unknown, cuando: "antes" | "despues"): Cuaderno {
  const donde = cuando === "antes" ? "El archivo no es un cuaderno Jupyter válido" : "El resultado de la edición no es un cuaderno válido (no se escribió nada)"
  if (!esObjeto(nb)) return fallo(`${donde}: la raíz no es un objeto JSON.`)
  if (!Array.isArray(nb.cells)) return fallo(`${donde}: falta la lista "cells".`)
  if (nb.nbformat !== 4) return fallo(`${donde}: solo se admite nbformat 4 (este trae ${JSON.stringify(nb.nbformat)}).`)
  const ids = new Set<string>()
  nb.cells.forEach((c, i) => {
    if (!esObjeto(c)) return fallo(`${donde}: la celda ${i} no es un objeto.`)
    if (typeof c.cell_type !== "string" || !(TIPOS as readonly string[]).includes(c.cell_type))
      return fallo(`${donde}: la celda ${i} tiene cell_type ${JSON.stringify(c.cell_type)} (se esperaba code, markdown o raw).`)
    if (typeof c.source !== "string" && !(Array.isArray(c.source) && c.source.every((l) => typeof l === "string")))
      return fallo(`${donde}: la celda ${i} no tiene "source" de texto.`)
    if (typeof c.id === "string") {
      if (ids.has(c.id)) return fallo(`${donde}: el id de celda "${c.id}" está repetido.`)
      ids.add(c.id)
    }
  })
  return nb as Cuaderno
}

/** Sangría del JSON original (Jupyter usa 1 espacio); tabulador o N espacios si es lo que trae. */
function sangria(texto: string): string | number {
  const m = /^\{\r?\n([ \t]+)"/.exec(texto)
  if (!m) return 1
  return m[1]!.includes("\t") ? "\t" : m[1]!.length
}

const ENTERO_GRANDE = /(?<![\w."\\-])-?\d{16,}(?![\w."])/

function resolver(nb: Cuaderno, op: Operacion, necesario: boolean): number | undefined {
  const tieneId = op.celdaId !== undefined && op.celdaId !== ""
  const tieneIdx = op.indice !== undefined
  if (tieneId && tieneIdx) {
    const porId = nb.cells.findIndex((c) => c.id === op.celdaId)
    if (porId !== op.indice) return fallo(`"celdaId" (${op.celdaId}) y "indice" (${op.indice}) apuntan a celdas distintas. Manda solo uno de los dos.`)
  }
  if (tieneId) {
    const hallados = nb.cells.flatMap((c, i) => (c.id === op.celdaId ? [i] : []))
    if (hallados.length === 0)
      return fallo(`No hay ninguna celda con id "${op.celdaId}". Ids presentes: ${nb.cells.map((c) => c.id).filter((x) => typeof x === "string").slice(0, 20).join(", ") || "(el cuaderno no usa ids; usa indice)"}.`)
    return hallados[0]
  }
  if (tieneIdx) {
    if (!Number.isInteger(op.indice)) return fallo(`"indice" debe ser un entero (0 = primera celda).`)
    return op.indice
  }
  if (necesario) return fallo(`Indica la celda con "celdaId" o con "indice" (0 = primera celda; el cuaderno tiene ${nb.cells.length}).`)
  return undefined
}

function celdaNueva(nb: Cuaderno, tipo: TipoCelda, contenido: string): Celda {
  const menor = typeof nb.nbformat_minor === "number" ? nb.nbformat_minor : 0
  const usados = new Set(nb.cells.map((c) => c.id))
  const id = menor >= 5 ? nuevoId(usados) : undefined
  return {
    cell_type: tipo,
    ...(tipo === "code" ? { execution_count: null } : {}),
    ...(id ? { id } : {}),
    metadata: {},
    ...(tipo === "code" ? { outputs: [] } : {}),
    source: aLineas(contenido),
  }
}

function nuevoId(usados: Set<unknown>) {
  for (let i = 0; i < 1000; i++) {
    const id = crypto.randomUUID().replaceAll("-", "").slice(0, 8)
    if (!usados.has(id)) return id
  }
  return fallo("No se pudo generar un id de celda único.")
}

function describir(celda: Celda | undefined, indice: number) {
  if (!celda) return ""
  const id = typeof celda.id === "string" ? ` id=${celda.id}` : ""
  return `# %% celda ${indice} [${String(celda.cell_type)}]${id}\n${fuente(celda)}`
}

export function editarCuaderno(original: string, op: Operacion): Resultado {
  if (Buffer.byteLength(original, "utf-8") > MAX_BYTES_CUADERNO)
    return fallo(`El cuaderno pesa más de ${MAX_BYTES_CUADERNO / 1024 / 1024} MB; no se edita con esta herramienta (usa un script con nbformat).`)
  if (op.contenido !== undefined && Buffer.byteLength(op.contenido, "utf-8") > MAX_BYTES_CONTENIDO)
    return fallo(`El contenido de la celda supera ${MAX_BYTES_CONTENIDO / 1024} KB; divídelo en varias celdas.`)
  if (!["reemplazar", "insertar", "borrar"].includes(op.operacion)) return fallo(`"operacion" debe ser reemplazar, insertar o borrar.`)
  if (op.tipo !== undefined && !(TIPOS as readonly string[]).includes(op.tipo)) return fallo(`"tipo" debe ser code, markdown o raw.`)

  let crudo: unknown
  try {
    crudo = JSON.parse(original)
  } catch (e) {
    return fallo(`El archivo no es JSON válido (${e instanceof Error ? e.message : String(e)}). No se tocó.`)
  }
  const nb = validar(crudo, "antes")
  // Un entero de 16+ dígitos pierde precisión al pasar por JSON.parse/stringify: se rechaza antes de reescribir.
  if (ENTERO_GRANDE.test(original))
    return fallo(`El cuaderno trae enteros de 16 o más dígitos que se corromperían al reescribirlo. No se tocó; edítalo con un script de nbformat.`)

  const nl = original.includes("\r\n") ? "\r\n" : "\n"
  const sang = sangria(original)
  const serializar = (x: unknown) => {
    const t = JSON.stringify(x, null, sang)
    return (nl === "\r\n" ? t.replaceAll("\n", "\r\n") : t) + (/\r?\n$/.test(original) ? nl : "")
  }
  const normalizado = serializar(nb) !== original

  const celdas = nb.cells
  const n = celdas.length
  let antes = ""
  let despues = ""
  let resumen = ""
  let tocadas: number[] = []

  if (op.operacion === "reemplazar") {
    if (op.contenido === undefined) return fallo(`"reemplazar" necesita "contenido" (puede ser vacío).`)
    const i = resolver(nb, op, true)!
    if (i < 0 || i >= n) return fallo(`indice ${i} fuera de rango: el cuaderno tiene ${n} celdas (0..${n - 1}).`)
    const vieja = celdas[i]!
    antes = describir(vieja, i)
    const tipoNuevo = op.tipo ?? (vieja.cell_type as TipoCelda)
    const cambiaFuente = fuente(vieja) !== op.contenido
    const nueva: Celda = { ...vieja, cell_type: tipoNuevo }
    nueva.source = Array.isArray(vieja.source) || typeof vieja.source !== "string" ? aLineas(op.contenido) : op.contenido
    if (tipoNuevo !== "code") {
      delete nueva.outputs
      delete nueva.execution_count
    } else if (vieja.cell_type !== "code") {
      nueva.execution_count = null
      nueva.outputs = []
    } else if (cambiaFuente) {
      // Las salidas de un código que cambió ya no le corresponden.
      nueva.execution_count = null
      nueva.outputs = []
    }
    celdas[i] = nueva
    despues = describir(nueva, i)
    tocadas = [i]
    resumen = `Reemplazada la celda ${i}${typeof nueva.id === "string" ? ` (id ${nueva.id})` : ""} [${tipoNuevo}]${tipoNuevo === "code" && vieja.cell_type === "code" && cambiaFuente ? "; sus salidas anteriores se borraron porque el código cambió" : ""}.`
  } else if (op.operacion === "insertar") {
    if (op.contenido === undefined) return fallo(`"insertar" necesita "contenido".`)
    const tieneId = op.celdaId !== undefined && op.celdaId !== ""
    const ref = resolver(nb, op, false)
    // celdaId: se inserta DESPUÉS de esa celda. indice: posición final de la celda nueva. Ninguno: al final.
    const pos = ref === undefined ? n : tieneId ? ref + 1 : ref
    if (pos < 0 || pos > n) return fallo(`indice ${pos} fuera de rango para insertar: el cuaderno tiene ${n} celdas (0..${n}).`)
    const nueva = celdaNueva(nb, op.tipo ?? "code", op.contenido)
    celdas.splice(pos, 0, nueva)
    despues = describir(nueva, pos)
    tocadas = [pos]
    resumen = `Insertada una celda [${String(nueva.cell_type)}]${typeof nueva.id === "string" ? ` con id ${nueva.id}` : ""} en la posición ${pos}.`
  } else {
    const i = resolver(nb, op, true)!
    if (i < 0 || i >= n) return fallo(`indice ${i} fuera de rango: el cuaderno tiene ${n} celdas (0..${n - 1}).`)
    antes = describir(celdas[i], i)
    celdas.splice(i, 1)
    tocadas = [i]
    resumen = `Borrada la celda ${i}.`
  }

  const texto = serializar(nb)
  // Comprobación posterior: es un cuaderno válido y las celdas que no se tocaron quedaron idénticas.
  const releido = validar(JSON.parse(texto), "despues")
  const base = (JSON.parse(original) as Cuaderno).cells
  const esperado = base.slice()
  if (op.operacion === "reemplazar") esperado[tocadas[0]!] = releido.cells[tocadas[0]!]!
  else if (op.operacion === "insertar") esperado.splice(tocadas[0]!, 0, releido.cells[tocadas[0]!]!)
  else esperado.splice(tocadas[0]!, 1)
  if (JSON.stringify(esperado) !== JSON.stringify(releido.cells))
    return fallo(`La comprobación posterior detectó que otras celdas cambiarían. No se escribió nada.`)

  return {
    texto,
    resumen: `${resumen} El cuaderno tiene ahora ${releido.cells.length} celdas.`,
    antes,
    despues,
    normalizado,
  }
}
