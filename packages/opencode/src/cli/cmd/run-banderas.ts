// Lazunox: banderas de `opencode run` para ejecuciones sin supervisión (banco de tareas, automatización):
//   --json-schema <archivo>      la respuesta final debe validar contra el esquema JSON
//   --max-steps N                corta el bucle del agente tras N pasos
//   --presupuesto-tokens N       corta al superar N tokens (entrada + salida) acumulados
//   --permisos ninguno           lo que preguntaría se NIEGA (como `dontAsk` de Claude): nunca espera una aprobación
// Este módulo es puro (sin motor, sin red): el validador de esquemas, el medidor de pasos/tokens y el informe final.
// `run.ts` solo lo cablea. Códigos de salida: ver `CODIGO_SALIDA`.

export type Motivo = "completado" | "max_pasos" | "presupuesto_tokens" | "esquema_invalido" | "error"

/** 0 = terminó bien; 1 = error del motor o del modelo; 3 = esquema; 4 = tope de pasos; 5 = presupuesto de tokens. */
export const CODIGO_SALIDA: Record<Motivo, number> = {
  completado: 0,
  error: 1,
  esquema_invalido: 3,
  max_pasos: 4,
  presupuesto_tokens: 5,
}

export const MENSAJE_PERMISO_NEGADO =
  "Permiso negado: esta ejecución no admite aprobaciones (--permisos ninguno). No lo intentes de nuevo; usa otra vía o explica que no se pudo."

// ---------------------------------------------------------------------------------------------------------------------
// Validador de esquemas JSON (subconjunto práctico: lo que se usa para pedir salidas estructuradas)
// ---------------------------------------------------------------------------------------------------------------------

type Json = unknown
type Esquema = Record<string, Json>

const MAX_ERRORES = 20
const MAX_PROFUNDIDAD_REF = 32

function esObjeto(v: Json): v is Record<string, Json> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function tipoDe(v: Json): string {
  if (v === null) return "null"
  if (Array.isArray(v)) return "array"
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number"
  return typeof v
}

function cumpleTipo(v: Json, tipo: string): boolean {
  const t = tipoDe(v)
  if (tipo === "number") return t === "number" || t === "integer"
  return t === tipo
}

function igual(a: Json, b: Json): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function resolverRef(raiz: Esquema, ref: string): Esquema | undefined {
  if (!ref.startsWith("#")) return undefined
  if (ref === "#") return raiz
  let actual: Json = raiz
  for (const crudo of ref.slice(2).split("/")) {
    const clave = decodeURIComponent(crudo).replace(/~1/g, "/").replace(/~0/g, "~")
    if (!esObjeto(actual) && !Array.isArray(actual)) return undefined
    actual = (actual as Record<string, Json>)[clave]
  }
  return esObjeto(actual) ? actual : undefined
}

