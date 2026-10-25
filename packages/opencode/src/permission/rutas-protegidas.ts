// Lazunox: ediciones en rutas que cambian cómo se ejecuta código o cómo se comporta la IA (hooks de git, config del motor, servidores MCP, tareas del
// editor). Aunque una regla diga «allow» (modo «aceptar ediciones», «sin preguntar»), editarlas SIEMPRE pregunta a la persona; un «siempre» o un
// plugin con `allow` no lo levantan. Un `deny` explícito sigue mandando. Se apaga con LAZUNOX_PROTECTED_PATHS=0.

import fs from "fs"
import path from "path"

const DIRS = new Set([".git", ".opencode", ".claude", ".vscode", ".idea", ".husky"])
const FILES = new Set([".mcp.json", ".gitmodules", ".gitattributes", ".gitconfig"])

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
      // ENOENT: sube un nivel. Cualquier otra cosa (ELOOP, permisos): no se puede garantizar.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return undefined
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
 * `opts.agente` y `opts.raiz` (carpeta del proyecto) son necesarios para la excepción del archivo del plan.
 */
export const esProtegida = (
  pattern: string,
  env: NodeJS.ProcessEnv = process.env,
  opts?: { agente?: string; raiz?: string },
) => {
  const partes = pattern
    .replaceAll("\\", "/")
    .split("/")
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p && p !== ".")
  if (partes.length === 0) return false
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
  if (partes.some((p) => DIRS.has(p))) return true
  return FILES.has(partes[partes.length - 1]!)
}
