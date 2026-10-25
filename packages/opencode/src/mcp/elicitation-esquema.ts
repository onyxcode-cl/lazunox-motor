// Formularios MCP: funciones PURAS (sin Effect, sin red, sin registro).
// - validarEsquema: acepta solo el subconjunto plano de la especificación 2025-06-18 con topes, y rechaza campos secretos.
// - detectarSecreto: contraseñas, claves, tarjetas, códigos de verificación (español e inglés).
// - validarRespuesta: valida lo que escribió la persona contra los campos ya normalizados.
// Regla de privacidad: ningún mensaje de error contiene VALORES, solo nombres de campo y códigos.

export const TOPES = {
  campos: 20,
  titulo: 120,
  descripcion: 500,
  mensaje: 2000,
  solicitudBytes: 16 * 1024,
  maxLongitudTexto: 4000,
  opciones: 50,
  nombreCampo: 64,
  etiquetaOpcion: 200,
} as const

export type Formato = "email" | "uri" | "date" | "date-time"

export type Campo = {
  name: string
  type: "string" | "number" | "integer" | "boolean" | "enum"
  title?: string
  description?: string
  required: boolean
  format?: Formato
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  options?: Array<{ value: string; label: string }>
  default?: string | number | boolean
}

export type ResultadoEsquema =
  | { ok: true; campos: Campo[] }
  | { ok: false; motivo: "schema" | "secret"; campo?: string; detalle: string }

const FORMATOS: ReadonlyArray<string> = ["email", "uri", "date", "date-time"]
const PROHIBIDAS = new Set(["__proto__", "constructor", "prototype"])

/** Configuración desde el entorno. LAZUNOX_MCP_ELICITATION=1 es el interruptor; sin él no se anuncia la capacidad. */
export function elicitacionActiva(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LAZUNOX_MCP_ELICITATION === "1"
}

export const TIEMPO_DEFECTO_MS = 600_000
export const TIEMPO_MAXIMO_MS = 3_600_000

export function tiempoMaximoMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.LAZUNOX_ELICITATION_TIMEOUT_MS)
  if (!Number.isFinite(n) || n <= 0) return TIEMPO_DEFECTO_MS
  return Math.min(Math.floor(n), TIEMPO_MAXIMO_MS)
}

// ---------------------------------------------------------------------------------------------------------------------
// Secretos
// ---------------------------------------------------------------------------------------------------------------------

/** minúsculas, sin acentos, camelCase y separadores a espacios. «contraseña» -> «contrasena». */
function normalizar(texto: string): string {
  return texto
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[_\-./:]+/g, " ")
    .replace(/\s+/g, " ")
}

// Palabras largas e inequívocas: basta con que aparezcan (también dentro de otra palabra).
const SECRETO_SUBCADENA = /contrasena|password|passwd|passcode|passphrase|secret|credencial|credential|cvv|cvc/
// Palabras cortas o ambiguas: solo como palabra completa.
const SECRETO_PALABRA =
  /(?<![a-z0-9])(?:token|api ?key|apikey|clave|pin|tarjeta|card|iban|otp|2fa|mfa|totp|ssn|clabe|llave|private key|access key|codigo de verificacion|verification code|security code|codigo de seguridad|codigo secreto)(?![a-z0-9])/

export function detectarSecreto(...textos: Array<string | undefined>): boolean {
  for (const t of textos) {
    if (!t) continue
    // «palabra clave» / «keyword» no es una clave de acceso.
    const n = normalizar(t).replace(/palabras? clave/g, " ")
    if (SECRETO_SUBCADENA.test(n) || SECRETO_PALABRA.test(n)) return true
  }
  return false
}

// ---------------------------------------------------------------------------------------------------------------------
// Esquema pedido por el servidor
// ---------------------------------------------------------------------------------------------------------------------

const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

const fallo = (detalle: string, campo?: string): ResultadoEsquema => ({ ok: false, motivo: "schema", campo, detalle })

