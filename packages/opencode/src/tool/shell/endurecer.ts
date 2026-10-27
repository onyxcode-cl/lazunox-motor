// Lazunox (Ola 7, 7.7): endurecimiento del análisis de permisos del shell. Piezas PURAS (sin árbol de sintaxis ni disco) que `tool/shell.ts`
// usa al reunir lo que hay que preguntar. Cada una cierra un hueco encontrado en la auditoría contra Claude Code y Codex (ver LAZUNOX.md, 7.7):
//   1. Envoltorios y programas que ejecutan otro programa (`timeout 5 rm x`, `sudo rm x`, `bash -c "rm x"`, `eval`, `xargs rm`,
//      `find -exec rm {} \;`): además de la orden entera se evalúa la orden de dentro, para que un `deny rm *` o un `ask` NO se salten.
//   2. `git -C DIR`, `--git-dir=`, `--work-tree=`, `GIT_DIR=`: apuntan a otro repositorio; cuentan como rutas para `external_directory`.
//   3. Lecturas de archivos por shell (`cat .env`, `grep -f .env`, `--ignore-revs-file=.env`, `@archivo`): se piden también como permiso `read`,
//      para que las reglas de lectura del agente (`*.env: ask`, un `deny`) valgan igual que con la herramienta `read`.
// Todo es de MEJOR ESFUERZO y SOLO AÑADE preguntas o negaciones (nunca quita ni aprueba nada). Interruptor: `LAZUNOX_SHELL_ENDURECIDO=0`.

export const activo = (env: Record<string, string | undefined> = process.env) => env.LAZUNOX_SHELL_ENDURECIDO !== "0"

/** Niveles de envoltorios que se desenvuelven; más allá se deja de buscar (Codex marca como peligroso más de 8). */
export const MAX_NIVELES = 8
/** Profundidad máxima de scripts dentro de scripts (`bash -c "bash -c '…'"`). */
export const MAX_SCRIPTS = 3

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish"])

/**
 * Envoltorios: programa -> opciones que llevan un valor aparte (`nice -n 5`) y cuántos argumentos posicionales propios tiene antes de la orden
 * (`timeout 5 cmd` = 1, `flock lock cmd` = 1). Los de Claude Code (`timeout`, `time`, `nice`, `nohup`, `stdbuf`, `command`, `builtin`, `noglob`)
 * más los que ejecutan otra orden y que Claude Code no autoaprueba (`watch`, `setsid`, `ionice`, `flock`) y los de privilegios (`sudo`, `doas`, `env`, `exec`).
 */
const ENVOLTORIOS: Record<string, { valor: string[]; pos: number }> = {
  timeout: { valor: ["-s", "--signal", "-k", "--kill-after"], pos: 1 },
  time: { valor: ["-f", "--format", "-o", "--output"], pos: 0 },
  nice: { valor: ["-n", "--adjustment"], pos: 0 },
  nohup: { valor: [], pos: 0 },
  stdbuf: { valor: ["-i", "-o", "-e"], pos: 0 },
  command: { valor: [], pos: 0 },
  builtin: { valor: [], pos: 0 },
  noglob: { valor: [], pos: 0 },
  watch: { valor: ["-n", "--interval", "-d"], pos: 0 },
  setsid: { valor: [], pos: 0 },
  ionice: { valor: ["-c", "-n", "-p", "-P", "-u", "--class", "--classdata"], pos: 0 },
  flock: { valor: ["-w", "--timeout", "-E", "--conflict-exit-code"], pos: 1 },
  sudo: { valor: ["-u", "-g", "-h", "-p", "-C", "-r", "-t", "-U", "-D", "-R", "-T"], pos: 0 },
  doas: { valor: ["-u", "-C"], pos: 0 },
  env: { valor: ["-u", "-C", "--unset", "--chdir"], pos: 0 },
  exec: { valor: ["-a"], pos: 0 },
  xargs: { valor: ["-n", "-L", "-P", "-I", "-d", "-a", "-E", "-s", "--max-args", "--max-procs", "--delimiter", "--arg-file"], pos: 0 },
}

