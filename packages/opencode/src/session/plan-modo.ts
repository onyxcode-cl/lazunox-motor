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

/**
 * LISTA BLANCA estricta por orden y por bandera. Una orden solo pasa si TODAS sus opciones están aquí con su nombre exacto:
 * las abreviaturas de opciones largas (GNU acepta prefijos: `--out` = `--output`) y cualquier opción desconocida se rechazan.
 * No hay lista negra: lo que no se nombra no pasa. Quitadas a propósito: `sort`/`uniq` (escriben), `tree` (-H/-o), `printf`,
 * `test` y `[` (evalúan subíndices de arreglos con -v), `sed`, `awk`, `xargs`, intérpretes, etc.
 */
type Espec = {
  /** letras de opciones cortas sin valor */
  c?: string
  /** letras de opciones cortas con valor (pegado o en el argumento siguiente) */
  cv?: string
  /** opciones largas exactas sin valor */
  l?: string[]
  /** opciones largas exactas con valor obligatorio (`--x=v` o `--x v`) */
  lv?: string[]
  /** opciones largas exactas con valor opcional (solo `--x` o `--x=v`) */
  lo?: string[]
  /** los dígitos sueltos (`-5`) son una opción (head/tail/git log) */
  dig?: boolean
  /** opciones de un solo guion y varias letras (find, `-name`) sin valor / con valor */
  g?: string[]
  gv?: string[]
  /** comprobación extra de los argumentos posicionales */
  pos?: (pos: string[], todas: string[]) => string | undefined
}

const Lc = (...x: string[]) => x
const SIN: Espec = {}

const ESPEC: Record<string, Espec> = {
  ls: {
    c: "aAlhRtSr1dFipsLgonGcuUxCmqk",
    l: Lc("all", "almost-all", "human-readable", "recursive", "directory", "classify", "reverse", "inode", "size", "dereference", "no-group", "numeric-uid-gid"),
    lo: Lc("color", "sort", "time"),
  },
  cat: { c: "nbsAeEtTvu", l: Lc("number", "number-nonblank", "squeeze-blank", "show-all", "show-ends", "show-tabs", "show-nonprinting") },
  head: { c: "qv", cv: "nc", dig: true, l: Lc("quiet", "silent", "verbose"), lv: Lc("lines", "bytes") },
  tail: { c: "qv", cv: "nc", dig: true, l: Lc("quiet", "silent", "verbose"), lv: Lc("lines", "bytes") },
  wc: { c: "lwcmL", l: Lc("lines", "words", "bytes", "chars", "max-line-length") },
  pwd: { c: "LP", l: Lc("logical", "physical") },
  file: { c: "biLz", l: Lc("brief", "mime", "mime-type", "mime-encoding", "dereference") },
  stat: { c: "Lt", cv: "c", l: Lc("dereference", "terse"), lv: Lc("format") },
  du: { c: "hsackxmH", cv: "d", l: Lc("human-readable", "summarize", "all", "total", "apparent-size"), lv: Lc("max-depth") },
  df: { c: "hkTaiP", l: Lc("human-readable", "all", "print-type") },
  which: { c: "a" },
  whoami: SIN,
  true: SIN,
  false: SIN,
  uname: { c: "asrmnvp" },
  basename: { c: "as", cv: "s", l: Lc("multiple") },
  dirname: SIN,
  realpath: { c: "emsqLP", l: Lc("canonicalize-existing", "canonicalize-missing", "no-symlinks", "quiet") },
  readlink: { c: "femn", l: Lc("canonicalize", "canonicalize-existing", "canonicalize-missing", "no-newline") },
  cd: { c: "LP" },
  echo: { c: "neE" },
  date: {
    c: "u",
    cv: "d",
    l: Lc("utc", "universal"),
    lv: Lc("date"),
    // una fecha posicional sin «+» FIJA el reloj en BSD/macOS
    pos: (pos) => (pos.some((x) => !x.startsWith("+")) ? "date con argumento que no es +formato podría cambiar el reloj" : undefined),
  },
  cut: { c: "sn", cv: "dfcb", l: Lc("complement", "only-delimited"), lv: Lc("delimiter", "fields", "characters", "bytes") },
  tr: { c: "dscC", l: Lc("delete", "squeeze-repeats", "complement") },
  nl: { cv: "bdfhilnsvw", c: "p" },
  column: { c: "tx", cv: "sc" },
  fold: { c: "sb", cv: "w" },
  rev: SIN,
  tac: SIN,
  od: { c: "cxdoabfi", cv: "AtNjw" },
  hexdump: { c: "Cbcdox", cv: "ns" },
  strings: { c: "afo", cv: "n" },
  diff: {
    c: "uqrNwbBiyac",
    cv: "UC",
    l: Lc("brief", "unified", "recursive", "new-file", "ignore-all-space", "ignore-space-change", "ignore-case", "side-by-side", "text", "no-dereference"),
    lo: Lc("color"),
  },
  cmp: { c: "sl", cv: "n", l: Lc("silent", "quiet", "verbose") },
  jq: { c: "rcesnMSajR", l: Lc("raw-output", "compact-output", "exit-status", "slurp", "null-input", "monochrome-output", "sort-keys", "ascii-output", "join-output", "raw-input", "tab"), lv: Lc("indent") },
}
// md5sum y similares: sin opciones útiles que no sean inocuas
for (const h of ["md5sum", "sha1sum", "sha256sum"]) ESPEC[h] = { c: "b", l: Lc("binary", "text") }

