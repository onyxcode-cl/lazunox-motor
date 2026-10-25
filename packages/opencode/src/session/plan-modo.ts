/**
 * Lazunox (2C, P08): piezas puras del modo plan para la app. Sin dependencias del motor para poder probarlas solas.
 *
 * El modo plan solo puede escribir `.opencode/plans/*.md`. Eso lo hacen los permisos del agente `plan` (`edit: * deny` y el
 * archivo del plan permitido; `agent/agent.ts`). Aquí vive lo que los permisos NO cubren:
 *  - el shell (el agente `plan` hereda `*: allow`; sin esto `echo x > archivo` escribiría donde quiera), y
 *  - los ayudantes lanzados desde `plan` (el tope del padre se propaga con una marca en los permisos de la sesión hija).
 */

/** Interruptor del modo plan para la app: `LAZUNOX_PLAN=1` (ausente = apagado). */
export const ENV_PLAN = "LAZUNOX_PLAN"
export const planActivo = (env: NodeJS.ProcessEnv = process.env) => env[ENV_PLAN] === "1" || env[ENV_PLAN] === "true"

/**
 * Marca que `deriveSubagentSessionPermission` añade a la sesión de un ayudante lanzado desde un agente de modo plan.
 * Solo la pone el motor (no es un campo de configuración); el shell la lee para exigir órdenes de solo lectura.
 */
export const MARCA_MODO_PLAN = "lazunox_modo_plan"

type Regla = { permission: string; pattern: string; action: string }

export function marcaModoPlan(...conjuntos: ReadonlyArray<ReadonlyArray<Regla> | undefined>): boolean {
  const reglas = conjuntos.flatMap((c) => c ?? [])
  const ultima = reglas.findLast((r) => r.permission === MARCA_MODO_PLAN)
  return ultima?.action === "allow"
}

/**
 * ¿Los permisos de este agente son los del modo plan? (`edit` denegado en general y `plan_exit` permitido). Se usa para
 * decidir si un ayudante hereda el tope; el agente `plan` nativo cumple ambas cosas y `build` ninguna.
 */
export function esAgenteDePlan(reglas: ReadonlyArray<Regla> | undefined): boolean {
  if (!reglas) return false
  const ultimo = (permiso: string, patron: string) =>
    reglas.findLast((r) => r.permission === permiso && r.pattern === patron)?.action
  return ultimo("plan_exit", "*") === "allow" && ultimo("edit", "*") === "deny"
}

/** Reglas que la sesión hija recibe de un padre en modo plan: la marca y el mismo `edit` del padre. */
export function topeDeModoPlan(parentAgent: ReadonlyArray<Regla> | undefined, parentSession: ReadonlyArray<Regla>) {
  const padreEnPlan = esAgenteDePlan(parentAgent) || marcaModoPlan(parentSession)
  if (!padreEnPlan) return []
  const edit = [...(parentAgent ?? []), ...parentSession].filter((r) => r.permission === "edit")
  return [{ permission: MARCA_MODO_PLAN, pattern: "*", action: "allow" }, ...edit]
}

export type VeredictoLectura = { ok: true } | { ok: false; motivo: string }

const LECTURA = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "find", "tree", "pwd", "echo", "printf", "stat", "file",
  "du", "df", "which", "whoami", "date", "uname", "sort", "uniq", "cut", "tr", "diff", "cmp", "basename", "dirname",
  "realpath", "readlink", "jq", "nl", "column", "fold", "rev", "tac", "od", "hexdump", "strings", "md5sum", "sha1sum",
  "sha256sum", "cd", "true", "false", "test", "[", "git",
  // PowerShell (solo lectura) y sus alias comunes
  "get-childitem", "get-content", "select-string", "get-location", "get-item", "test-path", "resolve-path", "gci", "gc", "sls", "gl", "dir", "type",
])

const GIT_LECTURA = new Set([
  "status", "log", "diff", "show", "ls-files", "ls-tree", "blame", "rev-parse", "rev-list", "describe", "shortlog", "grep", "cat-file",
])
const GIT_RAMA_OK = new Set(["-a", "-r", "-v", "-vv", "--list", "-l", "--show-current", "--all", "--remotes", "--contains", "--merged", "--no-merged"])

const FIND_PELIGRO = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"])

