// Lazunox (lazunox.16, paquete B1): política ÚNICA de permisos por CAPAS, detrás de la bandera LAZUNOX_PERMISOS_CAPAS=1 (apagada por defecto).
//
// Con la bandera APAGADA nada de este archivo cambia ninguna decisión: `efectivo()` devuelve el mismo arreglo de siempre
// (`merge(agente, sesión, cola)`) y `decidir()` es `evaluate()` (gana la última regla que casa).
//
// Con la bandera ENCENDIDA, el orden es fijo (de más fuerte a más débil):
//   1. POLÍTICA de empresa (LAZUNOX_POLICY_FILE): una herramienta negada o una política rota (falla cerrado) niega.
//   2. `deny` de la CONFIG, fuente por fuente (global, archivo de la app, inline de la app, carpeta, carpetas superiores, `.opencode`, administrada),
//      con la capa del agente activo (`agent.<nombre>.permission`) incluida. «Piso»: un `deny` que una fuente deja en pie NO lo abre nada de rango
//      menor NI otra fuente (regla D2). Dentro de UNA misma fuente manda la posición por clave (el motor de siempre): «negar todo menos X» sigue
//      permitiendo X cuando la propia fuente lo permite después.
//   3. AGENTE + MODO (bloque de sesión): el arreglo de siempre (`merge(agente, sesión, cola)`, gana la última). El bloque del modo decide
//      `ask`/`allow` donde no hay `deny` por encima.
//   4. PADRE (solo hijas): lo vigente del padre cuando nació el ayudante (su bloque de sesión) solo puede APRETAR: la hija nunca puede más.
//   5. «SIEMPRE» guardados: abren `ask`, nunca un `deny` (lo aplica `Permission.ask`).
//
// Marcas dentro de `session.permission` (no casan con ninguna herramienta real; mismo recurso que las marcas de skill):
//   `lazunox_modo_inicio`   abre el bloque del modo (lo reemplaza `PATCH /session/{id}` con `permissionMode:"replace"`).
//   `lazunox_padre_inicio`  abre la foto de lo vigente del padre dentro de la sesión de una hija (`pattern` = agente del padre).
//   `lazunox_skill_inicio/fin` bloque temporal de una skill (ver skill/frontmatter.ts).
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parse as parseJsonc } from "jsonc-parser"
import { mergeDeep } from "remeda"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Politica } from "./politica"

type Regla = PermissionV1.Rule
type Reglas = PermissionV1.Ruleset

export const activo = (env: Record<string, string | undefined> = process.env) => env.LAZUNOX_PERMISOS_CAPAS === "1"

export const MARCA_MODO = "lazunox_modo_inicio"
export const MARCA_PADRE = "lazunox_padre_inicio"
const MARCA_SKILL_INICIO = "lazunox_skill_inicio"
const MARCA_SKILL_FIN = "lazunox_skill_fin"
const esMarca = (r: { permission: string }) =>
  r.permission === MARCA_MODO || r.permission === MARCA_PADRE || r.permission === MARCA_SKILL_INICIO || r.permission === MARCA_SKILL_FIN

// ---------------------------------------------------------------------------------------------------------------------
// Bloques dentro de session.permission
// ---------------------------------------------------------------------------------------------------------------------
type Region = "libre" | "modo" | "padre" | "skill"

/** Recorre las reglas y dice a qué región pertenece cada una (las marcas de apertura/cierre se atribuyen a su región). */
function regiones(reglas: Reglas): Array<{ regla: Regla; region: Region }> {
  const out: Array<{ regla: Regla; region: Region }> = []
  let region: Region = "libre"
  for (const regla of reglas) {
    if (regla.permission === MARCA_MODO) region = "modo"
    else if (regla.permission === MARCA_PADRE) region = "padre"
    else if (regla.permission === MARCA_SKILL_INICIO) region = "skill"
    out.push({ regla, region })
    if (regla.permission === MARCA_SKILL_FIN) region = "libre"
  }
  return out
}

/** Reglas de la sesión SIN la foto del padre (esa no es de la hija: solo aprieta, nunca abre) y sin las marcas propias del modo/padre. */
export function sinPadre(reglas: Reglas): Reglas {
  if (!reglas.some((r) => r.permission === MARCA_PADRE)) return reglas
  return regiones(reglas)
    .filter((x) => x.region !== "padre")
    .map((x) => x.regla)
}