const GREP: Espec = {
  c: "ivnclLhHrRwxoqsEFGPaIzbTU",
  cv: "eAmBCf",
  dig: true,
  l: Lc(
    "ignore-case", "invert-match", "line-number", "count", "files-with-matches", "files-without-match", "no-filename", "with-filename",
    "recursive", "dereference-recursive", "word-regexp", "line-regexp", "only-matching", "quiet", "silent", "no-messages",
    "extended-regexp", "fixed-strings", "basic-regexp", "perl-regexp", "text", "null-data", "byte-offset", "initial-tab", "null",
  ),
  lv: Lc("regexp", "after-context", "before-context", "context", "max-count", "include", "exclude", "exclude-dir", "file"),
  lo: Lc("color", "colour"),
}
ESPEC.grep = GREP
ESPEC.egrep = GREP
ESPEC.fgrep = GREP

// ripgrep: SIN --pre, --pre-glob, --hostname-bin, -z/--search-zip ni --no-config (todo lo que ejecuta un programa)
ESPEC.rg = {
  c: "isSnNclwxvoqHIuUaLFPb",
  cv: "AeBCfgtTmjMEr",
  l: Lc(
    "files", "hidden", "no-ignore", "no-ignore-vcs", "no-ignore-dot", "no-ignore-parent", "json", "count", "count-matches",
    "files-with-matches", "files-without-match", "no-heading", "heading", "line-number", "no-line-number", "with-filename",
    "no-filename", "column", "fixed-strings", "ignore-case", "smart-case", "case-sensitive", "word-regexp", "line-regexp",
    "invert-match", "only-matching", "multiline", "multiline-dotall", "follow", "stats", "quiet", "no-messages", "text",
    "pcre2", "type-list", "null", "trim", "vimgrep", "unrestricted", "binary", "no-binary", "sort-files",
  ),
  lv: Lc(
    "glob", "iglob", "type", "type-not", "max-depth", "max-count", "context", "after-context", "before-context", "regexp",
    "file", "sort", "sortr", "threads", "replace", "max-filesize", "encoding", "path-separator",
  ),
  lo: Lc("color"),
}

