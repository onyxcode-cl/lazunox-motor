// Lazunox (motor-18, B): «git seguro» para el git INTERNO del motor (fotos/puntos de restauración, estado y diff del panel, id del proyecto,
// árboles de trabajo, copias de proyecto). NO se usa para el git que el modelo corre con la herramienta shell (ese va con el entorno limpio
// de A, dentro de la jaula, y con su propio endurecimiento: tool/git-endurecido.ts).
//
// Qué hace:
//  - Entorno: el limpio de A, sin ningún GIT_* heredado (salvo autor/committer) y con GIT_CONFIG_NOSYSTEM=1, GIT_ATTR_NOSYSTEM=1,
//    GIT_TERMINAL_PROMPT=0 y GIT_CONFIG_GLOBAL=/dev/null (con `conGlobal` —clone, fetch, init— se conserva la config global: credenciales, rama inicial).
//    Quitar los GIT_* heredados importa: GIT_CONFIG_COUNT/KEY/VALUE, GIT_CONFIG_PARAMETERS, GIT_EXTERNAL_DIFF, GIT_DIR, GIT_ATTR_SOURCE…
//    inyectan configuración o cambian de repositorio.
//  - Opciones `-c` (las de mayor precedencia): core.hooksPath=/dev/null, core.fsmonitor=false, core.attributesFile=/dev/null,
//    diff.external= (vacío). En diff/show/log: --no-ext-diff --no-textconv.
//  - Filtros `filter.<x>.clean/smudge/process`: el nombre <x> no se puede adivinar, así que hay dos caminos:
//      * repositorio PROPIO del motor (fotos): config controlada (la reescribe el motor si no coincide), sin info/attributes, y
//        `-c attr.tree=<árbol vacío>`, que hace que git ignore los .gitattributes de la carpeta. Sin atributo `filter`, ningún filtro corre.
//      * repositorio de la PERSONA (estado/diff): antes de un subcomando que puede aplicar filtros, se listan los `filter.*` que declara su
//        config (sistema y global ya están apagados) y se anulan uno por uno con `-c filter.<x>.clean= …` (vacío = sin filtro).
//        No se usa attr.tree aquí para no cambiar cómo se ven los archivos con `text`/`eol` en el panel.
// Apagado: LAZUNOX_GIT_SEGURO=0|off|false (vuelve a lo de antes, salvo el entorno limpio de A, que tiene su propio interruptor).

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { entornoLimpio } from "./entorno-limpio"
import type * as AppProcess from "./process"

/** Árbol vacío de git (existe siempre, aunque el repositorio no lo tenga). */
export const ARBOL_VACIO = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
export const NULO = "/dev/null"

export function activo(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.LAZUNOX_GIT_SEGURO?.trim().toLowerCase()
  return !(v === "0" || v === "off" || v === "false")
}

/** GIT_* que sí pasan (identidad para un eventual commit; la app las pone en la jaula). El resto de GIT_* se quita. */
const GIT_PERMITIDAS = new Set([
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_DATE",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_DATE",
])

/**
 * Entorno para el git interno. `conGlobal: true` (clone, fetch, init) conserva GIT_CONFIG_GLOBAL tal cual (credenciales, `url.insteadOf`).
 * `extra` (p. ej. GIT_INDEX_FILE de las fotos) va encima y no se filtra: lo pone el motor.
 */
export function entorno(extra?: Record<string, string>, opts: { conGlobal?: boolean } = {}): Record<string, string> {
  const base = entornoLimpio(process.env)
  if (!activo()) return { ...base, ...extra }
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    const n = k.toUpperCase()
    if (n.startsWith("GIT_") && !GIT_PERMITIDAS.has(n) && !(opts.conGlobal && n === "GIT_CONFIG_GLOBAL")) continue
    env[k] = v
  }
  env.GIT_CONFIG_NOSYSTEM = "1"
  env.GIT_CONFIG_SYSTEM = NULO
  env.GIT_ATTR_NOSYSTEM = "1"
  env.GIT_TERMINAL_PROMPT = "0"
  env.GCM_INTERACTIVE = "never"
  if (!opts.conGlobal) {
    env.GIT_CONFIG_GLOBAL = NULO
    env.SSH_ASKPASS = ""
  }
  // Lazunox (motor-18, G; idea del esquema de Gemini CLI, gitUtils.ts getSafeGitEnv, código propio): segunda capa por entorno con la
  // misma prioridad que `-c` (gana sobre la config del repositorio), por si un llamador olvida las opciones `-c`.
  const cfg = configPorEntorno(opts)
  env.GIT_CONFIG_COUNT = String(cfg.length)
  cfg.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k
    env[`GIT_CONFIG_VALUE_${i}`] = v
  })
  return { ...env, ...extra }
}