/** Devuelve la lista de problemas (vacía = válido). Ignora palabras clave que no conoce (`format`, `description`…). */
export function validarEsquema(schema: Esquema, valor: Json): string[] {
  const errores: string[] = []
  const ir = (s: Json, v: Json, ruta: string, prof: number): void => {
    if (errores.length >= MAX_ERRORES) return
    if (s === true || s === undefined) return
    if (s === false) {
      errores.push(`${ruta || "(raíz)"}: no se admite ningún valor`)
      return
    }
    if (!esObjeto(s)) return
    const donde = ruta || "(raíz)"
    if (typeof s.$ref === "string") {
      if (prof > MAX_PROFUNDIDAD_REF) {
        errores.push(`${donde}: referencias $ref demasiado profundas`)
        return
      }
      const destino = resolverRef(schema, s.$ref)
      if (!destino) {
        errores.push(`${donde}: no se pudo resolver ${s.$ref}`)
        return
      }
      ir(destino, v, ruta, prof + 1)
    }
    if (s.const !== undefined && !igual(s.const, v)) errores.push(`${donde}: debe ser ${JSON.stringify(s.const)}`)
    if (Array.isArray(s.enum) && !s.enum.some((e) => igual(e, v)))
      errores.push(`${donde}: debe ser uno de ${JSON.stringify(s.enum)}`)
    if (s.type !== undefined) {
      const tipos = Array.isArray(s.type) ? s.type : [s.type]
      if (!tipos.some((t) => typeof t === "string" && cumpleTipo(v, t)))
        errores.push(`${donde}: se esperaba ${tipos.join(" | ")} y llegó ${tipoDe(v)}`)
    }
    if (Array.isArray(s.allOf)) for (const sub of s.allOf) ir(sub, v, ruta, prof + 1)
    if (Array.isArray(s.anyOf) && s.anyOf.length) {
      if (!s.anyOf.some((sub) => validarEsquema(raizCon(schema, sub), v).length === 0))
        errores.push(`${donde}: no cumple ninguna de las alternativas (anyOf)`)
    }
    if (Array.isArray(s.oneOf) && s.oneOf.length) {
      const n = s.oneOf.filter((sub) => validarEsquema(raizCon(schema, sub), v).length === 0).length
      if (n !== 1) errores.push(`${donde}: debe cumplir exactamente una alternativa (oneOf) y cumple ${n}`)
    }
    if (s.not !== undefined && validarEsquema(raizCon(schema, s.not), v).length === 0)
      errores.push(`${donde}: no debe cumplir la condición "not"`)

    if (typeof v === "string") {
      if (typeof s.minLength === "number" && [...v].length < s.minLength)
        errores.push(`${donde}: mínimo ${s.minLength} caracteres`)
      if (typeof s.maxLength === "number" && [...v].length > s.maxLength)
        errores.push(`${donde}: máximo ${s.maxLength} caracteres`)
      if (typeof s.pattern === "string") {
        try {
          if (!new RegExp(s.pattern, "u").test(v)) errores.push(`${donde}: no cumple el patrón ${s.pattern}`)
        } catch {
          errores.push(`${donde}: patrón inválido en el esquema (${s.pattern})`)
        }
      }
    }
    if (typeof v === "number") {
      if (typeof s.minimum === "number" && v < s.minimum) errores.push(`${donde}: mínimo ${s.minimum}`)
      if (typeof s.maximum === "number" && v > s.maximum) errores.push(`${donde}: máximo ${s.maximum}`)
      if (typeof s.exclusiveMinimum === "number" && v <= s.exclusiveMinimum)
        errores.push(`${donde}: debe ser mayor que ${s.exclusiveMinimum}`)
      if (typeof s.exclusiveMaximum === "number" && v >= s.exclusiveMaximum)
        errores.push(`${donde}: debe ser menor que ${s.exclusiveMaximum}`)
      if (
        typeof s.multipleOf === "number" &&
        s.multipleOf > 0 &&
        Math.abs(v / s.multipleOf - Math.round(v / s.multipleOf)) > 1e-9
      )
        errores.push(`${donde}: debe ser múltiplo de ${s.multipleOf}`)
    }
    if (Array.isArray(v)) {
      if (typeof s.minItems === "number" && v.length < s.minItems)
        errores.push(`${donde}: mínimo ${s.minItems} elementos`)
      if (typeof s.maxItems === "number" && v.length > s.maxItems)
        errores.push(`${donde}: máximo ${s.maxItems} elementos`)
      if (s.uniqueItems === true && new Set(v.map((x) => JSON.stringify(x))).size !== v.length)
        errores.push(`${donde}: los elementos deben ser únicos`)
      if (Array.isArray(s.items)) s.items.forEach((sub, i) => i < v.length && ir(sub, v[i], `${ruta}[${i}]`, prof + 1))
      else if (s.items !== undefined) v.forEach((x, i) => ir(s.items, x, `${ruta}[${i}]`, prof + 1))
      if (Array.isArray(s.prefixItems))
        s.prefixItems.forEach((sub, i) => i < v.length && ir(sub, v[i], `${ruta}[${i}]`, prof + 1))
    }
    if (esObjeto(v)) {
      const props = esObjeto(s.properties) ? s.properties : {}
      if (Array.isArray(s.required))
        for (const r of s.required)
          if (typeof r === "string" && !(r in v)) errores.push(`${donde}: falta la propiedad "${r}"`)
      for (const [k, sub] of Object.entries(props)) if (k in v) ir(sub, v[k], ruta ? `${ruta}.${k}` : k, prof + 1)
      for (const k of Object.keys(v)) {
        if (k in props) continue
        if (s.additionalProperties === false) errores.push(`${donde}: propiedad no admitida "${k}"`)
        else if (esObjeto(s.additionalProperties)) ir(s.additionalProperties, v[k], ruta ? `${ruta}.${k}` : k, prof + 1)
      }
      if (typeof s.minProperties === "number" && Object.keys(v).length < s.minProperties)
        errores.push(`${donde}: mínimo ${s.minProperties} propiedades`)
      if (typeof s.maxProperties === "number" && Object.keys(v).length > s.maxProperties)
        errores.push(`${donde}: máximo ${s.maxProperties} propiedades`)
    }
  }
  ir(schema, valor, "", 0)
  return errores.slice(0, MAX_ERRORES)
}

