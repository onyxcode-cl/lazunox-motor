// Lazunox (Ola 7, 7.5): sanitizador de secretos. Heurística, NO un límite de seguridad: tapa las formas más comunes de una
// credencial en texto que se MUESTRA o se GUARDA (comando en la interfaz, metadatos de herramientas, registros). Las cuatro formas
// base son las de Codex (`secrets/src/sanitizer.rs`): `sk-` + 20 o más alfanuméricos, `AKIA` + 16, `Bearer` + 16 o más, y
// `api_key|token|secret|password` seguido de `:` o `=` y un valor de 8 o más. Se añaden unas pocas con prefijo muy específico
// (GitHub, Slack, Google, JWT, bloques de clave privada) y los valores literales que la app registre para la sesión.
//
// Interruptores (se leen en cada llamada):
//   LAZUNOX_SANITIZAR=0          apaga todo (lo mostrado/guardado queda como antes).
//   LAZUNOX_SANITIZAR_MODELO=1   además tapa lo que VE EL MODELO (salida de shell y de celdas, avisos de fondo, archivos de salida
//                                larga). Apagado por defecto: es heurística y enmascarar de más rompe salidas útiles (decisión D7).
//   LAZUNOX_SANITIZAR_EXTRA      secretos literales extra (JSON de cadenas, o uno por línea); mínimo 8 caracteres cada uno.
//                                También se pueden registrar por código con `registrarSecretos`.

export const MARCA = "[REDACTED_SECRET]"

/** Longitud mínima de un secreto literal registrado: más corto taparía palabras comunes. */
const MIN_LITERAL = 8
/** Tope de literales registrados en memoria (los más nuevos ganan). */
const MAX_LITERALES = 64

export function activo(env: Record<string, string | undefined> = process.env) {
  return env.LAZUNOX_SANITIZAR !== "0"
}

export function activoParaElModelo(env: Record<string, string | undefined> = process.env) {
  return activo(env) && env.LAZUNOX_SANITIZAR_MODELO === "1"
}

const registrados: string[] = []

/** Registra valores literales (claves que la app conoce en la sesión) para taparlos donde aparezcan. */
export function registrarSecretos(valores: readonly string[]) {
  for (const v of valores) {
    if (typeof v !== "string" || v.length < MIN_LITERAL || registrados.includes(v)) continue
    registrados.push(v)
    if (registrados.length > MAX_LITERALES) registrados.shift()
  }
}

export function olvidarSecretos() {
  registrados.length = 0
}

function literales(env: Record<string, string | undefined>): string[] {
  const crudo = env.LAZUNOX_SANITIZAR_EXTRA
  const deEntorno = !crudo
    ? []
    : (() => {
        const t = crudo.trim()
        if (t.startsWith("[")) {
          try {
            const j: unknown = JSON.parse(t)
            return Array.isArray(j) ? j.filter((x): x is string => typeof x === "string") : []
          } catch {
            return []
          }
        }
        return t.split(/\r?\n/)
      })()
  return [...registrados, ...deEntorno].filter((v) => v.length >= MIN_LITERAL).toSorted((a, b) => b.length - a.length)
}

// Nombres de variable que contienen estas palabras. `token` no cuenta cuando es una cifra de uso (max_tokens, token_count…).
// El nombre se acota a 80 caracteres y solo puede empezar al inicio de una palabra: así la búsqueda es lineal aunque el texto sea
// una sola palabra enorme (la prueba de rendimiento lo vigila). La palabra clave se comprueba después, en `esNombreDeSecreto`.
const PALABRA_CLAVE = /api[_-]?key|secret|passw(?:or)?d|credential|token/i
const NO_ES_SECRETO_EL_NOMBRE =
  /tokens$|tokens?[_.-]?(?:count|limit|budget|usage|max|min|used|total|remaining|estimate)s?$|(?:max|min|total|num|input|output|prompt|completion|cache|reasoning|used|remaining)[_.-]?tokens?$/i