/** Pares clave/valor que van por GIT_CONFIG_COUNT. Con `conGlobal` (red) se conservan ayudantes de credenciales y ssh. */
export function configPorEntorno(opts: { conGlobal?: boolean } = {}): [string, string][] {
  return [
    ["core.hooksPath", NULO],
    ["core.fsmonitor", "false"],
    ["core.attributesFile", NULO],
    ["core.pager", "cat"],
    ["core.editor", ":"],
    ["sequence.editor", ":"],
    ["diff.external", ""],
    ...(opts.conGlobal ? [] : ([["credential.helper", ""], ["core.sshCommand", ""]] as [string, string][])),
  ]
}

let excludesCache: { clave: string; valor: string | undefined } | undefined

/**
 * `core.excludesFile` de la config global de la persona (o de la app en la jaula), leído una vez. Con GIT_CONFIG_GLOBAL=/dev/null se
 * perdería y las fotos empezarían a guardar lo que la persona ignora en todos sus repositorios. Es una lista de patrones: no ejecuta nada.
 */
export function excludesGlobal(): string | undefined {
  // Se vuelve a leer si cambia de dónde sale la config global (GIT_CONFIG_GLOBAL, HOME, XDG_CONFIG_HOME).
  const clave = [process.env.GIT_CONFIG_GLOBAL, process.env.HOME, process.env.XDG_CONFIG_HOME].join("\0")
  if (excludesCache?.clave === clave) return excludesCache.valor
  let valor: string | undefined
  try {
    const r = spawnSync("git", ["config", "--global", "--path", "--get", "core.excludesFile"], {
      env: { ...entornoLimpio(process.env), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    })
    const v = r.status === 0 ? r.stdout.trim() : ""
    if (v && !/[\0\n]/.test(v)) valor = v
  } catch {}
  excludesCache = { clave, valor }
  return valor
}

/** Solo pruebas. */
export function _reiniciarCache() {
  excludesCache = undefined
}

/** Opciones `-c` comunes (van ANTES del subcomando). `propio`: además ignora los .gitattributes de la carpeta. */
export function config(opts: { propio?: boolean } = {}): string[] {
  if (!activo()) return []
  const excludes = excludesGlobal()
  return [
    ...(excludes ? ["-c", `core.excludesFile=${excludes}`] : []),
    "-c",
    `core.hooksPath=${NULO}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    `core.attributesFile=${NULO}`,
    "-c",
    "diff.external=",
    ...(opts.propio ? ["-c", `attr.tree=${ARBOL_VACIO}`] : []),
  ]
}

/** Opciones globales de git que llevan un valor aparte (para saltarlas al buscar el subcomando). */
const CON_VALOR = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env", "--super-prefix"])

/** Posición del subcomando en `args` (o -1). */
export function posicionSubcomando(args: readonly string[]): number {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (CON_VALOR.has(a)) {
      i++
      continue
    }
    if (a.startsWith("-")) continue
    return i
  }
  return -1
}

export const subcomando = (args: readonly string[]) => {
  const i = posicionSubcomando(args)
  return i < 0 ? undefined : args[i]
}

/** Subcomandos de diff: se les agrega --no-ext-diff --no-textconv. */
const DE_DIFF = new Set(["diff", "diff-files", "diff-index", "diff-tree", "show", "log", "whatchanged"])

/** Subcomandos que pueden aplicar un filtro clean/smudge (leen o escriben la carpeta, o refrescan el índice). */
export const FILTRABLES = new Set([
  "add",
  "status",
  "diff",
  "diff-files",
  "diff-index",
  "checkout",
  "checkout-index",
  "restore",
  "switch",
  "reset",
  "stash",
  "rm",
  "mv",
  "apply",
  "update-index",
  "read-tree",
  "merge",
  "cherry-pick",
  "rebase",
  "revert",
  "commit",
  "worktree",
  "clone",
  "pull",
  "cat-file",
  "hash-object",
  "blame",
  "grep",
  "archive",
  "ls-files",
  "stage",
])

/** Agrega --no-ext-diff --no-textconv justo después de un subcomando de diff (si no están ya). */
export function blindar(args: readonly string[]): string[] {
  const out = [...args]
  if (!activo()) return out
  const i = posicionSubcomando(out)
  if (i < 0 || !DE_DIFF.has(out[i]!)) return out
  const extra = ["--no-ext-diff", "--no-textconv"].filter((x) => !out.includes(x))
  out.splice(i + 1, 0, ...extra)
  return out
}

/** Pide a git la lista de nombres `filter.*` de la config (con -z y --name-only). */
export const ARGS_LISTAR_FILTROS = ["config", "-z", "--name-only", "--get-regexp", "^filter\\."] as const

/** Del listado de `ARGS_LISTAR_FILTROS`, las opciones `-c` que anulan cada filtro. */
export function anularFiltros(listado: string): string[] {
  const nombres = new Set<string>()
  for (const clave of listado.split(/[\0\n]/)) {
    const m = /^filter\.(.+)\.[^.]+$/i.exec(clave.trim())
    if (m && !/[\0\n=]/.test(m[1]!)) nombres.add(m[1]!)
  }
  const out: string[] = []
  for (const x of nombres)
    out.push("-c", `filter.${x}.clean=`, "-c", `filter.${x}.smudge=`, "-c", `filter.${x}.process=`, "-c", `filter.${x}.required=false`)
  return out
}

/** Contenido canónico de la config del repositorio PROPIO de fotos (lo que antes se escribía con `git config`). */
export function configPropia(plataforma: NodeJS.Platform = process.platform, ignorecase = plataforma === "darwin" || plataforma === "win32"): string {
  const lineas = [
    "[core]",
    "\trepositoryformatversion = 0",
    `\tfilemode = ${plataforma === "win32" ? "false" : "true"}`,
    "\tbare = false",
    "\tlogallrefupdates = true",
    ...(ignorecase ? ["\tignorecase = true"] : []),
    ...(plataforma === "darwin" ? ["\tprecomposeunicode = true"] : []),
    "\tautocrlf = false",
    "\tlongpaths = true",
    "\tsymlinks = true",
    "\tfsmonitor = false",
    "\tuntrackedCache = true",
    "[feature]",
    "\tmanyFiles = true",
    "[index]",
    "\tversion = 4",
    "\tthreads = true",
  ]
  return lineas.join("\n") + "\n"
}

/**
 * Deja el repositorio PROPIO de fotos como el motor lo quiere, antes de cada uso: config canónica (la reescribe si alguien la cambió:
 * dentro de la jaula esa carpeta es escribible) y sin `info/attributes`, `commondir` ni `config.worktree`. Sin enlaces: se trabaja sobre la
 * entrada misma. Solo si el repositorio ya existe (tiene HEAD). Nunca lanza.
 */
export function sanearRepoPropio(gitdir: string, plataforma: NodeJS.Platform = process.platform): void {
  if (!activo()) return
  try {
    const st = fs.lstatSync(gitdir)
    if (!st.isDirectory() || !fs.existsSync(path.join(gitdir, "HEAD"))) return
    // Mayúsculas: si «head» también existe, el sistema de archivos no distingue (lo mismo que detecta `git init`).
    const ignorecase = fs.existsSync(path.join(gitdir, "head"))
    const esperado = configPropia(plataforma, ignorecase)
    const cfg = path.join(gitdir, "config")
    let actual: string | undefined
    try {
      if (fs.lstatSync(cfg).isFile()) actual = fs.readFileSync(cfg, "utf8")
    } catch {}
    if (actual !== esperado) {
      fs.rmSync(cfg, { force: true, recursive: true })
      const tmp = `${cfg}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      fs.writeFileSync(tmp, esperado, { flag: "wx", mode: 0o600 })
      fs.renameSync(tmp, cfg)
    }
    for (const x of [path.join("info", "attributes"), "commondir", "config.worktree"])
      fs.rmSync(path.join(gitdir, x), { force: true, recursive: true })
  } catch {}
}

/**
 * Arma un git interno sobre el repositorio de la PERSONA: entorno seguro, opciones `-c`, filtros anulados (si el subcomando puede
 * aplicarlos; cuesta un `git config` más) y --no-ext-diff/--no-textconv. `conGlobal`: clone, fetch, init (conserva la config global).
 */
export const preparar = Effect.fnUntraced(function* (
  proc: AppProcess.Interface,
  args: readonly string[],
  opts: { cwd?: string; env?: Record<string, string>; conGlobal?: boolean } = {},
) {
  const env = entorno(opts.env, { conGlobal: opts.conGlobal })
  if (!activo()) return { args: [...args], env }
  let anular: string[] = []
  if (FILTRABLES.has(subcomando(args) ?? "")) {
    const lista = yield* proc
      .run(
        ChildProcess.make("git", [...config(), ...ARGS_LISTAR_FILTROS], {
          cwd: opts.cwd,
          env,
          extendEnv: false,
          stdin: "ignore",
        }),
      )
      .pipe(Effect.catch(() => Effect.succeed(undefined)))
    anular = anularFiltros(lista?.stdout.toString("utf8") ?? "")
  }
  return { args: [...config(), ...anular, ...blindar(args)], env }
})