function entero(v: unknown, min: number, max: number): number | undefined | "mal" {
  if (v === undefined) return undefined
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) return "mal"
  return v
}

function textoAcotado(v: unknown, max: number): string | undefined | "mal" {
  if (v === undefined) return undefined
  if (typeof v !== "string" || v.length > max) return "mal"
  return v
}

export function validarMensaje(mensaje: unknown): { ok: true; mensaje: string } | { ok: false; detalle: string } {
  if (typeof mensaje !== "string") return { ok: false, detalle: "message debe ser texto" }
  if (mensaje.length > TOPES.mensaje) return { ok: false, detalle: `message supera ${TOPES.mensaje} caracteres` }
  return { ok: true, mensaje }
}

export function validarEsquema(requestedSchema: unknown): ResultadoEsquema {
  let bytes = 0
  try {
    bytes = JSON.stringify(requestedSchema)?.length ?? 0
  } catch {
    return fallo("el esquema no es JSON")
  }
  if (bytes > TOPES.solicitudBytes) return fallo(`el esquema supera ${TOPES.solicitudBytes} bytes`)
  if (!esObjeto(requestedSchema) || requestedSchema.type !== "object") return fallo("el esquema debe ser type=object")
  const props = requestedSchema.properties
  if (!esObjeto(props)) return fallo("falta properties")
  const nombres = Object.keys(props)
  if (nombres.length > TOPES.campos) return fallo(`más de ${TOPES.campos} campos`)

  let requeridos = new Set<string>()
  if (requestedSchema.required !== undefined) {
    if (!Array.isArray(requestedSchema.required) || requestedSchema.required.some((r) => typeof r !== "string"))
      return fallo("required debe ser una lista de nombres")
    requeridos = new Set(requestedSchema.required as string[])
  }

  const campos: Campo[] = []
  for (const name of nombres) {
    if (name.length === 0 || name.length > TOPES.nombreCampo || PROHIBIDAS.has(name))
      return fallo("nombre de campo no válido", name)
    const def = props[name]
    if (!esObjeto(def)) return fallo("definición de campo no válida", name)

    const title = textoAcotado(def.title, TOPES.titulo)
    const description = textoAcotado(def.description, TOPES.descripcion)
    if (title === "mal") return fallo(`title supera ${TOPES.titulo} caracteres`, name)
    if (description === "mal") return fallo(`description supera ${TOPES.descripcion} caracteres`, name)

    // Secretos: nombre, título, descripción y format password. Se mira ANTES de seguir validando.
    if (def.format === "password" || detectarSecreto(name, title, description))
      return { ok: false, motivo: "secret", campo: name, detalle: "campo secreto" }

    const base: Campo = { name, type: "string", required: requeridos.has(name) }
    if (title !== undefined) base.title = title
    if (description !== undefined) base.description = description

    const extra = campoPorTipo(name, def, base)
    if (!("name" in extra)) return extra
    campos.push(extra)
  }
  return { ok: true, campos }
}

