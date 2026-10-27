// Lazunox (Ola 7, 7.6): filtro `if` de los ganchos de usuario. UNA sola regla con la sintaxis de permisos de Claude Code
// (`Bash(git *)`, `Edit(*.ts)`, `Read`), solo para eventos de herramienta. Es de MEJOR ESFUERZO, no una frontera de seguridad: si la
// regla no se entiende, o no se puede analizar el comando (comillas sin cerrar, sustituciones, heredocs, `eval`…), el gancho CORRE igual.
// Para decidir QUÉ se salta, un gancho con `if` solo se omite cuando la regla se pudo evaluar y NO coincide con ninguna parte del comando.
import path from "node:path"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { rutasDePatch } from "@/session/reglas-ruta"

export const IF_MAX = 300

/** Nombres de Claude Code (en minúsculas) → ids de herramienta del motor. El resto se compara por nombre exacto sin distinguir mayúsculas. */
const ALIAS: Record<string, string[]> = {
  bash: ["bash"],
  read: ["read"],
  edit: ["edit", "write", "apply_patch", "patch", "multiedit"],
  multiedit: ["edit", "multiedit"],
  write: ["write"],
  glob: ["glob"],
  grep: ["grep"],
  webfetch: ["webfetch"],
  websearch: ["websearch"],
  task: ["task"],
  agent: ["task"],
}

const ENVOLTORIOS = new Set(["timeout", "time", "nice", "nohup", "stdbuf", "command", "builtin", "noglob"])

type Regla = { herramienta: string; patron?: string }

export function leerRegla(texto: string): Regla | undefined {
  const t = texto.trim()
  if (!t || t.length > IF_MAX) return undefined
  const m = /^([A-Za-z_][\w:.-]*)(?:\(([\s\S]*)\))?$/.exec(t)
  if (!m) return undefined
  const patron = m[2]?.trim()
  return { herramienta: m[1]!, patron: patron ? patron : undefined }
}

function herramientaCoincide(nombre: string, tool: string) {
  const n = nombre.toLowerCase().replace(/^mcp__([^_]+)__/, "$1_")
  const t = tool.toLowerCase()
  return (ALIAS[n] ?? [n]).includes(t)
}

/**
 * Partes de un comando compuesto, o `undefined` si no se puede analizar con seguridad (comillas sin cerrar, `$(…)`, comillas invertidas,
 * heredocs, sustituciones de proceso, `eval`). Divide por `&&`, `||`, `;`, `|`, `&` y saltos de línea fuera de comillas.
 */
export function partesDeComando(comando: string): string[] | undefined {
  const partes: string[] = []
  let actual = ""
  let comilla: "'" | '"' | undefined
  for (let i = 0; i < comando.length; i++) {
    const c = comando[i]!
    const sig = comando[i + 1]
    if (comilla === "'") {
      if (c === "'") comilla = undefined
      actual += c
      continue
    }
    if (c === "\\") {
      actual += c + (sig ?? "")
      i++
      continue
    }
    if (c === "`") return undefined
    if (c === "$" && sig === "(") return undefined
    if (comilla === '"') {
      if (c === '"') comilla = undefined
      actual += c
      continue
    }
    if (c === "'" || c === '"') {
      comilla = c
      actual += c
      continue
    }
    if ((c === "<" || c === ">") && sig === "(") return undefined
    if (c === "<" && sig === "<") return undefined
    if (c === "&" || c === "|" || c === ";" || c === "\n") {
      if ((c === "&" || c === "|") && sig === c) i++
      if (c === "&" && sig === ">") {
        actual += c
        continue
      }
      partes.push(actual)
      actual = ""
      continue
    }
    actual += c
  }
  if (comilla) return undefined
  partes.push(actual)
  const limpias = partes.map((p) => p.trim()).filter(Boolean)
  if (limpias.some((p) => /^eval(\s|$)/.test(p))) return undefined
  return limpias
}

/** Quita asignaciones de entorno iniciales y envoltorios simples (`timeout 5`, `nice -n 10`, `time`…) antes de comparar. */
export function sinEnvoltorios(parte: string): string {
  const pal = parte.trim().split(/\s+/)
  let i = 0
  for (;;) {
    while (i < pal.length && /^[A-Za-z_]\w*=\S*$/.test(pal[i]!)) i++
    if (i < pal.length && ENVOLTORIOS.has(pal[i]!)) {
      i++
      while (i < pal.length && (/^-/.test(pal[i]!) || /^\d+(\.\d+)?[smhd]?$/.test(pal[i]!))) i++
      continue
    }
    break
  }
  return pal.slice(i).join(" ")
}

/** Sujeto con el que se compara el patrón: el comando (partes), o las rutas/URL/patrón de la llamada. `undefined` = no se sabe. */
function sujetos(tool: string, args: unknown, cwd: string): string[] | undefined {
  if (!args || typeof args !== "object") return undefined
  const a = args as Record<string, unknown>
  if (tool === "bash") {
    if (typeof a.command !== "string") return undefined
    const partes = partesDeComando(a.command)
    return partes?.map(sinEnvoltorios)
  }
  if (tool === "apply_patch") return typeof a.patchText === "string" ? rutasDePatch(a.patchText) : undefined
  for (const k of ["filePath", "file_path", "path", "url", "pattern", "subagent_type", "description", "query"]) {
    const v = a[k]
    if (typeof v === "string" && v) {
      if (path.isAbsolute(v) && v.startsWith(cwd + path.sep)) return [v, path.relative(cwd, v)]
      return [v]
    }
  }
  return undefined
}

/**
 * ¿Corre el gancho? `true` si no hay `if`, si la regla no se entiende, si no se puede analizar la llamada o si la regla coincide.
 * `false` solo cuando se pudo evaluar y la herramienta o el patrón no coinciden.
 */
export function aplicaIf(regla: string | undefined, tool: string, args: unknown, cwd: string): boolean {
  if (!regla) return true
  const r = leerRegla(regla)
  if (!r) return true
  if (!herramientaCoincide(r.herramienta, tool)) return false
  if (!r.patron || r.patron === "*") return true
  const s = sujetos(tool, args, cwd)
  if (!s || s.length === 0) return true
  return s.some((x) => Wildcard.match(x, r.patron!))
}