/** Separa una orden en segmentos y palabras respetando comillas. `null` si hay algo que no se puede analizar con seguridad. */
function trocear(orden: string): { segmentos: string[][] } | { error: string } {
  const segmentos: string[][] = []
  let palabras: string[] = []
  let actual = ""
  let hayPalabra = false
  let comilla: "'" | '"' | undefined
  const cerrarPalabra = () => {
    if (hayPalabra) palabras.push(actual)
    actual = ""
    hayPalabra = false
  }
  const cerrarSegmento = () => {
    cerrarPalabra()
    if (palabras.length > 0) segmentos.push(palabras)
    palabras = []
  }
  for (let i = 0; i < orden.length; i++) {
    const c = orden[i]
    const sig = orden[i + 1]
    if (comilla === "'") {
      if (c === "'") comilla = undefined
      else actual += c
      continue
    }
    if (comilla === '"') {
      if (c === '"') comilla = undefined
      else if (c === "`" || (c === "$" && (sig === "(" || sig === "{"))) return { error: "expansión de órdenes dentro de comillas" }
      else if (c === "\\" && sig !== undefined) {
        actual += sig
        i++
      } else actual += c
      continue
    }
    if (c === "\\" && sig !== undefined) {
      actual += sig
      hayPalabra = true
      i++
      continue
    }
    if (c === "'" || c === '"') {
      comilla = c
      hayPalabra = true
      continue
    }
    if (c === "`") return { error: "sustitución de órdenes con comilla invertida" }
    if (c === "$" && sig === "(") return { error: "sustitución de órdenes $(...)" }
    if ((c === "<" || c === ">") && sig === "(") return { error: "sustitución de procesos" }
    if (c === "<" && sig === "<") return { error: "here-document" }
    if (c === ">") {
      // Solo se aceptan descartes explícitos: >/dev/null, 2>/dev/null, 2>&1, &>/dev/null
      const resto = orden.slice(i)
      const m = resto.match(/^>\s*\/dev\/null(?![\w./-])/) ?? resto.match(/^>&[12](?![\w])/)
      if (!m) return { error: "redirección de salida (>)" }
      // el dígito previo (2>) ya se agregó a la palabra: se quita si era solo ese dígito
      if (/^[12]$/.test(actual)) {
        actual = ""
        hayPalabra = false
      }
      i += m[0].length - 1
      continue
    }
    if (c === "&") {
      if (sig === "&") {
        cerrarSegmento()
        i++
        continue
      }
      // `&>` (stdout+stderr) solo a /dev/null
      if (sig === ">") {
        const m = orden.slice(i).match(/^&>\s*\/dev\/null(?![\w./-])/)
        if (!m) return { error: "redirección de salida (&>)" }
        i += m[0].length - 1
        continue
      }
      return { error: "ejecución en segundo plano (&)" }
    }
    if (c === "|") {
      cerrarSegmento()
      if (sig === "|") i++
      continue
    }
    if (c === ";" || c === "\n" || c === "\r") {
      cerrarSegmento()
      continue
    }
    if (c === " " || c === "\t") {
      cerrarPalabra()
      continue
    }
    if (c === "(" || c === ")" || c === "{" || c === "}") return { error: "agrupación de órdenes" }
    actual += c
    hayPalabra = true
  }
  if (comilla) return { error: "comillas sin cerrar" }
  cerrarSegmento()
  return { segmentos }
}