const FIND_SIN = Lc("-not", "-and", "-or", "-o", "-a", "-print", "-empty", "-true", "-false", "-readable", "-writable", "-executable", "-prune", "-depth", "-mount", "-xdev", "-print0", "-nogroup", "-nouser")
const FIND_VAL = Lc(
  "-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-type", "-maxdepth", "-mindepth", "-size", "-mtime", "-atime",
  "-ctime", "-mmin", "-amin", "-cmin", "-newer", "-regex", "-iregex", "-perm", "-user", "-group", "-lname", "-ilname", "-links", "-inum",
)
ESPEC.find = { g: FIND_SIN, gv: FIND_VAL, c: "", pos: () => undefined }

// --- git: solo estos subcomandos y solo estas opciones ---
const GIT_DIFF_COMUN = {
  c: "pusbwMC",
  cv: "UnS",
  l: Lc(
    "patch", "stat", "numstat", "shortstat", "name-only", "name-status", "cached", "staged", "no-color", "check", "summary", "no-renames",
    "minimal", "patience", "histogram", "ignore-all-space", "ignore-space-change", "no-ext-diff", "quiet", "raw", "full-index", "binary",
    "abbrev-commit", "no-abbrev-commit", "oneline", "graph", "decorate", "no-decorate", "all", "no-merges", "merges", "first-parent",
    "reverse", "follow", "left-right", "cherry-pick", "date-order", "topo-order", "no-patch", "find-renames", "pickaxe-regex",
    "source", "pretty", "show-signature", "stdin-never", "ignore-blank-lines",
  ),
  lo: Lc("color", "abbrev", "word-diff", "decorate", "date", "find-copies", "format", "pretty", "diff-filter", "dirstat", "unified", "relative", "stat-width", "word-diff-regex", "color-moved"),
  lv: Lc("max-count", "skip", "since", "until", "after", "before", "author", "committer", "grep", "diff-filter"),
} satisfies Espec
const GITSPEC: Record<string, Espec> = {
  status: { c: "sbvu", l: Lc("short", "branch", "long", "ignored", "no-renames", "ahead-behind"), lo: Lc("porcelain", "untracked-files", "ignored") },
  log: { ...GIT_DIFF_COMUN, dig: true, lo: [...GIT_DIFF_COMUN.lo, "since", "until", "author", "grep", "max-count", "after", "before", "committer"], lv: ["max-count", "skip"] },
  diff: { ...GIT_DIFF_COMUN, dig: false },
  show: { ...GIT_DIFF_COMUN, dig: false },
  "ls-files": { c: "cdmosizutvfk", l: Lc("cached", "deleted", "modified", "others", "stage", "ignored", "unmerged", "killed", "exclude-standard", "full-name", "directory", "no-empty-directory", "eol", "deduplicate") },
  "ls-tree": { c: "rtdl", l: Lc("name-only", "name-status", "full-name", "full-tree", "long"), lo: Lc("abbrev") },
  blame: { c: "lseSwMCpt", cv: "L", l: Lc("porcelain", "line-porcelain", "show-email", "show-name", "show-number", "root"), lo: Lc("abbrev") },
  "rev-parse": {
    c: "q",
    l: Lc("show-toplevel", "git-dir", "is-inside-work-tree", "verify", "symbolic-full-name", "absolute-git-dir", "show-prefix", "show-cdup", "git-common-dir", "is-bare-repository", "is-inside-git-dir", "symbolic", "all", "branches", "tags", "remotes", "quiet"),
    lo: Lc("abbrev-ref", "short"),
  },
  "rev-list": { c: "n", cv: "n", l: Lc("count", "all", "no-merges", "merges", "reverse", "first-parent", "oneline", "abbrev-commit", "left-right", "branches", "tags", "remotes"), lo: Lc("max-count", "since", "until", "author", "after", "before", "skip") },
  describe: { l: Lc("tags", "always", "long", "dirty", "exact-match", "contains", "all", "first-parent"), lo: Lc("abbrev", "match", "exclude", "candidates") },
  shortlog: { c: "snec", l: Lc("summary", "numbered", "email", "committer"), lo: Lc("since", "until", "after", "before", "group", "format") },
  "cat-file": { c: "tpse" },
  grep: {
    // SIN -O / --open-files-in-pager (ejecuta un programa) ni --no-index con rutas externas especiales
    c: "nivwEFGPlLcaHhIqz",
    cv: "eABCf",
    dig: true,
    l: Lc("line-number", "ignore-case", "invert-match", "word-regexp", "extended-regexp", "fixed-strings", "basic-regexp", "perl-regexp", "files-with-matches", "files-without-match", "name-only", "count", "text", "heading", "break", "full-name", "untracked", "no-index", "cached", "no-color", "and", "or", "not", "quiet", "null"),
    lv: Lc("regexp", "after-context", "before-context", "context", "max-depth", "file"),
    lo: Lc("color"),
  },
}

