// Lazunox: ediciones en rutas que cambian cómo se ejecuta código o cómo se comporta la IA (hooks de git, config del motor, servidores MCP, tareas del
// editor). Aunque una regla diga «allow» (modo «aceptar ediciones», «sin preguntar»), editarlas SIEMPRE pregunta a la persona; un «siempre» o un
// plugin con `allow` no lo levantan. Un `deny` explícito sigue mandando. Se apaga con LAZUNOX_PROTECTED_PATHS=0.

import fs from "fs"
import path from "path"

const DIRS = new Set([".git", ".opencode", ".claude", ".vscode", ".idea", ".husky"])
// lazunox.15: `opencode.json`/`opencode.jsonc` también: el motor los carga del proyecto y de sus carpetas superiores, y un conector
// MCP `local` escrito ahí arranca su `command` al cargar la carpeta. `package.json` NO (pediría permiso en cada dependencia).
// `tui.json`/`tui.jsonc` también (ronda 2): solo los cargan los clientes de terminal, pero pueden declarar `plugin` (código) y casi
// nadie los edita con la IA.
const FILES = new Set([
  ".mcp.json",
  ".gitmodules",
  ".gitattributes",
  ".gitconfig",
  "opencode.json",
  "opencode.jsonc",
  "tui.json",
  "tui.jsonc",
])

/**
 * Nombres que Windows resuelve al mismo archivo (lazunox.15, ronda 2): `opencode.json.` y `opencode.json ` (Win32 quita el punto y el
 * espacio finales), `opencode.json::$DATA` (flujo principal), y el nombre corto 8.3 (`OPENCO~1.JSO`, `GIT~1`). Se normaliza SIEMPRE
 * (también en Mac/Linux: es más prudente y no cuesta nada).
 */
const normalizarParte = (parte: string) => {
  // unidad relativa de Windows (`c:opencode.json`): se quita antes de cortar en `:`
  const sinUnidad = parte.replace(/^[a-z]:(?=[^:])/, "")
  const i = sinUnidad.indexOf(":")
  const sinFlujo = i >= 0 ? sinUnidad.slice(0, i) : sinUnidad
  return sinFlujo.replace(/[. ]+$/, "").trim()
}

/**
 * Nombre corto 8.3 de un nombre PROTEGIDO (ronda 2 de la 2.ª revisión): solo estos se tratan como protegidos, no cualquier `~N`
 * (`notes~1.md`, `build~2/x.ts` o `C:\Users\JUANPE~1\…` son benignos). Un nombre 8.3 sale de: quitar el punto inicial, tomar los
 * 6 primeros caracteres de la base + `~N`, y la extensión recortada a 3. Con muchas colisiones, Windows usa 2 letras + 4 hex + `~N`.
 */
const NOMBRES_83: { base: string; ext: string }[] = [
  ...[...DIRS].map((d) => ({ base: d.slice(1), ext: "" })),
  ...[".gitmodules", ".gitattributes", ".gitconfig"].map((f) => ({ base: f.slice(1), ext: "" })),
  { base: "mcp", ext: "jso" },
  { base: "opencode", ext: "jso" },
  { base: "tui", ext: "jso" },
]
const esNombreCorto83 = (parte: string) => {
  const m = /^(.{1,6})~(\d+)(?:\.(.{0,3}))?$/.exec(parte)
  if (!m) return false
  const pref = m[1]!
  const ext = m[3] ?? ""
  return NOMBRES_83.some(
    (n) =>
      n.ext === ext && (pref === n.base.slice(0, 6) || (pref.length === 6 && pref.slice(0, 2) === n.base.slice(0, 2) && /^[0-9a-f]{4}$/.test(pref.slice(2)))),
  )
}

export const activo = (env: NodeJS.ProcessEnv = process.env) => env.LAZUNOX_PROTECTED_PATHS !== "0"