function segmentoDeLectura(p: string[]): VeredictoLectura {
  const nombre = p[0]!.toLowerCase()
  const args = p.slice(1)
  if (nombre.includes("/") || nombre.includes("\\") || nombre.includes("=")) {
    return { ok: false, motivo: `«${p[0]}» no es una orden de lectura conocida` }
  }
  if (!LECTURA.has(nombre)) return { ok: false, motivo: `«${p[0]}» no está entre las órdenes de solo lectura` }
  const tiene = (...banderas: string[]) => args.some((a) => banderas.includes(a))
  const no = (motivo: string): VeredictoLectura => ({ ok: false, motivo })
  switch (nombre) {
    case "find":
      if (args.some((a) => FIND_PELIGRO.has(a.toLowerCase()))) return no("find con -exec/-delete/-fprint escribiría o ejecutaría")
      break
    case "sort":
      if (args.some((a) => a === "--output" || a.startsWith("--output=") || /^-[a-zA-Z]*o/.test(a))) return no("sort -o escribe un archivo")
      break
    case "tree":
      if (args.some((a) => /^-[a-zA-Z]*o/.test(a))) return no("tree -o escribe un archivo")
      break
    case "rg":
      if (args.some((a) => a === "--pre" || a.startsWith("--pre="))) return no("rg --pre ejecuta un programa")
      break
    case "date":
      if (tiene("-s", "--set") || args.some((a) => a.startsWith("--set="))) return no("date -s cambia el reloj")
      break
    case "file":
      if (tiene("-C", "--compile")) return no("file -C escribe un archivo")
      break
    case "uniq":
      if (args.filter((a) => !a.startsWith("-")).length > 1) return no("uniq con dos archivos escribe el segundo")
      break
    case "git": {
      const sub = args[0]?.toLowerCase()
      if (!sub) return no("git sin subcomando")
      const resto = args.slice(1)
      if (resto.some((a) => a === "--output" || a.startsWith("--output=") || a === "--ext-diff" || a === "--textconv" || a === "--exec-path")) {
        return no("git con --output/--ext-diff escribiría o ejecutaría")
      }
      if (sub === "branch") {
        if (resto.some((a) => !GIT_RAMA_OK.has(a))) return no("git branch solo se acepta para listar")
        break
      }
      if (sub === "tag") {
        if (resto.length > 0 && !resto.every((a) => a === "-l" || a === "--list" || a === "-n" || /^-n\d+$/.test(a))) return no("git tag solo se acepta para listar")
        break
      }
      if (sub === "remote") {
        if (resto.length > 0 && !resto.every((a) => a === "-v" || a === "--verbose")) return no("git remote solo se acepta para listar")
        break
      }
      if (!GIT_LECTURA.has(sub)) return no(`git ${args[0]} no está entre las órdenes de solo lectura`)
      break
    }
  }
  return { ok: true }
}

/**
 * ¿Es esta orden de shell de solo lectura? Lista cerrada y conservadora (capa de contención del modo plan, no un sandbox):
 * ante la duda, NO. Rechaza redirecciones de salida (salvo a /dev/null), sustituciones, segundo plano, agrupaciones y todo
 * programa que no esté en la lista; las tuberías y `&&`/`;` se aceptan si cada pieza cumple.
 */
export function comandoDeSoloLectura(orden: string): VeredictoLectura {
  if (typeof orden !== "string" || orden.trim() === "") return { ok: false, motivo: "orden vacía" }
  if (orden.length > 4000) return { ok: false, motivo: "orden demasiado larga para comprobarla" }
  const t = trocear(orden)
  if ("error" in t) return { ok: false, motivo: t.error }
  if (t.segmentos.length === 0) return { ok: false, motivo: "orden vacía" }
  for (const seg of t.segmentos) {
    const v = segmentoDeLectura(seg)
    if (!v.ok) return v
  }
  return { ok: true }
}

export const MENSAJE_SOLO_LECTURA = (motivo: string) =>
  `Modo plan: el shell solo puede leer (${motivo}). No escribas ni ejecutes nada: el único archivo que puedes escribir es el plan en .opencode/plans/*.md, con las herramientas write/edit. Si necesitas ejecutar o cambiar algo, termina el plan y pide la aprobación con plan_exit.`

/** Opciones FIJAS de las preguntas del modo plan (contrato con la app: se responde con el texto exacto de la opción). */
export const PLAN_OPCIONES = {
  aprobar: "Aprobar y editar con preguntas",
  seguir: "Seguir planificando",
} as const
export const ENTRAR_OPCIONES = {
  entrar: "Planificar primero",
  seguir: "Seguir sin plan",
} as const
/** Tope del texto del plan que viaja en el evento `session.plan.listo` (el archivo completo se lee de la ruta). */
export const PLAN_EVENTO_MAX_BYTES = 48 * 1024

/** Aprobación estricta: solo la respuesta única y EXACTA a la primera opción cuenta. Vacío, otra cosa o ruido = no aprobado. */
export function aprobado(respuestas: ReadonlyArray<ReadonlyArray<string>> | undefined, esperado: string): boolean {
  const r = respuestas?.[0]
  return respuestas?.length === 1 && r?.length === 1 && r[0] === esperado
}

/** Recorta por bytes UTF-8 sin partir un carácter. */
export function acotarTexto(texto: string, maxBytes: number): { texto: string; truncado: boolean; bytes: number } {
  const buf = Buffer.from(texto, "utf8")
  if (buf.length <= maxBytes) return { texto, truncado: false, bytes: buf.length }
  let fin = maxBytes
  while (fin > 0 && (buf[fin]! & 0xc0) === 0x80) fin--
  return { texto: buf.subarray(0, fin).toString("utf8"), truncado: true, bytes: buf.length }
}