function campoPorTipo(name: string, def: Record<string, unknown>, base: Campo): Campo | ResultadoEsquema {
  const tipo = def.type
  if (tipo === "boolean") {
    if (def.default !== undefined && typeof def.default !== "boolean") return fallo("default no es booleano", name)
    return { ...base, type: "boolean", ...(def.default !== undefined ? { default: def.default as boolean } : {}) }
  }
  if (tipo === "number" || tipo === "integer") {
    for (const k of ["minimum", "maximum", "default"] as const) {
      if (def[k] !== undefined && (typeof def[k] !== "number" || !Number.isFinite(def[k] as number)))
        return fallo(`${k} no es un número`, name)
    }
    const min = def.minimum as number | undefined
    const max = def.maximum as number | undefined
    if (min !== undefined && max !== undefined && min > max) return fallo("minimum mayor que maximum", name)
    const dflt = def.default as number | undefined
    if (dflt !== undefined) {
      if (tipo === "integer" && !Number.isInteger(dflt)) return fallo("default no es entero", name)
      if ((min !== undefined && dflt < min) || (max !== undefined && dflt > max))
        return fallo("default fuera de rango", name)
    }
    return {
      ...base,
      type: tipo,
      ...(min !== undefined ? { minimum: min } : {}),
      ...(max !== undefined ? { maximum: max } : {}),
      ...(dflt !== undefined ? { default: dflt } : {}),
    }
  }
  if (tipo !== "string") return fallo("tipo no permitido (solo string, number, integer, boolean)", name)

  // enum / oneOf (selección única)
  if (def.enum !== undefined || def.oneOf !== undefined) {
    if (def.enum !== undefined && def.oneOf !== undefined) return fallo("enum y oneOf a la vez", name)
    let opciones: Array<{ value: string; label: string }> = []
    if (def.enum !== undefined) {
      if (!Array.isArray(def.enum) || def.enum.length === 0 || def.enum.length > TOPES.opciones)
        return fallo(`enum debe tener entre 1 y ${TOPES.opciones} valores`, name)
      if (def.enum.some((v) => typeof v !== "string" || v.length > TOPES.etiquetaOpcion))
        return fallo("enum solo admite textos cortos", name)
      let nombres: unknown[] | undefined
      if (def.enumNames !== undefined) {
        if (!Array.isArray(def.enumNames) || def.enumNames.length !== def.enum.length)
          return fallo("enumNames no coincide con enum", name)
        if (def.enumNames.some((v) => typeof v !== "string" || v.length > TOPES.etiquetaOpcion))
          return fallo("enumNames solo admite textos cortos", name)
        nombres = def.enumNames
      }
      opciones = (def.enum as string[]).map((value, i) => ({ value, label: (nombres?.[i] as string | undefined) ?? value }))
    } else {
      if (!Array.isArray(def.oneOf) || def.oneOf.length === 0 || def.oneOf.length > TOPES.opciones)
        return fallo(`oneOf debe tener entre 1 y ${TOPES.opciones} opciones`, name)
      for (const o of def.oneOf) {
        if (
          !esObjeto(o) ||
          typeof o.const !== "string" ||
          o.const.length > TOPES.etiquetaOpcion ||
          (o.title !== undefined && (typeof o.title !== "string" || o.title.length > TOPES.etiquetaOpcion))
        )
          return fallo("oneOf solo admite {const, title} con textos cortos", name)
        opciones.push({ value: o.const, label: (o.title as string | undefined) ?? o.const })
      }
    }
    if (new Set(opciones.map((o) => o.value)).size !== opciones.length) return fallo("opciones repetidas", name)
    if (def.default !== undefined && !opciones.some((o) => o.value === def.default))
      return fallo("default no está entre las opciones", name)
    return {
      ...base,
      type: "enum",
      options: opciones,
      ...(def.default !== undefined ? { default: def.default as string } : {}),
    }
  }

  // string libre
  const minLength = entero(def.minLength, 0, TOPES.maxLongitudTexto)
  const maxLength = entero(def.maxLength, 0, TOPES.maxLongitudTexto)
  if (minLength === "mal" || maxLength === "mal")
    return fallo(`minLength/maxLength deben ser enteros entre 0 y ${TOPES.maxLongitudTexto}`, name)
  if (minLength !== undefined && maxLength !== undefined && minLength > maxLength)
    return fallo("minLength mayor que maxLength", name)
  if (def.format !== undefined && (typeof def.format !== "string" || !FORMATOS.includes(def.format)))
    return fallo("format no permitido", name)
  if (def.default !== undefined) {
    if (typeof def.default !== "string" || def.default.length > (maxLength ?? TOPES.maxLongitudTexto))
      return fallo("default no válido", name)
  }
  return {
    ...base,
    type: "string",
    // Tope siempre presente: la app nunca recibe un campo de texto sin límite.
    maxLength: maxLength ?? TOPES.maxLongitudTexto,
    ...(minLength !== undefined ? { minLength } : {}),
    ...(def.format !== undefined ? { format: def.format as Formato } : {}),
    ...(def.default !== undefined ? { default: def.default as string } : {}),
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Respuesta de la persona
// ---------------------------------------------------------------------------------------------------------------------

export type ErrorCampo = { campo: string; motivo: string }
export type ResultadoRespuesta =
  | { ok: true; content: Record<string, string | number | boolean> }
  | { ok: false; errores: ErrorCampo[] }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const FECHA = /^(\d{4})-(\d{2})-(\d{2})$/
const FECHA_HORA = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})?$/

