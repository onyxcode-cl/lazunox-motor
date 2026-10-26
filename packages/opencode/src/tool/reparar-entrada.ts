// Lazunox (Ola 7 — 7.13): reparación de la ENTRADA de herramientas por esquema, antes de ejecutar (y antes de pedir permisos:
// la entrada reparada es la que se muestra y se evalúa). Inspirado en `core/src/plugin/tool-input-repair.ts` de OpenCode 2.x,
// pero con una lista CERRADA de reparaciones seguras. PURO: sin Effect ni permisos.
//
// Se repara solo cuando el esquema lo respalda sin ambigüedad:
//  1. objeto / arreglo que llegó como texto JSON ('{"a":1}' -> {a:1}), en la raíz o anidado;
//  2. número o entero que llegó como texto numérico decimal ("20" -> 20; no "0x10", no "", no "1e999");
//  3. booleano que llegó como "true" / "false";
//  4. `null` en una propiedad OPCIONAL de un solo tipo simple (se quita la clave);
//  5. valor suelto donde se espera un arreglo cuyos elementos admiten ese valor ("a" -> ["a"]).
// NUNCA: inventar un valor obligatorio, convertir null en algo en una propiedad obligatoria, adivinar entre uniones con
// varias ramas posibles, quitar claves desconocidas ni tocar cadenas esperadas como texto. Lo que no se repara se deja tal
// cual: la herramienta (o su esquema) lo rechaza con su mensaje claro, igual que antes.

type Esquema = Record<string, unknown>
const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

const MAX_PROFUNDIDAD = 6
const NUMERO = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

/** `LAZUNOX_REPARAR_ENTRADA=0` la apaga. */
export const activa = (env: NodeJS.ProcessEnv = process.env) => env.LAZUNOX_REPARAR_ENTRADA !== "0"

export interface Resultado {
  valor: unknown
  /** Descripción de cada reparación hecha (ruta + tipo); vacío = no se tocó nada. */
  cambios: string[]
}

export function repararEntrada(entrada: unknown, esquema: unknown): Resultado {
  const cambios: string[] = []
  if (!esObjeto(esquema)) return { valor: entrada, cambios }
  const valor = reparar(entrada, esquema, esquema, 0, "", cambios)
  return { valor, cambios }
}

function jsonTexto(v: unknown): unknown {
  if (typeof v !== "string") return undefined
  const t = v.trim()
  if (!(t.startsWith("{") || t.startsWith("["))) return undefined
  try {
    return JSON.parse(t)
  } catch {
    return undefined
  }
}

function resolverRef(esquema: Esquema, raiz: Esquema): Esquema | undefined {
  const ref = esquema.$ref
  if (typeof ref !== "string") return undefined
  const m = /^#\/(\$defs|definitions)\/([^/]+)$/.exec(ref)
  if (!m) return undefined
  const defs = raiz[m[1]!]
  if (!esObjeto(defs)) return undefined
  const destino = defs[m[2]!.replaceAll("~1", "/").replaceAll("~0", "~")]
  return esObjeto(destino) ? destino : undefined
}

function tipoDe(v: unknown): string {
  return v === null ? "null" : Array.isArray(v) ? "array" : typeof v
}

function reparar(valor: unknown, esquema: Esquema, raiz: Esquema, prof: number, ruta: string, cambios: string[]): unknown {
  if (prof > MAX_PROFUNDIDAD) return valor

  if (typeof esquema.$ref === "string") {
    const destino = resolverRef(esquema, raiz)
    return destino ? reparar(valor, destino, raiz, prof + 1, ruta, cambios) : valor
  }

  // `type: ["integer", "null"]`: si ya encaja no se toca; con una sola rama no nula se repara contra ella.
  if (Array.isArray(esquema.type)) {
    if (valor === null && esquema.type.includes("null")) return valor
    if (esquema.type.includes(tipoDe(valor))) return valor
    const tipos = esquema.type.filter((t) => t !== "null")
    return tipos.length === 1 ? reparar(valor, { ...esquema, type: tipos[0] }, raiz, prof + 1, ruta, cambios) : valor
  }

  // Uniones: solo con UNA rama candidata no nula y sin que el valor ya encaje en alguna; si no, ambiguo y se deja.
  if (esquema.type === undefined) {
    if (Array.isArray(esquema.anyOf) && Array.isArray(esquema.oneOf)) return valor
    const ramas = Array.isArray(esquema.anyOf) ? esquema.anyOf : esquema.oneOf
    if (!Array.isArray(ramas) || valor === null) return valor
    if (ramas.some((r) => !esObjeto(r) || r.type === undefined || r.type === tipoDe(valor))) return valor
    const candidatas = ramas.filter((r): r is Esquema => esObjeto(r) && r.type !== "null")
    return candidatas.length === 1 ? reparar(valor, candidatas[0]!, raiz, prof + 1, ruta, cambios) : valor
  }

  switch (esquema.type) {
    case "number":
    case "integer": {
      if (typeof valor !== "string") return valor
      const t = valor.trim()
      if (!NUMERO.test(t)) return valor
      const n = Number(t)
      if (!Number.isFinite(n)) return valor
      if (esquema.type === "integer" && !Number.isSafeInteger(n)) return valor
      cambios.push(`${ruta || "(raíz)"}: texto -> ${esquema.type}`)
      return n
    }
    case "boolean": {
      if (typeof valor !== "string") return valor
      const t = valor.trim().toLowerCase()
      if (t !== "true" && t !== "false") return valor
      cambios.push(`${ruta || "(raíz)"}: texto -> boolean`)
      return t === "true"
    }
    case "object":
      return repararObjeto(valor, esquema, raiz, prof, ruta, cambios)
    case "array":
      return repararArreglo(valor, esquema, raiz, prof, ruta, cambios)
    default:
      return valor
  }
}