const ASIGNACION = /^[A-Za-z_][A-Za-z0-9_]*=/

const quitarComillas = (t: string) => (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0] ? t.slice(1, -1) : t)

/** Si `tokens` empieza por un envoltorio, devuelve las palabras de la orden de dentro (sin envoltorio ni sus opciones). */
function interior(tokens: string[]): string[] | undefined {
  const nombre = tokens[0]
  const e = nombre === undefined ? undefined : ENVOLTORIOS[nombre]
  if (!e) return undefined
  let i = 1
  let pos = e.pos
  while (i < tokens.length) {
    const t = tokens[i]!
    if (ASIGNACION.test(t)) {
      i++
      continue
    }
    if (t === "--") {
      i++
      break
    }
    if (t.startsWith("-") && t.length > 1) {
      i += e.valor.includes(t) ? 2 : 1
      continue
    }
    if (pos > 0) {
      pos--
      i++
      continue
    }
    break
  }
  const dentro = tokens.slice(i)
  return dentro.length > 0 ? dentro : undefined
}

/** Palabras de un `find` que van entre `-exec`/`-execdir`/`-ok`/`-okdir` y `;` o `+`: la orden que ejecuta. */
function ordenesDeFind(tokens: string[]): string[][] {
  if (tokens[0] !== "find") return []
  const out: string[][] = []
  for (let i = 1; i < tokens.length; i++) {
    if (!["-exec", "-execdir", "-ok", "-okdir"].includes(tokens[i]!)) continue
    const cmd: string[] = []
    let j = i + 1
    for (; j < tokens.length; j++) {
      const t = tokens[j]!
      if (t === ";" || t === "\\;" || t === "+") break
      cmd.push(t)
    }
    if (cmd.length > 0) out.push(cmd)
    i = j
  }
  return out
}

/** Script de un `bash -c "…"` (también `-lc`, `-ic`, `-euc`…), de un `eval …` o de un `su -c "…"`. */
function scriptDe(tokens: string[]): string | undefined {
  const nombre = tokens[0]
  if (nombre === undefined) return undefined
  if (nombre === "eval") {
    const resto = tokens.slice(1).map(quitarComillas).join(" ").trim()
    return resto || undefined
  }
  if (nombre === "su") {
    const k = tokens.findIndex((t) => t === "-c" || t === "--command")
    return k >= 0 && tokens[k + 1] !== undefined ? quitarComillas(tokens[k + 1]!) : undefined
  }
  if (!SHELLS.has(nombre)) return undefined
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t === "--") return undefined
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(t) && !t.startsWith("--")) {
      const s = tokens[i + 1]
      return s === undefined ? undefined : quitarComillas(s)
    }
    if (!t.startsWith("-")) return undefined // un archivo de script: no hay nada que leer aquí
  }
  return undefined
}

export type Desenvuelto = {
  /** Órdenes de dentro (cada una, sus palabras), en cualquier nivel de envoltorio. */
  internas: string[][]
  /** Scripts (texto) que hay que analizar como un shell completo. */
  scripts: string[]
}

/** Todo lo que `tokens` ejecuta por dentro: envoltorios (hasta 8 niveles), `find -exec`, `xargs`, `bash -c`, `eval`, `su -c`. */
export function desenvolver(tokens: string[]): Desenvuelto {
  const internas: string[][] = []
  const scripts: string[] = []
  let actual: string[] | undefined = tokens
  for (let nivel = 0; actual && nivel < MAX_NIVELES; nivel++) {
    const sc = scriptDe(actual)
    if (sc !== undefined) scripts.push(sc)
    for (const c of ordenesDeFind(actual)) {
      internas.push(c)
      const sub = desenvolver(c)
      internas.push(...sub.internas)
      scripts.push(...sub.scripts)
    }
    const dentro = interior(actual)
    if (!dentro) break
    internas.push(dentro)
    actual = dentro
  }
  return { internas, scripts }
}

