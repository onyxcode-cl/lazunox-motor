// Lazunox (Ola 7, 7.2): recortes de tokens por paso. Cada recorte tiene su interruptor y NINGUNO está encendido por defecto
// hasta que el banco con modelo real lo apruebe (ver LAZUNOX.md, «Ahorro de tokens»).
//
//   LAZUNOX_AHORRO_TOKENS = off (por defecto) | on | lista separada por comas de:
//     bash          descripción y parámetros de la herramienta de terminal más cortos (mismas reglas de seguridad y de git)
//     task          descripción de `task` más corta
//     todo          descripción de `todowrite` más corta
//     herramientas  descripciones más cortas de read, edit, write, glob y grep
//     sistema       prompt de sistema por defecto sin duplicados ni ejemplos de relleno
//     busqueda      sin LAZUNOX_TOOL_SEARCH explícito, la búsqueda diferida de herramientas MCP se comporta como `auto`
//   `on` = todos. Variable ausente o desconocida = ninguno.
export const RECORTES = ["bash", "task", "todo", "herramientas", "sistema", "busqueda"] as const
export type Recorte = (typeof RECORTES)[number]

export function recortesActivos(env: Record<string, string | undefined> = process.env): ReadonlySet<Recorte> {
  const raw = (env.LAZUNOX_AHORRO_TOKENS ?? "").trim().toLowerCase()
  if (raw === "on" || raw === "todo" || raw === "1") return new Set(RECORTES)
  return new Set(
    raw
      .split(",")
      .map((x) => x.trim())
      .filter((x): x is Recorte => (RECORTES as readonly string[]).includes(x)),
  )
}

export const recorteActivo = (recorte: Recorte, env: Record<string, string | undefined> = process.env) =>
  recortesActivos(env).has(recorte)

export * as AhorroTokens from "./ahorro-tokens"