type Res = { ok: true; pos: string[] } | { ok: false; motivo: string }

/** Recorre los argumentos contra una especificación. Cualquier opción fuera de la lista blanca => rechazo. */
function revisarOpciones(nombre: string, args: string[], e: Espec): Res {
  const pos: string[] = []
  const rechazo = (o: string): Res => ({ ok: false, motivo: `${nombre}: la opción «${o}» no está permitida en modo plan` })
  const has = (arr: string[] | undefined, x: string) => arr?.includes(x) === true
  let finOpciones = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (finOpciones || a === "-" || !a.startsWith("-")) {
      pos.push(a)
      continue
    }
    if (a === "--") {
      finOpciones = true
      continue
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=")
      const n = (eq === -1 ? a : a.slice(0, eq)).slice(2)
      const conValor = eq !== -1
      if (has(e.l, n)) {
        if (conValor) return rechazo(a)
      } else if (has(e.lv, n)) {
        if (!conValor) i++
      } else if (has(e.lo, n)) {
        // valor opcional, solo con «=»
      } else return rechazo(a)
      continue
    }
    // un solo guion: primero las opciones de varias letras (find)
    if (has(e.g, a)) continue
    if (has(e.gv, a)) {
      i++
      continue
    }
    if (nombre === "find") return rechazo(a)
    // grupo de letras cortas
    for (let k = 1; k < a.length; k++) {
      const ch = a[k]!
      if (e.c?.includes(ch)) continue
      if (e.dig && /[0-9]/.test(ch)) continue
      if (e.cv?.includes(ch)) {
        if (k === a.length - 1) i++
        break
      }
      return rechazo(`-${ch}`)
    }
  }
  return { ok: true, pos }
}

function revisarGit(args: string[]): VeredictoLectura {
  const no = (motivo: string): VeredictoLectura => ({ ok: false, motivo })
  const sub = args[0]
  if (!sub || sub.startsWith("-")) return no("git con opciones globales o sin subcomando (-c, -C, --exec-path... ejecutan o cambian cosas)")
  const resto = args.slice(1)
  if (sub === "branch") {
    const r = revisarOpciones("git branch", resto, {
      c: "alrv",
      l: Lc("list", "show-current", "all", "remotes", "verbose", "no-color"),
      lv: Lc("contains", "no-contains", "merged", "no-merged", "sort", "points-at"),
      lo: Lc("color", "format"),
    })
    if (!r.ok) return r
    if (r.pos.length > 0 && !resto.some((a) => a === "-l" || a === "--list")) return no("git branch con nombre crearía una rama")
    return { ok: true }
  }
  if (sub === "tag") {
    const r = revisarOpciones("git tag", resto, { c: "ln", dig: true, l: Lc("list"), lv: Lc("contains", "no-contains", "points-at", "merged", "no-merged", "sort"), lo: Lc("color", "format") })
    if (!r.ok) return r
    if (r.pos.length > 0 && !resto.some((a) => a === "-l" || a === "--list")) return no("git tag con nombre crearía una etiqueta")
    return { ok: true }
  }
  if (sub === "remote") {
    const r = revisarOpciones("git remote", resto, { c: "v", l: Lc("verbose") })
    if (!r.ok) return r
    return r.pos.length > 0 ? no("git remote solo se acepta para listar") : { ok: true }
  }
  const e = GITSPEC[sub.toLowerCase()]
  if (!e || sub !== sub.toLowerCase()) return no(`git ${sub} no está entre las órdenes de solo lectura`)
  const r = revisarOpciones(`git ${sub}`, resto, e)
  return r.ok ? { ok: true } : r
}

