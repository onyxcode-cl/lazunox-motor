/**
 * Lazunox (4A, P15): piezas puras de las skills completas. Sin dependencias del motor (solo `fs`/`path` y utilidades del paquete).
 *
 * Regla de oro: una skill (sobre todo la de un repositorio ajeno) es DATO + RESTRICCIONES. Nunca concede permisos, herramientas ni
 * sandbox. `allowed-tools` se lee como LISTA BLANCA que limita (a diferencia de Claude Code, que la preaprueba), y cada herramienta
 * listada conserva la acción que ya tenía (preguntar sigue preguntando). `disallowed-tools` deniega. Todo se expresa como reglas que
 * se añaden DESPUÉS de lo que ya rige y que re-imponen lo que la base preguntaba o negaba (misma maquinaria que 2A).
 */
import fs from "fs"
import path from "path"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Glob } from "@opencode-ai/core/util/glob"
import { permisoDeNombreClaude } from "@/config/agent-claude"
import { colaDeLaBase, negacionesEfectivas } from "@/agent/restringir-permisos"

type Regla = { permission: string; pattern: string; action: "allow" | "deny" | "ask" }

/** Presupuesto de la lista de skills del sistema (bytes UTF-8) y largo máximo de cada descripción (caracteres). */
export const LISTA_PRESUPUESTO_BYTES = 8 * 1024
export const DESCRIPCION_MAX = 300

export type SkillMeta = {
  allowedTools: string[]
  disallowedTools: string[]
  /** Valor tal cual del frontmatter (`haiku`, `proveedor/modelo`, `inherit`...). Se resuelve con `modeloDeSkill`. */
  model?: string
  fork: boolean
  paths: string[]
  disableModelInvocation: boolean
  /** Avisos de lectura (valores ignorados); el motor los registra. */
  avisos: string[]
}

export const META_VACIA: SkillMeta = {
  allowedTools: [],
  disallowedTools: [],
  fork: false,
  paths: [],
  disableModelInvocation: false,
  avisos: [],
}

/** Parte `a, b c, Bash(git *)` en entradas sin romper los paréntesis. Acepta también una lista. */
export function listaDeHerramientas(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean)
  if (typeof value !== "string") return []
  const out: string[] = []
  let actual = ""
  let hondo = 0
  for (const ch of value) {
    if (ch === "(") hondo++
    if (ch === ")" && hondo > 0) hondo--
    if (hondo === 0 && (ch === "," || /\s/.test(ch))) {
      if (actual.trim()) out.push(actual.trim())
      actual = ""
      continue
    }
    actual += ch
  }
  if (actual.trim()) out.push(actual.trim())
  return out
}

const clave = (data: Record<string, unknown>, ...nombres: string[]) => {
  for (const n of nombres) if (n in data) return data[n]
  return undefined
}

const bool = (v: unknown) => v === true || (typeof v === "string" && v.trim().toLowerCase() === "true")

/** Un patrón de `paths` válido es relativo, sin `..` ni letra de unidad ni `~`: debe quedarse dentro del proyecto. */
export function rutaPermitida(patron: string): boolean {
  const p = patron.trim().replaceAll("\\", "/")
  if (!p || p.length > 300) return false
  if (p.startsWith("/") || p.startsWith("~") || /^[A-Za-z]:/.test(p)) return false
  if (p.split("/").some((seg) => seg === "..")) return false
  return true
}