/** `realpath` del ancestro más profundo que exista + el resto sin resolver. `undefined` si hay un enlace roto (no se puede garantizar). */
function realProfundo(p: string): string | undefined {
  const resto: string[] = []
  let actual = path.resolve(p)
  for (;;) {
    let existe = true
    try {
      fs.lstatSync(actual)
    } catch (e) {
      // ENOENT/ENOTDIR: sube un nivel. Cualquier otra cosa (ELOOP, permisos): no se puede garantizar.
      const code = (e as NodeJS.ErrnoException).code
      if (code !== "ENOENT" && code !== "ENOTDIR") return undefined
      existe = false
    }
    if (existe) {
      // existe como entrada (puede ser un enlace ROTO: entonces realpath falla y no se garantiza nada)
      try {
        return path.join(fs.realpathSync(actual), ...resto)
      } catch {
        return undefined
      }
    }
    const padre = path.dirname(actual)
    if (padre === actual) return undefined
    resto.unshift(path.basename(actual))
    actual = padre
  }
}

/** El destino, resuelto con realpath (siguiendo enlaces simbólicos), queda DENTRO de `<proyecto>/.opencode/plans`. */
export function dentroDeLosPlanes(pattern: string, raiz: string): boolean {
  // En POSIX la barra invertida no separa carpetas: un nombre así no es el del plan (se pregunta).
  if (path.sep === "/" && pattern.includes("\\")) return false
  const realRaiz = realProfundo(raiz)
  const planes = realProfundo(path.join(raiz, ".opencode", "plans"))
  const destino = realProfundo(path.resolve(raiz, pattern))
  if (!realRaiz || !planes || !destino) return false
  // `.opencode` o `.opencode/plans` no pueden ser enlaces a otra parte (ni siquiera a otra carpeta del proyecto)
  if (planes !== path.join(realRaiz, ".opencode", "plans")) return false
  const rel = path.relative(planes, destino)
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel) && !rel.includes(path.sep)
}

/**
 * `pattern` es la ruta tal como la pide la herramienta (relativa al proyecto o absoluta; con / o \).
 * `opts.agente` y `opts.raiz` (carpeta del proyecto) son necesarios para la excepción del archivo del plan y para resolver enlaces;
 * `opts.base` es la carpeta contra la que se construyó `pattern` (por defecto `raiz`).
 */
export const esProtegida = (
  pattern: string,
  env: NodeJS.ProcessEnv = process.env,
  opts?: { agente?: string; raiz?: string; base?: string },
) => {
  const porNombre = nombreProtegido(pattern, env, opts)
  if (porNombre !== null) return porNombre
  return opts?.raiz !== undefined && protegidoPorEnlace(pattern, opts.raiz, opts.base ?? opts.raiz)
}

/**
 * Enlaces simbólicos (lazunox.15, 2.ª y 3.ª ronda): las escrituras siguen el enlace, así que `notas.cfg -> .git/config` o el enlace roto
 * `ajustes.json -> opencode.json` editarían un destino protegido sin tarjeta. Se resuelve la ruta de forma FÍSICA (componente a
 * componente, como el sistema: `..` se aplica sobre la carpeta ya resuelta, no sobre el texto), también con enlaces rotos (se usa el
 * destino previsto) y en cadena; se canoniza con `realProfundo` (mayúsculas/forma de lo que existe) y se mira el nombre del destino:
 * relativo al proyecto si queda dentro, o la ruta absoluta si queda fuera (`external_directory` es léxico y no sigue enlaces, así que
 * no frena un enlace del repositorio hacia `~/.config/opencode/opencode.json`, `~/.gitconfig` o un `.git` ajeno). Un bucle de enlaces
 * se trata como protegido. Carrera entre pedir y escribir (TOCTOU) y enlaces duros: no cubiertos.
 */
