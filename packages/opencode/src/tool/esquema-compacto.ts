// Lazunox (lazunox.16, recorte `esquemas` de LAZUNOX_AHORRO_TOKENS): quita del esquema JSON de una herramienta lo que el modelo no usa.
//  - `$schema` de la raíz (la URL del borrador, ~56 bytes por herramienta; ninguna API de modelos la necesita).
//  - `minimum`/`maximum` iguales a ±Number.MAX_SAFE_INTEGER: los pone Effect para un entero cualquiera y no limitan nada útil
//    (la validación de argumentos de la herramienta no usa este esquema).
// No muta la entrada (los esquemas de las herramientas propias están en caché) y no toca nada más: `exclusiveMinimum`, enums,
// `required`, `additionalProperties` y descripciones quedan igual.
import type { JSONSchema7 } from "@ai-sdk/provider"
import { recorteActivo } from "./ahorro-tokens"

const SEGURO = Number.MAX_SAFE_INTEGER

const compactar = (valor: unknown): unknown => {
  if (Array.isArray(valor)) return valor.map(compactar)
  if (valor === null || typeof valor !== "object") return valor
  const salida: Record<string, unknown> = {}
  for (const [clave, hijo] of Object.entries(valor as Record<string, unknown>)) {
    if (clave === "minimum" && hijo === -SEGURO) continue
    if (clave === "maximum" && hijo === SEGURO) continue
    salida[clave] = compactar(hijo)
  }
  return salida
}

export function esquemaCompacto(esquema: JSONSchema7, env: Record<string, string | undefined> = process.env): JSONSchema7 {
  if (!recorteActivo("esquemas", env)) return esquema
  const { $schema: _, ...resto } = esquema
  return compactar(resto) as JSONSchema7
}

/** Tope de la descripción de una herramienta MCP que va suelta en la lista de herramientas (caracteres). */
export const TOPE_DESCRIPCION_MCP = 1200

/**
 * Recorte `mcp`: una descripción de herramienta MCP de más de 1.200 caracteres se corta en un límite de línea o de frase (si queda
 * al menos la mitad) y lleva «[…]». Es una cota para casos extremos: las descripciones normales (<1.200) no cambian.
 * La definición completa sigue disponible con `tool_search` (no pasa por aquí).
 */
export function descripcionMcp(texto: string, env: Record<string, string | undefined> = process.env): string {
  if (texto.length <= TOPE_DESCRIPCION_MCP || !recorteActivo("mcp", env)) return texto
  const trozo = texto.slice(0, TOPE_DESCRIPCION_MCP)
  const piso = TOPE_DESCRIPCION_MCP / 2
  const linea = trozo.lastIndexOf("\n")
  const frase = Math.max(trozo.lastIndexOf(". "), trozo.lastIndexOf(".\n"))
  const corte = linea >= piso ? linea : frase >= piso ? frase + 1 : TOPE_DESCRIPCION_MCP
  // No partir un par sustituto (emoji): si el corte cae entre dos mitades, se retrocede uno.
  const fin = /[\uD800-\uDBFF]/.test(texto[corte - 1] ?? "") ? corte - 1 : corte
  return `${texto.slice(0, fin).trimEnd()} […]`
}

type Regla = { ruta: string[]; inicio: string; corta?: string; quitar?: boolean }

/**
 * Recorte `esquemas`: descripciones de PARÁMETROS más cortas en herramientas propias (id de la herramienta -> reglas).
 * `ruta` baja por `properties` (y por `items` de las listas). Solo se cambia si la descripción sigue empezando por el texto
 * original (no pisa lo que otro cambie); sin `corta`, la descripción se quita (el texto ya está en la descripción de la herramienta).
 * Los nombres, tipos, obligatorios y enumerados no se tocan.
 */