function fechaValida(s: string): boolean {
  const m = FECHA.exec(s)
  if (!m) return false
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3])
}

function formatoValido(f: Formato, s: string): boolean {
  switch (f) {
    case "email":
      return EMAIL.test(s)
    case "uri":
      try {
        new URL(s)
        return true
      } catch {
        return false
      }
    case "date":
      return fechaValida(s)
    case "date-time":
      return FECHA_HORA.test(s) && fechaValida(s.slice(0, 10)) && !Number.isNaN(Date.parse(s.replace(" ", "T")))
  }
}

/** Valida y filtra: las claves que no son campos se descartan; falta de requeridos o tipos malos devuelven error. */
export function validarRespuesta(campos: ReadonlyArray<Campo>, content: unknown): ResultadoRespuesta {
  const entrada = content === undefined || content === null ? {} : content
  if (!esObjeto(entrada)) return { ok: false, errores: [{ campo: "*", motivo: "content debe ser un objeto" }] }
  const errores: ErrorCampo[] = []
  const salida: Record<string, string | number | boolean> = Object.create(null)

  for (const c of campos) {
    const v = Object.prototype.hasOwnProperty.call(entrada, c.name) ? entrada[c.name] : undefined
    if (v === undefined || v === null) {
      if (c.required) errores.push({ campo: c.name, motivo: "obligatorio" })
      continue
    }
    switch (c.type) {
      case "boolean":
        if (typeof v !== "boolean") errores.push({ campo: c.name, motivo: "debe ser sí/no" })
        else salida[c.name] = v
        break
      case "number":
      case "integer":
        if (typeof v !== "number" || !Number.isFinite(v)) errores.push({ campo: c.name, motivo: "debe ser un número" })
        else if (c.type === "integer" && !Number.isInteger(v)) errores.push({ campo: c.name, motivo: "debe ser entero" })
        else if (c.minimum !== undefined && v < c.minimum) errores.push({ campo: c.name, motivo: "menor que el mínimo" })
        else if (c.maximum !== undefined && v > c.maximum) errores.push({ campo: c.name, motivo: "mayor que el máximo" })
        else salida[c.name] = v
        break
      case "enum":
        if (typeof v !== "string" || !c.options?.some((o) => o.value === v))
          errores.push({ campo: c.name, motivo: "opción no permitida" })
        else salida[c.name] = v
        break
      case "string": {
        if (typeof v !== "string") errores.push({ campo: c.name, motivo: "debe ser texto" })
        else if (c.required && v.length === 0) errores.push({ campo: c.name, motivo: "obligatorio" })
        else if (c.minLength !== undefined && v.length < c.minLength) errores.push({ campo: c.name, motivo: "demasiado corto" })
        else if (v.length > (c.maxLength ?? TOPES.maxLongitudTexto)) errores.push({ campo: c.name, motivo: "demasiado largo" })
        else if (c.format && v.length > 0 && !formatoValido(c.format, v))
          errores.push({ campo: c.name, motivo: `formato ${c.format} no válido` })
        else salida[c.name] = v
        break
      }
    }
  }
  if (errores.length > 0) return { ok: false, errores }
  return { ok: true, content: { ...salida } }
}