const RE_CLAVE_VALOR = /(?<![\w.-])([\w.-]{1,80})(\\?["']?\s*[:=]\s*)(\\?["']?)([^\s"',;\\]{8,})/g

const esNombreDeSecreto = (nombre: string) => PALABRA_CLAVE.test(nombre) && !NO_ES_SECRETO_EL_NOMBRE.test(nombre)

const RE_SK = /(?<![A-Za-z0-9])sk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/g
const RE_AKIA = /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g
const RE_BEARER = /(\bBearer\s+)([A-Za-z0-9._~+/=-]{16,})/gi
const RE_GITHUB = /(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/g
const RE_SLACK = /(?<![A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{10,}/g
const RE_GOOGLE = /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g
const RE_JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g
const RE_PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g

function valorEsReferencia(v: string) {
  // Cifras sueltas, banderas, marcadores de lugar y referencias a otra variable no son secretos.
  if (/^\d+(?:\.\d+)?$/.test(v)) return true
  if (/^(?:true|false|null|none|undefined|nil)$/i.test(v)) return true
  if (/^[*x•.#-]+$/i.test(v)) return true
  if (/^[$<{(%\[]/.test(v)) return true
  if (v.includes(MARCA) || /^\[REDACTED/i.test(v)) return true
  if (/^(?:process\.env|os\.environ|os\.getenv|env\.|import\.meta|config\.|settings\.|self\.|this\.|args\.)/i.test(v)) return true
  return false
}

function bearerEsSecreto(t: string) {
  if (/[0-9._~+/=]/.test(t)) return true
  // Solo letras y guiones: palabras largas normales. Se tapa únicamente si parece aleatorio (largo y con mayúsculas y minúsculas).
  return t.length >= 32 && /[a-z]/.test(t) && /[A-Z]/.test(t)
}

/** Tapa los secretos reconocibles de `texto`. Idempotente; no cambia nada si no hay coincidencias. */
export function sanitizar(texto: string, env: Record<string, string | undefined> = process.env): string {
  if (!texto || !activo(env)) return texto
  let t = texto
  for (const lit of literales(env)) if (t.includes(lit)) t = t.split(lit).join(MARCA)
  if (t.includes("PRIVATE KEY")) t = t.replace(RE_PEM, MARCA)
  t = t.replace(RE_SK, MARCA).replace(RE_AKIA, MARCA).replace(RE_GITHUB, MARCA).replace(RE_SLACK, MARCA).replace(RE_GOOGLE, MARCA)
  if (t.includes("eyJ")) t = t.replace(RE_JWT, MARCA)
  t = t.replace(RE_BEARER, (todo, pre: string, tok: string) => (bearerEsSecreto(tok) ? pre + MARCA : todo))
  t = t.replace(RE_CLAVE_VALOR, (todo, nombre: string, sep: string, comilla: string, valor: string) => {
    if (!esNombreDeSecreto(nombre)) return todo
    if (valorEsReferencia(valor)) return todo
    return nombre + sep + comilla + MARCA
  })
  return t
}

/** `sanitizar` aplicado a todas las cadenas de un valor JSON (copia; no toca el original). Profundidad y tamaño acotados. */
export function sanitizarProfundo<T>(valor: T, env: Record<string, string | undefined> = process.env, nivel = 0): T {
  if (!activo(env)) return valor
  if (typeof valor === "string") return sanitizar(valor, env) as T
  if (nivel >= 8 || valor === null || typeof valor !== "object") return valor
  if (Array.isArray(valor)) return valor.map((v) => sanitizarProfundo(v, env, nivel + 1)) as T
  const proto = Object.getPrototypeOf(valor)
  if (proto !== Object.prototype && proto !== null) return valor
  return Object.fromEntries(
    Object.entries(valor as Record<string, unknown>).map(([k, v]) => [k, sanitizarProfundo(v, env, nivel + 1)]),
  ) as T
}

export * as Sanitizar from "./sanitizar"