// ------------------------------------------------------------------------------------------------------------- git a otro repositorio

/** Rutas a las que `git` apunta con `-C DIR`, `--git-dir[=]`, `--work-tree[=]`, `--namespace` no (no es ruta). Antes del subcomando. */
export function rutasDeGit(tokens: string[]): string[] {
  if (tokens[0] !== "git") return []
  const out: string[] = []
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]!
    if (!t.startsWith("-")) break // el subcomando: lo que sigue ya no son opciones globales
    if (t === "-C" || t === "--git-dir" || t === "--work-tree") {
      if (tokens[i + 1] !== undefined) out.push(tokens[i + 1]!)
      i++
      continue
    }
    const m = /^--(git-dir|work-tree)=(.*)$/.exec(t)
    if (m) out.push(m[2]!)
    else if (/^-C.+/.test(t)) out.push(t.slice(2))
  }
  return out
}

/** `GIT_DIR=/otro`, `GIT_WORK_TREE=…`, `GIT_INDEX_FILE=…`, `GIT_OBJECT_DIRECTORY=…` antepuestos a una orden: sus valores son rutas. */
export function rutasDeAsignaciones(asignaciones: string[]): string[] {
  const out: string[] = []
  for (const a of asignaciones) {
    const m = /^(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_CONFIG)=(.*)$/.exec(a)
    if (m && m[2]) out.push(m[2])
  }
  return out
}

// ------------------------------------------------------------------------------------------------------------- lecturas

/** Órdenes que leen los archivos que reciben (lista cerrada; mejor esfuerzo, no un límite). */
const LECTORES = new Set([
  "cat", "tac", "nl", "head", "tail", "less", "more", "bat", "wc", "sort", "uniq", "cut", "paste", "grep", "egrep", "fgrep", "rg", "ag", "sed", "awk",
  "gawk", "diff", "cmp", "strings", "od", "xxd", "hexdump", "base64", "md5sum", "sha1sum", "sha256sum", "shasum", "cp", "mv", "source", ".", "jq", "yq",
  "curl", "wget", "scp", "tar", "zip", "gzip", "file", "stat",
])

/** Palabras con pinta de ruta que una orden de lectura recibe: argumentos sueltos, `--opcion=ruta`, `-fRUTA` pegado y `@ruta`. */
export function rutasLeidas(tokens: string[]): string[] {
  const nombre = tokens[0]
  if (nombre === undefined || !LECTORES.has(nombre)) return []
  const out: string[] = []
  const añadir = (t: string) => {
    const v = quitarComillas(t)
    if (v && v !== "-" && !out.includes(v)) out.push(v)
  }
  for (const t of tokens.slice(1)) {
    if (t === "--") continue
    if (t.startsWith("--")) {
      const i = t.indexOf("=")
      if (i > 0) añadir(t.slice(i + 1))
      continue
    }
    if (t.startsWith("-")) {
      // «-f.env» (opción corta con el valor pegado): se mira el resto; «-n5» da «5», que no coincide con ninguna regla de ruta.
      if (/^-[A-Za-z]./.test(t)) añadir(t.slice(2))
      continue
    }
    añadir(t.startsWith("@") && t.length > 1 ? t.slice(1) : t)
  }
  return out.slice(0, 20)
}

/** Destinos de redirección que NO son una ruta real a vigilar. */
export function destinoIgnorable(destino: string, operador: string): boolean {
  if (operador.endsWith("&")) return true // 2>&1, >&2, <&3: duplicación de descriptores
  const d = quitarComillas(destino)
  if (d === "-" || /^\d+$/.test(d)) return operador.includes("&")
  return d === "/dev/null" || d === "/dev/stdout" || d === "/dev/stderr" || d === "/dev/stdin" || d === "/dev/tty" || d.startsWith("/dev/fd/")
}

export * as ShellEndurecer from "./endurecer"
