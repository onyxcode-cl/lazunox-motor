// Lazunox: ediciones en rutas que cambian cómo se ejecuta código o cómo se comporta la IA (hooks de git, config del motor, servidores MCP, tareas del
// editor). Aunque una regla diga «allow» (modo «aceptar ediciones», «sin preguntar»), editarlas SIEMPRE pregunta a la persona; un «siempre» o un
// plugin con `allow` no lo levantan. Un `deny` explícito sigue mandando. Se apaga con LAZUNOX_PROTECTED_PATHS=0.

const DIRS = new Set([".git", ".opencode", ".claude", ".vscode", ".idea", ".husky"])
const FILES = new Set([".mcp.json", ".gitmodules", ".gitattributes", ".gitconfig"])

export const activo = (env: NodeJS.ProcessEnv = process.env) => env.LAZUNOX_PROTECTED_PATHS !== "0"

/** `pattern` es la ruta tal como la pide la herramienta (relativa al proyecto o absoluta; con / o \). */
export const esProtegida = (pattern: string) => {
  const partes = pattern
    .replaceAll("\\", "/")
    .split("/")
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p && p !== ".")
  if (partes.length === 0) return false
  if (partes.some((p) => DIRS.has(p))) return true
  return FILES.has(partes[partes.length - 1]!)
}