/** Un subesquema evaluado como esquema propio, conservando `$defs`/`definitions` de la raíz para resolver `$ref`. */
function raizCon(raiz: Esquema, sub: Json): Esquema {
  if (!esObjeto(sub)) return sub === false ? { not: {} } : {}
  return { ...sub, $defs: raiz.$defs, definitions: raiz.definitions, ...(sub.$defs ? { $defs: sub.$defs } : {}) }
}

export function leerEsquema(texto: string): { ok: true; schema: Esquema } | { ok: false; error: string } {
  let json: Json
  try {
    json = JSON.parse(texto)
  } catch (e) {
    return { ok: false, error: `no es JSON válido (${e instanceof Error ? e.message : String(e)})` }
  }
  if (!esObjeto(json)) return { ok: false, error: "el esquema debe ser un objeto JSON" }
  return { ok: true, schema: json }
}

/** Texto de la última respuesta del asistente (la última parte de texto con contenido). */
export function ultimoTexto(parts: ReadonlyArray<{ type: string; text?: string }>): string | undefined {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]
    if (p.type === "text" && p.text?.trim()) return p.text.trim()
  }
  return undefined
}

/** Saca un JSON de un texto del modelo (tal cual o dentro de un bloque ```json). */
export function jsonDeTexto(texto: string): { ok: true; valor: Json } | { ok: false } {
  const candidatos = [texto, ...[...texto.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1])]
  for (const c of candidatos) {
    try {
      return { ok: true, valor: JSON.parse(c.trim()) }
    } catch {
      /* siguiente */
    }
  }
  return { ok: false }
}

export type ResultadoEsquema = { valido: boolean; errores: string[]; salida?: Json }

/** `estructurada`: lo que capturó la herramienta del motor; si falta, se intenta con el último texto. */
export function comprobarSalida(
  schema: Esquema,
  estructurada: Json | undefined,
  texto: string | undefined,
): ResultadoEsquema {
  let valor = estructurada
  if (valor === undefined && texto) {
    const j = jsonDeTexto(texto)
    if (j.ok) valor = j.valor
  }
  if (valor === undefined)
    return { valido: false, errores: ["la respuesta final no contiene una salida estructurada (JSON)"] }
  const errores = validarEsquema(schema, valor)
  return { valido: errores.length === 0, errores, salida: valor }
}

// ---------------------------------------------------------------------------------------------------------------------
// Medidor: pasos, tokens, herramientas, tiempo y motivo del fin
// ---------------------------------------------------------------------------------------------------------------------

type PartePaso = {
  id: string
  reason?: string
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
}
type ParteHerramienta = { id: string; tool: string; state?: { status?: string } }