function repararObjeto(valor: unknown, esquema: Esquema, raiz: Esquema, prof: number, ruta: string, cambios: string[]): unknown {
  let obj = valor
  if (typeof valor === "string") {
    const parsed = jsonTexto(valor)
    if (!esObjeto(parsed)) return valor
    obj = parsed
    cambios.push(`${ruta || "(raíz)"}: texto JSON -> objeto`)
  }
  if (!esObjeto(obj)) return valor
  const props = esObjeto(esquema.properties) ? esquema.properties : {}
  const requeridas = Array.isArray(esquema.required) ? esquema.required : []
  const compuesto = Array.isArray(esquema.allOf) || Array.isArray(esquema.anyOf) || Array.isArray(esquema.oneOf)
  const salida: Record<string, unknown> = { ...obj }
  for (const clave of Object.keys(obj)) {
    const declarada = Object.hasOwn(props, clave)
    const prop = declarada ? props[clave] : esObjeto(esquema.additionalProperties) ? esquema.additionalProperties : undefined
    if (!esObjeto(prop)) continue
    const actual = obj[clave]
    const rutaHija = ruta ? `${ruta}.${clave}` : clave
    // null en opcional: solo si la propiedad es de UN tipo simple que lo rechaza con seguridad (sin uniones, enum, const, nullable, $ref).
    const simple =
      typeof prop.type === "string" &&
      prop.type !== "null" &&
      !compuesto &&
      ["anyOf", "oneOf", "allOf", "enum", "const", "$ref", "nullable"].every((k) => !(k in prop))
    if (declarada && actual === null && simple && !requeridas.includes(clave)) {
      delete salida[clave]
      cambios.push(`${rutaHija}: null en opcional -> se quita`)
      continue
    }
    const nuevo = reparar(actual, prop, raiz, prof + 1, rutaHija, cambios)
    if (nuevo !== actual) salida[clave] = nuevo
  }
  return salida
}

function repararArreglo(valor: unknown, esquema: Esquema, raiz: Esquema, prof: number, ruta: string, cambios: string[]): unknown {
  let arr = valor
  if (typeof valor === "string") {
    const parsed = jsonTexto(valor)
    if (Array.isArray(parsed)) {
      arr = parsed
      cambios.push(`${ruta || "(raíz)"}: texto JSON -> arreglo`)
    }
  }
  const items = esObjeto(esquema.items) ? esquema.items : undefined
  if (Array.isArray(arr)) {
    if (!items) return arr
    const reparado = arr.map((x, i) => reparar(x, items, raiz, prof + 1, `${ruta}[${i}]`, cambios))
    return reparado.every((x, i) => x === (arr as unknown[])[i]) ? arr : reparado
  }
  // Valor suelto -> arreglo de uno, solo si es un escalar (o un objeto) que encaja en `items` tras repararlo.
  if (!items || valor === null || valor === undefined || Array.isArray(esquema.items) || Array.isArray(esquema.prefixItems)) return valor
  const sub: string[] = []
  const r = reparar(valor, items, raiz, prof + 1, `${ruta}[0]`, sub)
  const tipo = items.type
  const encaja =
    tipo === "object"
      ? esObjeto(r)
      : tipo === "integer"
        ? typeof r === "number" && Number.isSafeInteger(r)
        : tipo === "number"
          ? typeof r === "number" && Number.isFinite(r)
          : (tipo === "string" || tipo === "boolean") && typeof r === tipo
  if (!encaja) return valor
  cambios.push(...sub, `${ruta || "(raíz)"}: valor suelto -> arreglo de uno`)
  return [r]
}