/** Lee el frontmatter de una skill. Nunca lanza: un valor raro se ignora y se anota en `avisos`. */
export function leerMeta(data: unknown): SkillMeta {
  if (typeof data !== "object" || data === null) return { ...META_VACIA, avisos: [] }
  const d = data as Record<string, unknown>
  const avisos: string[] = []
  const allowedTools = listaDeHerramientas(clave(d, "allowed-tools", "allowed_tools", "allowedTools"))
  const disallowedTools = listaDeHerramientas(clave(d, "disallowed-tools", "disallowed_tools", "disallowedTools"))
  const modelRaw = clave(d, "model")
  const model = typeof modelRaw === "string" && modelRaw.trim() ? modelRaw.trim().slice(0, 200) : undefined
  const ctx = clave(d, "context")
  if (ctx !== undefined && ctx !== "fork") avisos.push(`context "${String(ctx)}" desconocido: se ignora (solo existe "fork")`)
  const rawPaths = clave(d, "paths")
  const rutas = (Array.isArray(rawPaths)
    ? rawPaths.filter((x): x is string => typeof x === "string")
    : typeof rawPaths === "string"
      ? rawPaths.split(",")
      : []
  )
    .map((x) => x.trim())
    .filter(Boolean)
  const paths: string[] = []
  for (const r of rutas) {
    if (rutaPermitida(r)) paths.push(r.replaceAll("\\", "/"))
    else avisos.push(`paths: «${r.slice(0, 80)}» sale del proyecto o no es relativo: se ignora`)
  }
  // Si todos los patrones eran inválidos, la skill NO se activa nunca (no se interpreta como «sin paths»).
  const hayPathsDeclarados = rutas.length > 0
  return {
    allowedTools,
    disallowedTools,
    model,
    fork: ctx === "fork",
    paths: hayPathsDeclarados && paths.length === 0 ? ["\u0000nunca"] : paths,
    disableModelInvocation: bool(clave(d, "disable-model-invocation", "disable_model_invocation", "disableModelInvocation")),
    avisos,
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Restricciones de herramientas
// ---------------------------------------------------------------------------------------------------------------------

/** `Bash(git status:*)` -> {bash, "git status *"}; `Read` -> {read, "*"}; `mcp__srv__tool` -> {srv_tool, "*"}. */
export function reglaDeHerramienta(entrada: string): { permission: string; pattern: string } | undefined {
  const m = /^([^()]+?)\s*(?:\((.*)\))?$/.exec(entrada.trim())
  if (!m) return undefined
  const permission = permisoDeNombreClaude(m[1])
  if (!permission || !/^[\w*.-]+$/.test(permission)) return undefined
  let pattern = (m[2] ?? "*").trim() || "*"
  pattern = pattern.replace(/:\*$/, " *")
  return { permission, pattern }
}

/** Lo que rige hoy para (permiso, patrón): la última regla que coincide; sin regla, el motor pregunta. */
export function accionEfectiva(base: readonly Regla[], permission: string, pattern: string): Regla["action"] {
  return base.findLast((r) => Wildcard.match(permission, r.permission) && Wildcard.match(pattern, r.pattern))?.action ?? "ask"
}

/**
 * Reglas que una skill añade a la sesión mientras está activa, sin poder superar a `base` (los permisos efectivos de quien la corre).
 *
 *  - `allowed-tools` no vacío: `"*": deny` + cada herramienta listada con la acción que YA tenía en `base` (nunca «allow» nuevo).
 *  - `disallowed-tools`: `deny` al final (gana siempre).
 *  - La cola de la base (preguntar/denegar, y los allow que las pisan) se repone después: nada de lo declarado puede reabrirla.
 *
 * Devuelve `[]` si la skill no declara nada.
 */
export function reglasDeSkill(base: readonly Regla[], spec: { allowed: readonly string[]; disallowed: readonly string[] }): Regla[] {
  const declarado: Regla[] = []
  if (spec.allowed.length > 0) {
    declarado.push({ permission: "*", pattern: "*", action: "deny" })
    for (const entrada of spec.allowed) {
      const r = reglaDeHerramienta(entrada)
      if (!r) continue
      const accion = accionEfectiva(base, r.permission, r.pattern)
      if (accion !== "deny") declarado.push({ ...r, action: accion })
    }
  }
  for (const entrada of spec.disallowed) {
    const r = reglaDeHerramienta(entrada)
    if (r) declarado.push({ ...r, action: "deny" })
  }
  if (declarado.length === 0) return []
  return [...declarado, ...(colaDeLaBase(base, declarado) as Regla[]), ...(negacionesEfectivas(declarado) as Regla[])]
}

// Marcas del bloque de una skill dentro de los permisos de la sesión: `inicio:<nombre>` ... `fin`. Se quitan al terminar el turno.
export const MARCA_INICIO = "lazunox_skill_inicio"
export const MARCA_FIN = "lazunox_skill_fin"

export function envolverBloque(nombre: string, reglas: readonly Regla[]): Regla[] {
  return [
    { permission: MARCA_INICIO, pattern: nombre, action: "allow" },
    ...reglas,
    { permission: MARCA_FIN, pattern: nombre, action: "allow" },
  ]
}

/** Quita todos los bloques de skill (o solo el de `nombre`). Un bloque sin cierre se descarta hasta el final. */
export function quitarBloques<T extends { permission: string; pattern: string }>(reglas: readonly T[], nombre?: string): T[] {
  const out: T[] = []
  let dentro = false
  for (const r of reglas) {
    if (!dentro && r.permission === MARCA_INICIO && (nombre === undefined || r.pattern === nombre)) {
      dentro = true
      continue
    }
    if (dentro) {
      if (r.permission === MARCA_FIN) dentro = false
      continue
    }
    out.push(r)
  }
  return out
}

export const hayBloques = (reglas: readonly { permission: string }[]) => reglas.some((r) => r.permission === MARCA_INICIO)

// ---------------------------------------------------------------------------------------------------------------------
// Modelo
// ---------------------------------------------------------------------------------------------------------------------
export type ResolucionModelo =
  | { tipo: "heredar"; motivo?: string }
  | { tipo: "pequeno" }
  | { tipo: "modelo"; providerID: string; modelID: string }
  | { tipo: "ignorado"; motivo: string }

/**
 * `model` de una skill. SOLO del mismo proveedor que la sesión: otro proveedor (otras credenciales, otro servicio y otro coste)
 * se ignora con un motivo para registrarlo. `existe(prov, id)` dice si el modelo está disponible.
 */
export function modeloDeSkill(
  valor: string | undefined,
  sesion: { providerID: string },
  existe: (providerID: string, modelID: string) => boolean,
): ResolucionModelo {
  if (!valor) return { tipo: "heredar" }
  const v = valor.trim()
  const bajo = v.toLowerCase()
  if (bajo === "inherit" || bajo === "sonnet" || bajo === "opus") return { tipo: "heredar" }
  if (bajo === "haiku" || bajo === "small") return { tipo: "pequeno" }
  if (v.includes("/")) {
    const i = v.indexOf("/")
    const providerID = v.slice(0, i)
    const modelID = v.slice(i + 1)
    if (!providerID || !modelID) return { tipo: "ignorado", motivo: `model «${v}» mal formado` }
    if (providerID !== sesion.providerID)
      return { tipo: "ignorado", motivo: `model «${v}» es de otro proveedor que la sesión (${sesion.providerID}): se ignora` }
    return existe(providerID, modelID)
      ? { tipo: "modelo", providerID, modelID }
      : { tipo: "ignorado", motivo: `model «${v}» no existe en ${providerID}: se ignora` }
  }
  // ID suelto: solo vale dentro del proveedor de la sesión.
  return existe(sesion.providerID, v)
    ? { tipo: "modelo", providerID: sesion.providerID, modelID: v }
    : { tipo: "ignorado", motivo: `model «${v}» no existe en el proveedor de la sesión (${sesion.providerID}): se ignora` }
}

// ---------------------------------------------------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Ruta relativa al proyecto de un archivo tocado, SOLO si su realpath queda dentro del proyecto (un enlace simbólico que sale
 * no cuenta). `raiz` también se resuelve con realpath. Devuelve `undefined` si queda fuera o no existe.
 */
export function relativaDentroDelProyecto(archivo: string, raiz: string, cwd: string): string | undefined {
  try {
    const abs = path.isAbsolute(archivo) ? archivo : path.resolve(cwd, archivo)
    const real = fs.realpathSync(abs)
    const raizReal = fs.realpathSync(raiz)
    const rel = path.relative(raizReal, real)
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined
    return rel.split(path.sep).join("/")
  } catch {
    return undefined
  }
}

/** ¿Alguno de los patrones (estilo gitignore) cubre esta ruta relativa? Un patrón sin `/` también cubre por nombre de archivo. */
export function coincideRuta(rel: string, patrones: readonly string[]): boolean {
  const base = rel.slice(rel.lastIndexOf("/") + 1)
  return patrones.some((p) => {
    if (p === "\u0000nunca") return false
    const sinBarra = p.replace(/\/+$/, "")
    if (Glob.match(p, rel) || Glob.match(`${sinBarra}/**`, rel)) return true
    return !p.includes("/") && Glob.match(p, base)
  })
}

/** Archivos que toca una llamada de herramienta ya completada (solo las que leen/escriben archivos). */
export function archivosDeHerramienta(tool: string, input: unknown): string[] {
  if (typeof input !== "object" || input === null) return []
  const i = input as Record<string, unknown>
  if (tool === "read" || tool === "edit" || tool === "write") {
    const f = i.filePath ?? i.file_path ?? i.path
    return typeof f === "string" ? [f] : []
  }
  if (tool === "apply_patch" && typeof i.patchText === "string") {
    return [...i.patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim())
  }
  return []
}

// ---------------------------------------------------------------------------------------------------------------------
// Lista del sistema con presupuesto
// ---------------------------------------------------------------------------------------------------------------------
const bytes = (s: string) => Buffer.byteLength(s, "utf-8")

/** Una línea, sin `<`/`>` (no puede cerrar la etiqueta de la lista) y de como mucho `max` caracteres. */
export function descripcionAcotada(texto: string, max = DESCRIPCION_MAX): string {
  const limpia = texto.replace(/\s+/g, " ").trim().replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  const chars = Array.from(limpia)
  return chars.length <= max ? limpia : chars.slice(0, max - 1).join("") + "…"
}

/**
 * Reparte `presupuesto` bytes entre las entradas (ya ordenadas): entra todo lo que quepa y el resto se cuenta en una nota. El texto
 * final, con cabecera, pie y nota, nunca pasa de `presupuesto`.
 */
export function ajustarAlPresupuesto(
  cabecera: string[],
  entradas: string[][],
  pie: string[],
  presupuesto: number,
  nota: (omitidas: number) => string,
): string {
  const total = (lineas: string[]) => bytes(lineas.join("\n"))
  const elegidas: string[][] = []
  for (let i = 0; i < entradas.length; i++) {
    const quedan = entradas.length - (i + 1)
    // Con la entrada i dentro y lo demás omitido, ¿cabe?
    const prueba = [...cabecera, ...elegidas.flat(), ...entradas[i], ...(quedan > 0 ? [nota(quedan)] : []), ...pie]
    if (total(prueba) > presupuesto) break
    elegidas.push(entradas[i])
  }
  const omitidas = entradas.length - elegidas.length
  const lineas = [...cabecera, ...elegidas.flat(), ...(omitidas > 0 ? [nota(omitidas)] : []), ...pie]
  return lineas.join("\n")
}