/** `PATCH /session/{id}` con `permissionMode:"replace"`: sustituye el bloque del modo y deja lo demás (bloques de skill, foto del padre). */
export function reemplazarBloqueModo(actual: Reglas, nuevo: Reglas): Reglas {
  const partes = regiones(actual)
  const hayMarca = partes.some((x) => x.region === "modo")
  // Sin marca (sesión creada con el contrato de la app 1.8.12): lo que no está en un bloque conocido era el bloque del modo acumulado.
  const resto = partes.filter((x) => (hayMarca ? x.region !== "modo" : x.region !== "libre")).map((x) => x.regla)
  const limpias = nuevo.filter((r) => !esMarca(r))
  const antes: Regla[] = []
  const despues: Regla[] = []
  let visto = false
  for (const r of resto) {
    // lo que iba tras el bloque del modo (bloques de skill/padre) sigue tras el bloque nuevo
    if (!visto && (r.permission === MARCA_SKILL_INICIO || r.permission === MARCA_PADRE)) visto = true
    ;(visto ? despues : antes).push(r)
  }
  return [...antes, { permission: MARCA_MODO, pattern: "modo", action: "allow" }, ...limpias, ...despues]
}

/** ¿La sesión usa el contrato nuevo (su bloque del modo está marcado)? Sin marca = app 1.8.12: el motor conserva la conducta de lazunox.15 (D5). */
export const tieneMarcaDeModo = (reglas: Reglas) => reglas.some((r) => r.permission === MARCA_MODO)

/**
 * Bloque con lo vigente del padre, para la sesión de una hija (se anexa al final). Siempre lleva el agente del padre (el piso de la config incluye
 * el bloque de ESE agente); lleva la foto de las reglas de sesión solo si el padre usa el contrato nuevo.
 */
export function bloquePadre(sesionPadre: Reglas, agentePadre: string): Reglas {
  if (!tieneMarcaDeModo(sesionPadre)) return [{ permission: MARCA_PADRE, pattern: agentePadre || "build", action: "allow" }]
  const vigente = regiones(sesionPadre)
    .filter((x) => x.region === "libre" || x.region === "modo" || x.region === "padre")
    .map((x) => x.regla)
    .filter((r) => !esMarca(r))
  return [{ permission: MARCA_PADRE, pattern: agentePadre || "build", action: "allow" }, ...vigente]
}

export function leerPadre(reglas: Reglas): { agente: string; reglas: Reglas } | undefined {
  const partes = regiones(reglas).filter((x) => x.region === "padre")
  if (partes.length === 0) return undefined
  const [cabeza, ...resto] = partes
  return { agente: cabeza!.regla.pattern, reglas: resto.map((x) => x.regla).filter((r) => !esMarca(r)) }
}

// ---------------------------------------------------------------------------------------------------------------------
// Fuentes de configuración (por fuente, antes de que la config las mezcle)
// ---------------------------------------------------------------------------------------------------------------------
export interface Fuente {
  origen: string
  permission: Reglas
  agentes: Record<string, Reglas>
  /** `permission` y `agent` tal como los escribió la fuente (para rehacer la mezcla del motor). */
  crudo?: Record<string, unknown>
}

const ACCIONES = new Set(["allow", "ask", "deny"])
function expandir(p: string) {
  if (p.startsWith("~/")) return os.homedir() + p.slice(1)
  if (p === "~") return os.homedir()
  if (p.startsWith("$HOME")) return os.homedir() + p.slice(5)
  return p
}
/** Mismo orden y misma normalización que `fromConfig` (texto suelto = clave `*`). Dato no confiable: lo que no se entiende se ignora. */
export function reglasDeBloque(valor: unknown): Reglas {
  const out: Regla[] = []
  if (typeof valor === "string") {
    if (ACCIONES.has(valor)) out.push({ permission: "*", pattern: "*", action: valor as Regla["action"] })
    return out
  }
  if (!valor || typeof valor !== "object" || Array.isArray(valor)) return out
  for (const [clave, v] of Object.entries(valor as Record<string, unknown>)) {
    if (typeof v === "string") {
      if (ACCIONES.has(v)) out.push({ permission: clave, pattern: "*", action: v as Regla["action"] })
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [patron, a] of Object.entries(v as Record<string, unknown>))
        if (typeof a === "string" && ACCIONES.has(a)) out.push({ permission: clave, pattern: expandir(patron), action: a as Regla["action"] })
    }
  }
  return out
}