const PARAMETROS: Record<string, Regla[]> = {
  glob: [
    { ruta: ["pattern"], inicio: "The glob pattern to match files against" },
    {
      ruta: ["path"],
      inicio: "The directory to search in. If not specified",
      corta: 'Directory to search in (default: the current working directory). Omit it for the default; never pass "undefined" or "null".',
    },
  ],
  task: [
    { ruta: ["prompt"], inicio: "The task for the agent to perform" },
    { ruta: ["subagent_type"], inicio: "The type of specialized agent to use" },
    { ruta: ["command"], inicio: "The command that triggered this task", quitar: true },
    {
      ruta: ["task_id"],
      inicio: "This should only be set if you mean to resume",
      corta: "Only to resume a previous task: pass its task_id to continue the same subagent session.",
    },
    {
      ruta: ["background"],
      inicio: "Run the agent in the background. You will be notified",
      corta: "Run the agent in the background; you are notified when it completes. Do not sleep or poll.",
    },
  ],
  skill: [
    {
      ruta: ["args"],
      inicio: "What the person asked for, in your own words.",
      corta: "What the person asked for, in your own words (needed by skills that run as a helper: `context: fork`).",
    },
  ],
  webfetch: [
    { ruta: ["format"], inicio: "The format to return the content in", corta: "Output format (default markdown)." },
    { ruta: ["url"], inicio: "The URL to fetch content from" },
  ],
  // Descripciones de parámetros que solo repiten el nombre (el modelo no necesita «The text to replace» junto a `oldString`).
  edit: [
    { ruta: ["filePath"], inicio: "The absolute path to the file to modify", corta: "Absolute path" },
    { ruta: ["oldString"], inicio: "The text to replace" },
    { ruta: ["newString"], inicio: "The text to replace it with", corta: "Must differ from oldString" },
    { ruta: ["replaceAll"], inicio: "Replace all occurrences of oldString", corta: "Replace every occurrence (default false)" },
  ],
  write: [
    { ruta: ["content"], inicio: "The content to write to the file" },
    { ruta: ["filePath"], inicio: "The absolute path to the file to write", corta: "Absolute path" },
  ],
  read: [
    { ruta: ["filePath"], inicio: "The absolute path to the file or directory to read", corta: "Absolute path" },
    { ruta: ["offset"], inicio: "The line number to start reading from", corta: "Start line (1-indexed)" },
    { ruta: ["limit"], inicio: "The maximum number of lines to read", corta: "Max lines (default 2000)" },
  ],
  grep: [
    { ruta: ["pattern"], inicio: "The regex pattern to search for", corta: "Regex to search for" },
    { ruta: ["path"], inicio: "The directory to search in. Defaults", corta: "Directory to search (default: current)" },
    { ruta: ["include"], inicio: "File pattern to include in the search" },
  ],
  todowrite: [
    { ruta: ["todos"], inicio: "The updated todo list" },
    { ruta: ["todos", "content"], inicio: "Brief description of the task" },
    { ruta: ["todos", "status"], inicio: "Current status of the task:", corta: "pending, in_progress, completed, cancelled" },
    { ruta: ["todos", "priority"], inicio: "Priority level of the task:", corta: "high, medium, low" },
    { ruta: ["todos", "verificar"], inicio: "Optional. " },
    { ruta: ["todos", "bloqueado"], inicio: "Optional. true when blocked" },
    { ruta: ["todos", "id"], inicio: "Optional. Short unique id" },
    { ruta: ["todos", "depende_de"], inicio: "Optional. ids (max 10)" },
  ],
  question: [
    { ruta: ["questions"], inicio: "Questions to ask" },
    { ruta: ["questions", "question"], inicio: "Complete question" },
    { ruta: ["questions", "options"], inicio: "Available choices" },
    { ruta: ["questions", "options", "label"], inicio: "Display text (1-5 words", corta: "1-5 words" },
    { ruta: ["questions", "options", "description"], inicio: "Explanation of choice" },
    { ruta: ["questions", "multiple"], inicio: "Allow selecting multiple choices" },
  ],
  task_wait: [
    { ruta: ["ids"], inicio: "Ids of background subagents started from this session", corta: "Ids of background subagents of this session (the id in <task id=\"...\">). Max 64." },
  ],
  task_cancel: [
    { ruta: ["ids"], inicio: "Ids of background subagents started from this session", corta: "Ids of background subagents of this session (the id in <task id=\"...\">). Max 64." },
  ],
}

type Nodo = Record<string, unknown>
const esNodo = (x: unknown): x is Nodo => x !== null && typeof x === "object" && !Array.isArray(x)

function aplicar(nodo: Nodo, ruta: string[], regla: Regla): Nodo {
  if (esNodo(nodo.items) && !esNodo(nodo.properties)) return { ...nodo, items: aplicar(nodo.items, ruta, regla) }
  const [nombre, ...resto] = ruta
  const props = nodo.properties
  if (!esNodo(props) || !esNodo(props[nombre])) return nodo
  const hijo = props[nombre]
  let nuevo: Nodo
  if (resto.length === 0 && regla.quitar) {
    if (typeof hijo.description !== "string" || !hijo.description.startsWith(regla.inicio)) return nodo
    const { [nombre]: _, ...otras } = props
    const requeridos = Array.isArray(nodo.required) ? nodo.required.filter((x) => x !== nombre) : undefined
    return { ...nodo, properties: otras, ...(requeridos ? { required: requeridos } : {}) }
  }
  if (resto.length > 0) nuevo = aplicar(hijo, resto, regla)
  else if (typeof hijo.description === "string" && hijo.description.startsWith(regla.inicio)) {
    const { description: _, ...sin } = hijo
    nuevo = regla.corta === undefined ? sin : { ...sin, description: regla.corta }
  } else return nodo
  return nuevo === hijo ? nodo : { ...nodo, properties: { ...props, [nombre]: nuevo } }
}

export function parametrosCortos(
  idHerramienta: string,
  esquema: JSONSchema7,
  env: Record<string, string | undefined> = process.env,
): JSONSchema7 {
  const reglas = PARAMETROS[idHerramienta]
  if (!reglas || !recorteActivo("esquemas", env)) return esquema
  return reglas.reduce((acc, regla) => aplicar(acc as Nodo, regla.ruta, regla) as JSONSchema7, esquema)
}