function destinoConEnlaces(abs: string): string | "bucle" {
  const { root } = path.parse(path.resolve(abs))
  let cola = path.resolve(abs).slice(root.length).split(path.sep).filter(Boolean)
  let cur = root
  let saltos = 0
  while (cola.length) {
    const c = cola.shift()!
    if (c === ".") continue
    if (c === "..") {
      cur = path.dirname(cur)
      continue
    }
    const sig = path.join(cur, c)
    let st: fs.Stats
    try {
      st = fs.lstatSync(sig)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      // Solo «no existe» (o un componente que no es carpeta) deja el resto tal cual; cualquier otro error (ELOOP, ENAMETOOLONG,
      // EACCES…) = no se puede garantizar = protegido (pregunta), porque el sistema podría resolverlo distinto.
      if (code !== "ENOENT" && code !== "ENOTDIR") return "bucle"
      return path.join(sig, ...cola)
    }
    if (st.isSymbolicLink()) {
      if (++saltos > 40) return "bucle"
      let d: string
      try {
        d = fs.readlinkSync(sig)
      } catch {
        return "bucle"
      }
      if (process.platform === "win32") d = d.replace(/^\\\\\?\\/, "") // prefijo `\\?\` de las rutas largas
      if (path.isAbsolute(d)) {
        const r = path.parse(d).root
        cur = r
        d = d.slice(r.length)
      }
      cola = [...d.split(process.platform === "win32" ? /[\\/]/ : "/").filter(Boolean), ...cola]
      continue
    }
    cur = sig
  }
  return cur
}

/**
 * `raiz` es el proyecto (para decidir dentro/fuera); `base` es la carpeta contra la que las herramientas construyeron `pattern`
 * (`worktree` del motor, que en un proyecto SIN git es `/`): si no coinciden, en carpetas sin git el patrón se resolvía a una ruta que no existe.
 */
function protegidoPorEnlace(pattern: string, raiz: string, base: string): boolean {
  const realRaiz = realProfundo(raiz) ?? path.resolve(raiz)
  const fisico = destinoConEnlaces(path.resolve(base, pattern))
  if (fisico === "bucle") return true
  const destino = realProfundo(fisico)
  if (destino === undefined) return true // enlace roto o error al canonizar: no se puede garantizar
  const rel = path.relative(realRaiz, destino)
  const fuera = rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)
  return nombreProtegido(fuera ? destino : rel, {} as NodeJS.ProcessEnv, undefined) === true
}

/** `true`/`false` si el NOMBRE de la ruta ya decide (protegida, o la excepción del plan); `null` si no decide y hay que mirar los enlaces. */
function nombreProtegido(
  pattern: string,
  env: NodeJS.ProcessEnv,
  opts?: { agente?: string; raiz?: string; base?: string },
): boolean | null {
  const partes = pattern
    .replaceAll("\\", "/")
    .split("/")
    .map((p) => p.normalize("NFKC").toLowerCase().trim())
    .filter((p) => p && p !== ".")
  if (partes.length === 0) return null
  // Lazunox (2C, modo plan): los planes (`.opencode/plans/<nombre>.md`, relativos al proyecto) son markdown inerte que el motor
  // nunca carga como instrucciones ni agentes; sin esta excepción cada escritura del plan pediría permiso. Solo con LAZUNOX_PLAN=1.
  if (
    (env.LAZUNOX_PLAN === "1" || env.LAZUNOX_PLAN === "true") &&
    partes.length === 3 &&
    partes[0] === ".opencode" &&
    partes[1] === "plans" &&
    partes[2]!.endsWith(".md") &&
    partes[2] !== ".md" &&
    // Revisión de seguridad H4: solo el agente `plan`, y solo si el destino REAL (sin enlaces simbólicos) queda dentro de los planes
    opts?.agente === "plan" &&
    opts.raiz !== undefined &&
    dentroDeLosPlanes(pattern, opts.raiz)
  ) {
    return false
  }
  const norm = partes.map(normalizarParte).filter(Boolean)
  if (norm.some((p) => DIRS.has(p) || esNombreCorto83(p))) return true
  if (norm.length > 0 && FILES.has(norm[norm.length - 1]!)) return true
  return null
}