function fuenteDe(origen: string, json: unknown): Fuente | undefined {
  if (!json || typeof json !== "object" || Array.isArray(json)) return undefined
  const o = json as Record<string, unknown>
  const agentes: Record<string, Reglas> = {}
  for (const clave of ["agent", "mode"] as const) {
    const bloque = o[clave]
    if (!bloque || typeof bloque !== "object" || Array.isArray(bloque)) continue
    for (const [nombre, def] of Object.entries(bloque as Record<string, unknown>)) {
      if (!def || typeof def !== "object" || Array.isArray(def)) continue
      const r = reglasDeBloque((def as Record<string, unknown>).permission)
      if (r.length) agentes[nombre] = [...(agentes[nombre] ?? []), ...r]
    }
  }
  const permission = reglasDeBloque(o.permission)
  if (permission.length === 0 && Object.keys(agentes).length === 0) return undefined
  return { origen, permission, agentes, crudo: { permission: o.permission, agent: o.agent, mode: o.mode } }
}

function archivoJson(file: string): { firma: string; texto: string } | undefined {
  try {
    const st = fs.statSync(file)
    if (!st.isFile() || st.size > 2 * 1024 * 1024) return undefined
    return { firma: `${file}:${st.mtimeMs}:${st.size}`, texto: fs.readFileSync(file, "utf-8") }
  } catch {
    return undefined
  }
}

/** Carpetas desde `directory` hacia arriba hasta la raíz del repositorio (con `.git`) o, sin repositorio, hasta la raíz del disco. */
function cadenaDeCarpetas(directory: string): string[] {
  const out: string[] = []
  for (let d = directory; ; d = path.dirname(d)) {
    out.push(d)
    if (fs.existsSync(path.join(d, ".git"))) break
    if (path.dirname(d) === d) break
  }
  return out
}

const cacheFuentes = new Map<string, { firma: string; fuentes: Fuente[] }>()

/** Todas las fuentes de config con reglas de permiso, cada una por separado. Nunca lanza; una fuente ilegible se ignora. */
export function fuentes(directory: string): Fuente[] {
  const archivos: string[] = []
  const g = Global.Path.config
  for (const n of ["config.json", "opencode.json", "opencode.jsonc"]) archivos.push(path.join(g, n))
  if (Flag.OPENCODE_CONFIG) archivos.push(Flag.OPENCODE_CONFIG)
  if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
    const cadena = cadenaDeCarpetas(directory)
    for (const d of cadena.toReversed()) {
      archivos.push(path.join(d, "opencode.jsonc"), path.join(d, "opencode.json"))
      archivos.push(path.join(d, ".opencode", "opencode.jsonc"), path.join(d, ".opencode", "opencode.json"))
    }
  }
  const home = os.homedir()
  archivos.push(path.join(home, ".opencode", "opencode.jsonc"), path.join(home, ".opencode", "opencode.json"))
  if (Flag.OPENCODE_CONFIG_DIR) archivos.push(path.join(Flag.OPENCODE_CONFIG_DIR, "opencode.jsonc"), path.join(Flag.OPENCODE_CONFIG_DIR, "opencode.json"))
  const lecturas = [...new Set(archivos)].map((f) => ({ f, a: archivoJson(f) })).filter((x) => x.a !== undefined) as Array<{
    f: string
    a: { firma: string; texto: string }
  }>
  const inline = process.env["OPENCODE_CONFIG_CONTENT"] ?? ""
  const permisoEnv = process.env["OPENCODE_PERMISSION"] ?? ""
  const firma = [...lecturas.map((x) => x.a.firma), `inline:${inline.length}:${inline.slice(0, 64)}:${inline.slice(-64)}`, `env:${permisoEnv}`].join("|")
  const previa = cacheFuentes.get(directory)
  if (previa && previa.firma === firma) return previa.fuentes

  const out: Fuente[] = []
  const meter = (origen: string, texto: string) => {
    try {
      const f = fuenteDe(origen, parseJsonc(texto, [], { allowTrailingComma: true }))
      if (f) out.push(f)
    } catch {
      /* ilegible: la config real también lo rechaza */
    }
  }
  for (const x of lecturas) meter(x.f, x.a.texto)
  if (inline) meter("inline", inline)
  if (permisoEnv) {
    try {
      const r = reglasDeBloque(JSON.parse(permisoEnv))
      if (r.length) out.push({ origen: "OPENCODE_PERMISSION", permission: r, agentes: {} })
    } catch {
      /* JSON inválido: la config lo salta con aviso */
    }
  }
  if (cacheFuentes.size > 64) cacheFuentes.clear()
  cacheFuentes.set(directory, { firma, fuentes: out })
  return out
}

