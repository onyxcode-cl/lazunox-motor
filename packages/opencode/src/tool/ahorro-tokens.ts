// Lazunox (Ola 7, 7.2): recortes de tokens por paso. Cada recorte tiene su interruptor y NINGUNO está encendido por defecto
// ENCENDIDOS por defecto (orden de Ben, 2026-10-27, sin n>=5: ver LAZUNOX.md «Ahorro de tokens»). Apagar: LAZUNOX_AHORRO_TOKENS=0.
//
//   LAZUNOX_AHORRO_TOKENS = on (por defecto, también ausente) | 0 / off | lista separada por comas de:
//     bash          descripción y parámetros de la herramienta de terminal más cortos (mismas reglas de seguridad y de git)
//     task          descripción de `task` más corta
//     todo          descripción de `todowrite` más corta
//     herramientas  descripciones más cortas de read, edit, write, glob y grep
//     sistema       prompt de sistema por defecto sin duplicados ni ejemplos de relleno
//     busqueda      sin LAZUNOX_TOOL_SEARCH explícito, la búsqueda diferida de herramientas MCP se comporta como `auto`
//     cache         la ruta temporal sale de la descripción de la terminal y va al bloque de entorno (herramientas idénticas entre proyectos); el subagente usa la clave de caché de su padre
//   `on` = todos. `0`, `off`, `false` o `no` = ninguno.
export const RECORTES = ["bash", "task", "todo", "herramientas", "sistema", "busqueda", "cache"] as const
export type Recorte = (typeof RECORTES)[number]

export function recortesActivos(env: Record<string, string | undefined> = process.env): ReadonlySet<Recorte> {
  const raw = (env.LAZUNOX_AHORRO_TOKENS ?? "").trim().toLowerCase()
  if (raw === "" || raw === "on" || raw === "todo" || raw === "1") return new Set(RECORTES)
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