export type Informe = {
  motivo: Motivo
  exito: boolean
  tokens: {
    entrada: number
    salida: number
    cache_leida: number
    cache_escrita: number
    razonamiento: number
    total: number
  }
  pasos: number
  pasos_ayudantes: number
  herramientas: Record<string, number>
  llamadas_herramientas: number
  permisos_negados: number
  tiempo_ms: number
  limites: { max_pasos?: number; presupuesto_tokens?: number }
  detalle?: string
  esquema?: { valido: boolean; errores: string[] }
}

export function crearMedidor(opts: { maxPasos?: number; presupuestoTokens?: number; ahora?: () => number } = {}) {
  const ahora = opts.ahora ?? Date.now
  const t0 = ahora()
  const tok = { entrada: 0, salida: 0, cache_leida: 0, cache_escrita: 0, razonamiento: 0 }
  const pasosVistos = new Set<string>()
  const herrVistas = new Set<string>()
  const herramientas: Record<string, number> = {}
  let pasos = 0
  let pasosAyudantes = 0
  let negados = 0
  let corte: Motivo | undefined
  let estructuradaVista = false

  return {
    /** Contabiliza un `step-finish`. Devuelve el motivo si hay que cortar AHORA (solo si el bucle iba a continuar). */
    paso(part: PartePaso, principal: boolean): Motivo | undefined {
      if (pasosVistos.has(part.id)) return undefined
      pasosVistos.add(part.id)
      tok.entrada += part.tokens?.input ?? 0
      tok.salida += part.tokens?.output ?? 0
      tok.razonamiento += part.tokens?.reasoning ?? 0
      tok.cache_leida += part.tokens?.cache?.read ?? 0
      tok.cache_escrita += part.tokens?.cache?.write ?? 0
      if (principal) pasos++
      else pasosAyudantes++
      if (corte) return undefined
      // Solo se corta si el bucle iba a seguir: un paso que ya terminó con respuesta final es un fin normal.
      const sigue = part.reason === "tool-calls" || part.reason === "unknown"
      if (!sigue || estructuradaVista) return undefined
      if (opts.presupuestoTokens !== undefined && tok.entrada + tok.salida > opts.presupuestoTokens)
        corte = "presupuesto_tokens"
      else if (opts.maxPasos !== undefined && principal && pasos >= opts.maxPasos) corte = "max_pasos"
      return corte
    },
    herramienta(part: ParteHerramienta) {
      const st = part.state?.status
      if (st !== "completed" && st !== "error") return
      if (herrVistas.has(part.id)) return
      herrVistas.add(part.id)
      herramientas[part.tool] = (herramientas[part.tool] ?? 0) + 1
      if (part.tool === "StructuredOutput" && st === "completed") estructuradaVista = true
    },
    permisoNegado() {
      negados++
    },
    corte: () => corte,
    pasos: () => pasos,
    informe(motivo: Motivo, extra: { detalle?: string; esquema?: ResultadoEsquema } = {}): Informe {
      const llamadas = Object.values(herramientas).reduce((a, b) => a + b, 0)
      return {
        motivo,
        exito: motivo === "completado",
        tokens: { ...tok, total: tok.entrada + tok.salida },
        pasos,
        pasos_ayudantes: pasosAyudantes,
        herramientas: { ...herramientas },
        llamadas_herramientas: llamadas,
        permisos_negados: negados,
        tiempo_ms: ahora() - t0,
        limites: {
          ...(opts.maxPasos !== undefined ? { max_pasos: opts.maxPasos } : {}),
          ...(opts.presupuestoTokens !== undefined ? { presupuesto_tokens: opts.presupuestoTokens } : {}),
        },
        ...(extra.detalle ? { detalle: extra.detalle } : {}),
        ...(extra.esquema ? { esquema: { valido: extra.esquema.valido, errores: extra.esquema.errores } } : {}),
      }
    },
  }
}

/** Entero positivo o `undefined` si no se pidió; `Error` con mensaje claro si el valor no sirve. */
export function enteroPositivo(nombre: string, valor: unknown): number | undefined {
  if (valor === undefined) return undefined
  if (typeof valor !== "number" || !Number.isInteger(valor) || valor <= 0)
    throw new Error(`${nombre} debe ser un entero positivo`)
  return valor
}