/**
 * Capas del piso: una por fuente y por nombre de agente (el activo y, en una hija, el del padre; permisos generales + bloque del agente, en ese orden)
 * y UNA más con la config ya mezclada como la mezcla el motor (`mergeDeep`: cada clave conserva su primer lugar y toma el último valor). Esa última
 * conserva el `deny` explícito de una clave aunque otra fuente la haya escrito antes con otro valor (caso N1 de RI2); las capas por fuente conservan
 * el `deny` que otra fuente tapó con un comodín (D2).
 */
export function pisoDe(directory: string, agentes: string[]): Reglas[] {
  const capas: Reglas[] = []
  const lista = fuentes(directory)
  for (const f of lista) {
    for (const nombre of [...new Set(agentes)]) {
      const capa = [...f.permission, ...(f.agentes[nombre] ?? [])]
      if (capa.length) capas.push(capa)
    }
    if (agentes.length === 0 && f.permission.length) capas.push(f.permission)
  }
  if (lista.length > 1) {
    let mezcla: Record<string, unknown> = {}
    for (const f of lista) {
      const c = f.crudo ?? {}
      const permission = typeof c.permission === "string" ? { "*": c.permission } : c.permission
      mezcla = mergeDeep(mezcla, { permission: permission ?? {}, agent: c.agent ?? {}, mode: c.mode ?? {} }) as Record<string, unknown>
    }
    const m = mezcla as { permission?: unknown; agent?: Record<string, { permission?: unknown }> }
    for (const nombre of [...new Set(agentes.length ? agentes : [""])]) {
      const capa = [...reglasDeBloque(m.permission), ...reglasDeBloque(m.agent?.[nombre]?.permission)]
      if (capa.length) capas.push(capa)
    }
  }
  return capas
}

// ---------------------------------------------------------------------------------------------------------------------
// Evaluación
// ---------------------------------------------------------------------------------------------------------------------
export interface Efectivo {
  /** Lo de siempre: `merge(agente, sesión, cola)`. */
  ruleset: Reglas
  /** Capas de config (una por fuente) cuyos `deny` nadie de rango menor levanta. Vacío con la bandera apagada. */
  piso: Reglas[]
  /** Foto de lo vigente del padre (solo hijas): solo aprieta. */
  padre?: Reglas
}

export function efectivo(input: {
  agent: { name: string; permission: Reglas }
  session?: { permission?: Reglas | null; directory?: string }
  directory?: string
  cola?: Reglas[]
}): Efectivo {
  const sesion = input.session?.permission ?? []
  if (!activo()) return { ruleset: [...input.agent.permission, ...sesion, ...(input.cola ?? []).flat()], piso: [] }
  const padre = leerPadre(sesion)
  const dir = input.directory ?? input.session?.directory
  const piso = dir ? pisoDe(dir, [input.agent.name, ...(padre ? [padre.agente] : [])]) : []
  return {
    ruleset: [...input.agent.permission, ...sinPadre(sesion), ...(input.cola ?? []).flat()],
    piso,
    ...(padre ? { padre: padre.reglas } : {}),
  }
}

const minus = (s: string) => s.toLowerCase()
const claveCasa = (permiso: string, reglaPermiso: string) => Wildcard.match(minus(permiso), minus(reglaPermiso))
/** Prefijo literal de una clave (hasta el primer comodín): `bgshell_*` → `bgshell_`, `*start*` → ``. */
const prefijo = (clave: string) => minus(clave).split(/[*?]/)[0] ?? ""
const PROPIAS = ["bgshell_", "documentos_"]
/** D4: las herramientas propias de la app solo las niega una regla que las NOMBRA (`bgshell_*`, `documentos_crear`), no un comodín amplio. */
const propiaDe = (permiso: string) => PROPIAS.find((p) => minus(permiso).startsWith(p))
/** D4: `bgshell_start` sigue a `bash` y `documentos_crear` a `write`/`edit`, pero solo por reglas que nombran a ese permiso. */
const SIGUE: Record<string, string[]> = { bgshell_start: ["bash"], documentos_crear: ["write", "edit"] }