function segmentoDeLectura(p: string[]): VeredictoLectura {
  const nombre = p[0]!
  const args = p.slice(1)
  if (nombre.includes("/") || nombre.includes("\\") || nombre.includes("=") || nombre !== nombre.toLowerCase()) {
    return { ok: false, motivo: `«${p[0]}» no es una orden de lectura conocida` }
  }
  if (nombre === "git") return revisarGit(args)
  const e = ESPEC[nombre]
  if (!e || !Object.hasOwn(ESPEC, nombre)) return { ok: false, motivo: `«${p[0]}» no está entre las órdenes de solo lectura` }
  const r = revisarOpciones(nombre, args, e)
  if (!r.ok) return r
  const extra = e.pos?.(r.pos, args)
  return extra ? { ok: false, motivo: extra } : { ok: true }
}

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
        // `\<salto de línea>` desaparece al ejecutar (continuación de línea): un guion podría "aparecer" después de comprobar
        if (sig === "\n" || sig === "\r") return { error: "continuación de línea con \\" }
        actual += sig
        i++
      } else actual += c
      continue
    }
    if (c === "\\" && sig !== undefined) {
      if (sig === "\n" || sig === "\r") return { error: "continuación de línea con \\" }
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
    // `$VAR` sin comillas se parte por IFS y `$'\x2d..'` fabrica opciones DESPUÉS de comprobar: no se acepta ninguna expansión sin comillas
    if (c === "$") return { error: "expansión de variables o de cadenas $'...' sin comillas" }
    if (c === "\r") return { error: "retorno de carro en la orden" }
    if (c === "<" && sig === ">") return { error: "redirección de lectura y escritura (<>)" }
    // Comodines sin comillas: el nombre de un archivo del proyecto como «--pre=x» se convertiría en opción al expandirse. Solo se
    // aceptan con un prefijo literal que no empiece por «-» (p. ej. «./*.ts», «src/*»).
    if ((c === "*" || c === "?" || c === "[") && (actual === "" || actual.startsWith("-"))) {
      return { error: "comodín sin prefijo literal (usa ./*.ts o src/*.ts)" }
    }
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

/**
 * ¿Es esta orden de shell de solo lectura? Lista cerrada y conservadora (capa de contención del modo plan, no un sandbox):
 * ante la duda, NO. Rechaza redirecciones de salida (salvo a /dev/null), sustituciones, segundo plano, agrupaciones y todo
 * programa que no esté en la lista; las tuberías y `&&`/`;` se aceptan si cada pieza cumple.
 */
/** Shells cuya sintaxis (comillas, `\`) analiza `trocear`. En cualquier otro (PowerShell, cmd, fish, nu...) el shell se NIEGA en modo plan. */
export const SHELLS_ANALIZABLES = new Set(["bash", "zsh", "sh", "dash", "ash"])

export function comandoDeSoloLectura(orden: string, opts?: { shell?: string }): VeredictoLectura {
  if (opts?.shell !== undefined && !SHELLS_ANALIZABLES.has(opts.shell.toLowerCase())) {
    return {
      ok: false,
      motivo: `el shell «${opts.shell}» no se puede analizar con seguridad (PowerShell y cmd tratan «\\» y las comillas de otra forma); usa las herramientas read, grep y glob`,
    }
  }
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