function casaRegla(r: Regla, permiso: string, patron: string, soloNombradas: boolean) {
  const propia = soloNombradas ? undefined : propiaDe(permiso)
  return (
    claveCasa(permiso, r.permission) &&
    (soloNombradas ? prefijo(r.permission) === minus(permiso) : propia ? prefijo(r.permission).startsWith(propia) : true) &&
    Wildcard.match(patron, r.pattern)
  )
}

function ultimaDe(capa: Reglas, permiso: string, patron: string, soloNombradas: boolean): Regla | undefined {
  const r = capa.findLast((x) => casaRegla(x, permiso, patron, soloNombradas))
  // B1-07/08/09: un `deny` con patron especifico escrito ANTES de un `*` mas general de la MISMA clave sigue negando
  // (`{"rm *":"deny","*":"ask"}`). `{"*":"deny","git status":"allow"}` no cambia: ahi el `deny` es el comodin.
  if (r && r.action !== "deny" && r.pattern === "*") {
    const i = capa.lastIndexOf(r)
    for (let j = i - 1; j >= 0; j--) {
      const d = capa[j]
      if (d.action === "deny" && d.pattern !== "*" && d.permission === r.permission && casaRegla(d, permiso, patron, soloNombradas)) return d
    }
  }
  return r
}

/** ¿Alguna capa del piso niega (permiso, patrón)? Devuelve la regla que niega. */
export function pisoNiega(piso: Reglas[], permiso: string, patron: string): Regla | undefined {
  for (const capa of piso) {
    const r = ultimaDe(capa, permiso, patron, false)
    if (r?.action === "deny") return r
    for (const seguido of SIGUE[minus(permiso)] ?? []) {
      const s = ultimaDe(capa, seguido, patron, true)
      if (s?.action === "deny") return s
    }
  }
  return undefined
}

const ORDEN = { allow: 0, ask: 1, deny: 2 } as const

/** Decisión de capas para (permiso, patrón). Con la bandera apagada y sin piso es EXACTAMENTE `evaluate()`. */
export function decidir(e: Efectivo, permiso: string, patron: string): Regla {
  if (activo()) {
    if (Politica.herramientaDenegada(permiso)) return { permission: permiso, pattern: "*", action: "deny" }
    const duro = pisoNiega(e.piso, permiso, patron)
    if (duro) return duro
  }
  let propia: Regla = e.ruleset.findLast((r) => Wildcard.match(permiso, r.permission) && Wildcard.match(patron, r.pattern)) ?? {
    action: "ask",
    permission: permiso,
    pattern: "*",
  }
  if (e.padre) {
    const p = e.padre.findLast((r) => Wildcard.match(permiso, r.permission) && Wildcard.match(patron, r.pattern))
    if (p && ORDEN[p.action] > ORDEN[propia.action]) propia = { ...p, permission: permiso }
  }
  return propia
}

const EDITS = ["edit", "write", "apply_patch"]
const LECTURAS = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]
const DIFERIDAS = ["tool_search", "mcp_call"]

/** ¿El piso oculta esta herramienta? (mismo criterio que `disabled`: la última regla de la capa para ese permiso es `*: deny`). */
export function pisoOculta(piso: Reglas[], herramienta: string): boolean {
  if (piso.length === 0) return false
  if (DIFERIDAS.includes(herramienta)) {
    return piso.some((capa) => {
      const exacta = capa.findLast((r) => r.permission === herramienta)
      return exacta?.pattern === "*" && exacta.action === "deny"
    })
  }
  const permiso = EDITS.includes(herramienta) ? "edit" : LECTURAS.includes(herramienta) ? "read" : herramienta
  const propia = propiaDe(permiso)
  const ultima = (capa: Reglas, p: string, nombradas: boolean) =>
    capa.findLast((r) => claveCasa(p, r.permission) && (nombradas ? prefijo(r.permission) === minus(p) : propia ? prefijo(r.permission).startsWith(propia) : true))
  return piso.some((capa) => {
    const r = ultima(capa, permiso, false)
    if (r?.pattern === "*" && r.action === "deny") return true
    return (SIGUE[minus(permiso)] ?? []).some((s) => {
      const x = ultima(capa, s, true)
      return x?.pattern === "*" && x.action === "deny"
    })
  })
}

export * as PermisoCapas from "./capas"
