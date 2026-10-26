import fs from "node:fs"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { Exit, Schema } from "effect"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { validarEsquema } from "@/cli/cmd/run-banderas"
import { ToolJsonSchema } from "@/tool/json-schema"
import { PartID } from "@/session/schema"
import { ToolID } from "@/tool/schema"
import { GanchoRechazoError } from "./lazunox-rechazo"
import { TRUNCATION_DIR } from "@/tool/truncation-dir"

// Lazunox: ganchos de usuario por comando (como los hooks de Claude Code), solo del archivo que la APP fija en LAZUNOX_HOOKS_FILE.
// Un proyecto NO puede traer sus propios ganchos (sería ejecución de código de un repositorio ajeno): el archivo vive en la carpeta de datos de
// la app, lo escribe la persona. Formato:
//   { "hooks": { "PreToolUse": [{ "matcher": "bash|edit", "command": "./revisar.sh", "timeout": 10 }], "PostToolUse": [ … ], "PreCompact": [ … ], "PostCompact": [ … ], "Stop": [ … ] } }
// El comando recibe por stdin un JSON { event, tool, args, sessionID, cwd[, output] }. PreToolUse: código de salida 2 = BLOQUEA la herramienta y el
// modelo recibe el stderr; cualquier otro código (o un fallo, o pasarse del tiempo) no bloquea. PostToolUse: código 2 añade el stderr al resultado.
// Ganchos ampliados (3D, P20), mismos formato y archivo:
//   SessionStart      la 1.ª vez que se arma el sistema de una sesión PRINCIPAL; su stdout (código 0) se suma al sistema, marcado.
//   UserPromptSubmit  cada mensaje de la persona (no los de ayudantes ni los sintéticos); código 2 (o {"decision":"block","reason"}) lo RECHAZA;
//                     su stdout (código 0) se añade al mensaje como contexto sintético.
//   SubagentStop      un ayudante quedó ocioso (informativo; si el bucle llama a `experimental.session.stop` con `subagente`, puede hacerlo seguir).
//   Stop              la sesión va a parar: stdout {"decision":"block","reason":"…"} (o código 2 + stderr) = SEGUIR trabajando con `reason` como
//                     instrucción. Tope: 5 continuaciones seguidas por gancho; al llegar, ese gancho se ignora y la sesión para.
//   PostToolUse       además (6.8): stdout {"updatedToolOutput":"<texto>"} con código 0 REEMPLAZA el texto de la salida (≤ 64 KB; solo texto, nunca
//                     metadata ni archivos). El ORIGINAL completo se guarda en la carpeta de salidas (`Truncate.DIR`) y su ruta va en el texto.
//   PostToolUseFailure  (6.8) la herramienta falló: solo informa y puede añadir contexto (≤ 2000) al error. No oculta ni borra el fallo.
//   PermissionDenied  (6.8) una regla o un plugin negó un permiso: solo informa (stdin con la herramienta y las reglas, sin argumentos). Sin reintento.
//   PreToolUse        además: stdout {"updatedInput":{…}} (o hookSpecificOutput.updatedInput) reemplaza los argumentos SI validan contra el
//                     esquema de la herramienta; si no validan (o no se conoce el esquema) se ignora y se registra.

export type Gancho = { matcher?: string; command: string; timeout?: number }
export type Config = {
  PreToolUse: Gancho[]
  PostToolUse: Gancho[]
  PreCompact: Gancho[]
  PostCompact: Gancho[]
  Stop: Gancho[]
  SessionStart: Gancho[]
  UserPromptSubmit: Gancho[]
  SubagentStop: Gancho[]
  PostToolUseFailure: Gancho[]
  PermissionDenied: Gancho[]
}
const VACIO = (): Config => ({
  PreToolUse: [],
  PostToolUse: [],
  PreCompact: [],
  PostCompact: [],
  Stop: [],
  SessionStart: [],
  UserPromptSubmit: [],
  SubagentStop: [],
  PostToolUseFailure: [],
  PermissionDenied: [],
})

const MAX_ARCHIVO = 64 * 1024
const MAX_GANCHOS = 20
const MAX_SALIDA = 8 * 1024
const TIEMPO_DEFECTO = 10
const TIEMPO_MAX = 60
/** Continuaciones seguidas que un mismo gancho `Stop` puede forzar antes de que se le ignore (un `Stop` hostil no impide parar para siempre). */
export const TOPE_CONTINUACIONES = 5
/** Presupuesto total de tiempo de los ganchos de UN evento (suma de todos), para que 20 ganchos lentos no congelen la sesión. */
const PRESUPUESTO_EVENTO_MS = 120_000
const MAX_CONTEXTO = 4000
const MAX_RAZON = 2000
const MAX_ARGS_JSON = 256 * 1024
/** 6.8: texto máximo (en bytes) con que un gancho puede reemplazar una salida. */
export const MAX_SALIDA_REEMPLAZO = 64 * 1024
/** 6.8: salida de la herramienta que se le pasa al gancho por stdin (el original completo se guarda aparte). */
const MAX_ENTRADA_SALIDA = 256 * 1024
/** 6.8: tope de stdout de un gancho `PostToolUse` (el JSON escapa el texto, así que es mayor que el texto permitido). */
const MAX_SALIDA_POST = 512 * 1024
const MAX_CONTEXTO_FALLO = 2000

/** Interpreta el archivo de ganchos; lo inválido se descarta (nunca lanza). */
export const leerConfig = (text: string): Config => {
  const vacio = VACIO()
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    return vacio
  }
  const hooks = (j as { hooks?: Record<string, unknown> } | null)?.hooks
  if (!hooks || typeof hooks !== "object") return vacio
  const lista = (v: unknown): Gancho[] =>
    (Array.isArray(v) ? v : [])
      .filter((g): g is Gancho => !!g && typeof g === "object" && typeof (g as Gancho).command === "string" && (g as Gancho).command.trim().length > 0 && (g as Gancho).command.length <= 2000)
      .map((g) => ({
        command: g.command,
        matcher: typeof g.matcher === "string" && g.matcher.length <= 300 ? g.matcher : undefined,
        timeout: typeof g.timeout === "number" && Number.isFinite(g.timeout) ? Math.min(TIEMPO_MAX, Math.max(1, Math.floor(g.timeout))) : undefined,
      }))
      .slice(0, MAX_GANCHOS)
  return {
    PreToolUse: lista(hooks.PreToolUse),
    PostToolUse: lista(hooks.PostToolUse),
    PreCompact: lista(hooks.PreCompact),
    PostCompact: lista(hooks.PostCompact),
    Stop: lista(hooks.Stop),
    SessionStart: lista(hooks.SessionStart),
    UserPromptSubmit: lista(hooks.UserPromptSubmit),
    SubagentStop: lista(hooks.SubagentStop),
    PostToolUseFailure: lista(hooks.PostToolUseFailure),
    PermissionDenied: lista(hooks.PermissionDenied),
  }
}

export type Salida = { decision?: "block"; reason?: string; updatedInput?: unknown; context?: string; updatedToolOutput?: unknown }

/** Interpreta el stdout de un gancho como JSON de decisión. Texto que no es un objeto JSON, o JSON roto, = sin decisión (nunca lanza). */
export const leerSalida = (stdout: string): Salida => {
  const t = stdout.trim()
  if (!t.startsWith("{")) return {}
  let j: unknown
  try {
    j = JSON.parse(t)
  } catch {
    return {}
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return {}
  const o = j as Record<string, unknown>
  const h = o.hookSpecificOutput && typeof o.hookSpecificOutput === "object" ? (o.hookSpecificOutput as Record<string, unknown>) : {}
  const out: Salida = {}
  if (o.decision === "block") out.decision = "block"
  if (typeof o.reason === "string") out.reason = o.reason.slice(0, MAX_RAZON)
  const ui = "updatedInput" in o ? o.updatedInput : h.updatedInput
  if (ui !== undefined) out.updatedInput = ui
  const uo = "updatedToolOutput" in o ? o.updatedToolOutput : h.updatedToolOutput
  if (uo !== undefined) out.updatedToolOutput = uo
  const ctx = typeof o.additionalContext === "string" ? o.additionalContext : typeof h.additionalContext === "string" ? h.additionalContext : undefined
  if (ctx) out.context = ctx.slice(0, MAX_CONTEXTO)
  return out
}

/** ¿Este resultado pide seguir/bloquear? Código 2 (con stderr) o JSON `{"decision":"block"}` con código 0. Devuelve la razón. */
export const pideBloquear = (r: Resultado): string | undefined => {
  if (r.timedOut) return undefined
  if (r.code === 2) return (r.stderr || r.stdout).trim().slice(0, MAX_RAZON) || "(sin motivo)"
  if (r.code === 0) {
    const s = leerSalida(r.stdout)
    if (s.decision === "block") return (s.reason ?? "").trim() || "(sin motivo)"
  }
  return undefined
}

/** Texto de contexto de un gancho que no bloquea: código 0 y stdout (JSON con additionalContext, o texto plano), acotado. */
export const textoContexto = (r: Resultado): string => {
  if (r.code !== 0 || r.timedOut) return ""
  const s = leerSalida(r.stdout)
  if (s.decision === "block") return ""
  if (r.stdout.trim().startsWith("{") && (s.context !== undefined || Object.keys(s).length > 0)) return (s.context ?? "").trim()
  return r.stdout.trim().slice(0, MAX_CONTEXTO)
}

/** El texto de un gancho es DATO no confiable: sin escapes ANSI ni control, y sin poder cerrar o fingir las etiquetas de sobre del motor. */
export const neutralizarSalida = (t: string) =>
  t
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/<(\/?)(system[-_a-z]*|task[-_a-z]*|summary|shell_[a-z_]+|linea_[a-z_]+|contexto[-_a-z]*|objetivo[-_a-z]*|subagent[-_a-z]*|lazunox[-_a-z]*)\b/gi, "<\u200b$1$2")

/** Valida `updatedToolOutput`: texto no vacío de hasta 64 KB. Devuelve el texto neutralizado o el motivo de rechazo. */
export const validarSalidaNueva = (v: unknown): { texto: string } | { motivo: string } => {
  if (typeof v !== "string") return { motivo: "updatedToolOutput no es texto" }
  if (Buffer.byteLength(v, "utf-8") > MAX_SALIDA_REEMPLAZO) return { motivo: `updatedToolOutput pasa de ${MAX_SALIDA_REEMPLAZO / 1024} KB` }
  const texto = neutralizarSalida(v)
  if (!texto.trim()) return { motivo: "updatedToolOutput está vacío" }
  return { texto }
}

type Esquemas = { parameters?: unknown; jsonSchema?: unknown }

/** Valida `updatedInput` contra el esquema de la herramienta. Devuelve el motivo de rechazo, o undefined si vale. */
export const validarEntrada = (esq: Esquemas | undefined, valor: unknown): string | undefined => {
  if (!valor || typeof valor !== "object" || Array.isArray(valor)) return "updatedInput no es un objeto"
  let txt: string
  try {
    txt = JSON.stringify(valor)
  } catch {
    return "updatedInput no se puede serializar"
  }
  if (txt.length > MAX_ARGS_JSON) return "updatedInput es demasiado grande"
  if (!esq || (!esq.parameters && !esq.jsonSchema)) return "no se conoce el esquema de la herramienta"
  try {
    const js = ToolJsonSchema.fromTool({ parameters: esq.parameters, jsonSchema: esq.jsonSchema } as never)
    const errores = validarEsquema(js as Record<string, unknown>, JSON.parse(txt))
    if (errores.length) return errores.slice(0, 3).join("; ")
    if (esq.parameters && Schema.isSchema(esq.parameters)) {
      const exit = Schema.decodeUnknownExit(esq.parameters as Schema.Decoder<unknown>)(JSON.parse(txt), { onExcessProperty: "ignore" })
      if (Exit.isFailure(exit)) return "no cumple el esquema de la herramienta"
    }
  } catch (e) {
    return `no se pudo validar: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200)
  }
  return undefined
}

/** Cuenta de continuaciones seguidas por (sesión, gancho). Pura: la usa el plugin y las pruebas. */
export class Continuaciones {
  private n = new Map<string, number>()
  /** Devuelve true si el gancho puede forzar otra continuación (y la cuenta); false si ya agotó el tope (y reinicia). */
  intentar(sesion: string, id: string): boolean {
    const k = `${sesion}\0${id}`
    const v = this.n.get(k) ?? 0
    if (v >= TOPE_CONTINUACIONES) {
      this.n.delete(k)
      return false
    }
    if (this.n.size > 2000) this.n.delete(this.n.keys().next().value as string)
    this.n.set(k, v + 1)
    return true
  }
  /** El gancho dejó parar (o la persona escribió algo): se reinicia. */
  liberar(sesion: string, id: string) {
    this.n.delete(`${sesion}\0${id}`)
  }
  liberarSesion(sesion: string) {
    for (const k of [...this.n.keys()]) if (k.startsWith(`${sesion}\0`)) this.n.delete(k)
  }
}

/** Mensajes que el plugin registra al ignorar algo (últimos 50; también van al registro del motor). Útil para pruebas y diagnóstico. */
export const registroGanchos: string[] = []

/** Ganchos `PermissionDenied` en vuelo (no se esperan al negar); las pruebas los esperan con `esperarPendientes`. */
const pendientes = new Set<Promise<unknown>>()
export const esperarPendientes = async () => {
  while (pendientes.size) await Promise.allSettled([...pendientes])
}

/** ¿El gancho aplica a esta herramienta? Sin matcher o «*» = todas; si no, expresión regular anclada («bash|edit»). */
export const aplica = (g: Gancho, tool: string) => {
  if (!g.matcher || g.matcher === "*") return true
  try {
    return new RegExp(`^(?:${g.matcher})$`).test(tool)
  } catch {
    return false
  }
}

export type Resultado = { code: number | null; stdout: string; stderr: string; timedOut: boolean }

const matar = (pid: number | undefined) => {
  if (!pid) return
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" })
    else process.kill(-pid, "SIGKILL")
  } catch {}
}

/** Ejecuta un gancho: JSON por stdin, con tiempo máximo y salida acotada. */
export const ejecutar = (g: Gancho, payload: unknown, cwd: string, maxSalida = MAX_SALIDA): Promise<Resultado> =>
  new Promise((resolve) => {
    const child = spawn(g.command, [], {
      shell: true,
      cwd,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, LAZUNOX_HOOK: "1" },
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const tope = (acc: string, d: Buffer) => (acc.length >= maxSalida ? acc : (acc + d.toString("utf-8")).slice(0, maxSalida))
    child.stdout.on("data", (d: Buffer) => (stdout = tope(stdout, d)))
    child.stderr.on("data", (d: Buffer) => (stderr = tope(stderr, d)))
    const timer = setTimeout(() => {
      timedOut = true
      matar(child.pid)
    }, (g.timeout ?? TIEMPO_DEFECTO) * 1000)
    child.on("error", () => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr, timedOut })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
    child.stdin.on("error", () => {})
    child.stdin.end(JSON.stringify(payload))
  })

let cache: { file: string; mtime: number; cfg: Config } | undefined
const config = (file: string): Config => {
  try {
    const st = fs.statSync(file)
    if (!st.isFile() || st.size > MAX_ARCHIVO) return VACIO()
    if (cache && cache.file === file && cache.mtime === st.mtimeMs) return cache.cfg
    const cfg = leerConfig(fs.readFileSync(file, "utf-8"))
    cache = { file, mtime: st.mtimeMs, cfg }
    return cfg
  } catch {
    return VACIO()
  }
}

export async function LazunoxGanchosPlugin(input: PluginInput): Promise<Hooks> {
  const file = process.env.LAZUNOX_HOOKS_FILE
  if (!file || !path.isAbsolute(file)) return {}
  const cwd = input.directory

  const registrar = (msg: string) => {
    const linea = `[ganchos] ${msg}`.slice(0, 500)
    registroGanchos.push(linea)
    if (registroGanchos.length > 50) registroGanchos.shift()
    try {
      void Promise.resolve(input.client?.app?.log?.({ body: { service: "lazunox-ganchos", level: "warn", message: linea } } as never)).catch(() => {})
    } catch {}
  }

  // ¿Es una sesión de ayudante? Se aprende de `session.created` y, si no llegó aún, se pregunta una vez al servidor.
  const hijas = new Map<string, boolean>()
  const esHija = async (sessionID: string | undefined): Promise<boolean> => {
    if (!sessionID) return false
    const c = hijas.get(sessionID)
    if (c !== undefined) return c
    let r = false
    try {
      const got = (await input.client?.session?.get?.({ path: { id: sessionID } } as never)) as { data?: { parentID?: string } } | undefined
      r = !!got?.data?.parentID
    } catch {}
    if (hijas.size > 5000) hijas.clear()
    hijas.set(sessionID, r)
    return r
  }

  const esquemas = new Map<string, Esquemas>()
  const cont = new Continuaciones()
  const inicio = new Map<string, string>() // sesión → texto de SessionStart ya calculado
  const conStop = new Set<string>() // sesiones cuyo bucle ya llama a experimental.session.stop (el evento «idle» deja de ejecutar Stop)

  /** Ejecuta los ganchos de un evento en orden, con presupuesto total de tiempo. */
  const correr = async (nombre: keyof Config, payload: unknown, filtro?: (g: Gancho) => boolean) => {
    const lista = config(file)[nombre]
    const res: { g: Gancho; r: Resultado }[] = []
    const t0 = Date.now()
    for (const g of lista) {
      if (filtro && !filtro(g)) continue
      if (Date.now() - t0 > PRESUPUESTO_EVENTO_MS) {
        registrar(`${nombre}: se agotó el presupuesto de tiempo del evento; se omiten los ganchos restantes`)
        break
      }
      res.push({ g, r: await ejecutar(g, payload, cwd) })
    }
    return res
  }

  const textoDe = (parts: { type: string; text?: string; synthetic?: boolean }[]) =>
    parts
      .filter((p) => p.type === "text" && !p.synthetic && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n")

  return {
    // PreCompact: lo que el comando escriba en stdout (código 0) se suma al contexto del resumen (p. ej. «recuerda el plan y las reglas»).
    "experimental.session.compacting": async (i, o) => {
      for (const g of config(file).PreCompact) {
        const r = await ejecutar(g, { event: "PreCompact", sessionID: i.sessionID, cwd }, cwd)
        const txt = r.stdout.trim().slice(0, 4000)
        if (r.code === 0 && txt) o.context.push(txt)
      }
    },
    // PostCompact: el resumen salió bien. El comando recibe { event, sessionID, cwd, trigger, parcial, tokensAntes, tokensDespues } por stdin;
    // su stdout (código 0, hasta 4000 caracteres) se suma al bloque `<contexto-vigente>` marcado «[Gancho PostCompact]».
    "experimental.session.compacted": async (i, o) => {
      for (const g of config(file).PostCompact) {
        const r = await ejecutar(g, { event: "PostCompact", ...i, cwd }, cwd)
        const txt = r.stdout.trim().slice(0, 4000)
        if (r.code === 0 && txt) o.context.push(`[Gancho PostCompact]\n${txt}`)
      }
    },
    // Interfaz fija para el bucle (3A): lo llama justo antes de dar la sesión por terminada. Si algún gancho `Stop` (o `SubagentStop` con
    // `subagente: true`) pide seguir, `continuar` trae la razón y el bucle da otro turno con ella como instrucción. Tope por gancho: 5 seguidas.
    "experimental.session.stop": async (i, o) => {
      conStop.add(i.sessionID)
      const nombre = i.subagente ? "SubagentStop" : "Stop"
      const razones: string[] = []
      const res = await correr(nombre, { event: nombre, sessionID: i.sessionID, cwd, agent: i.agent })
      for (const { g, r } of res) {
        const razon = pideBloquear(r)
        if (razon === undefined) {
          cont.liberar(i.sessionID, g.command)
          if (r.timedOut) registrar(`${nombre}: el gancho «${g.command.slice(0, 80)}» pasó de su tiempo; no bloquea`)
          continue
        }
        if (!cont.intentar(i.sessionID, g.command)) {
          registrar(`${nombre}: «${g.command.slice(0, 80)}» agotó ${TOPE_CONTINUACIONES} continuaciones seguidas; se ignora y la sesión para`)
          continue
        }
        razones.push(razon)
      }
      if (razones.length) o.continuar = razones.join("\n").slice(0, MAX_RAZON)
    },
    // Estado de sesiones: aprende cuáles son de ayudante; al quedar ociosa ejecuta Stop/SubagentStop SOLO de forma informativa y únicamente si
    // el bucle no llama a `experimental.session.stop` (así no se ejecuta dos veces).
    event: async ({ event }) => {
      const props = event.properties as { sessionID?: string; status?: { type?: string }; info?: { id?: string; parentID?: string } } | undefined
      if (event.type === "session.created" && props?.info?.id) {
        hijas.set(props.info.id, !!props.info.parentID)
        return
      }
      if (event.type === "session.deleted" && props?.info?.id) {
        hijas.delete(props.info.id)
        inicio.delete(props.info.id)
        conStop.delete(props.info.id)
        cont.liberarSesion(props.info.id)
        return
      }
      if (event.type !== "session.status" || props?.status?.type !== "idle") return
      const sessionID = props.sessionID
      if (!sessionID || conStop.has(sessionID)) return
      const nombre = (await esHija(sessionID)) ? "SubagentStop" : "Stop"
      for (const g of config(file)[nombre]) await ejecutar(g, { event: nombre, sessionID, cwd }, cwd)
    },
    // SessionStart: la 1.ª vez que se arma el sistema de una sesión principal. El resultado se calcula una sola vez (queda estable en la sesión).
    "experimental.chat.system.transform": async (i, o) => {
      const sid = i.sessionID
      if (!sid || config(file).SessionStart.length === 0) return
      if (!inicio.has(sid)) {
        inicio.set(sid, "")
        if (!(await esHija(sid))) {
          const res = await correr("SessionStart", { event: "SessionStart", sessionID: sid, cwd, source: "startup" })
          const txt = res
            .map(({ r }) => textoContexto(r))
            .filter(Boolean)
            .join("\n")
            .slice(0, MAX_CONTEXTO)
          inicio.set(sid, txt)
        }
      }
      const txt = inicio.get(sid)
      if (txt) o.system.push(`[Gancho SessionStart]\n${txt}`)
    },
    // UserPromptSubmit: solo mensajes de la persona (no de ayudantes, no sintéticos). Código 2 o {"decision":"block"} lo rechaza.
    "chat.message": async (i, o) => {
      const prompt = textoDe(o.parts as never)
      if (!prompt) return // solo partes sintéticas (p. ej. la continuación del bucle): no es la persona
      cont.liberarSesion(i.sessionID) // la persona habló: las continuaciones seguidas empiezan de cero
      if (config(file).UserPromptSubmit.length === 0) return
      if (await esHija(i.sessionID)) return
      const extra: string[] = []
      for (const { r } of await correr("UserPromptSubmit", { event: "UserPromptSubmit", sessionID: i.sessionID, cwd, agent: i.agent, prompt: prompt.slice(0, 8000) })) {
        const razon = pideBloquear(r)
        if (razon !== undefined) throw new GanchoRechazoError(razon)
        const t = textoContexto(r)
        if (t) extra.push(t)
      }
      if (extra.length)
        (o.parts as unknown[]).push({
          id: PartID.ascending(),
          sessionID: i.sessionID,
          messageID: o.message.id,
          type: "text",
          text: `[Gancho UserPromptSubmit]\n${extra.join("\n").slice(0, MAX_CONTEXTO)}`,
          synthetic: true,
        })
    },
    // Guarda el esquema de cada herramienta para validar `updatedInput` de PreToolUse.
    "tool.definition": async (i, o) => {
      const x = o as { parameters?: unknown; jsonSchema?: unknown }
      esquemas.set(i.toolID, { parameters: x.parameters, jsonSchema: x.jsonSchema })
    },
    "tool.execute.before": async (i, o) => {
      for (const g of config(file).PreToolUse) {
        if (!aplica(g, i.tool)) continue
        const r = await ejecutar(g, { event: "PreToolUse", tool: i.tool, args: o.args, sessionID: i.sessionID, cwd }, cwd)
        const razon = pideBloquear(r)
        if (razon !== undefined) throw new Error(`Un gancho de usuario bloqueó esta herramienta${razon && razon !== "(sin motivo)" ? `: ${razon.slice(0, 1000)}` : "."}`)
        if (r.code !== 0 || r.timedOut) continue
        const ui = leerSalida(r.stdout).updatedInput
        if (ui === undefined) continue
        const motivo = validarEntrada(esquemas.get(i.tool), ui)
        if (motivo) {
          registrar(`PreToolUse: updatedInput de «${g.command.slice(0, 80)}» para ${i.tool} se ignora: ${motivo}`)
          continue
        }
        // Los llamantes comparten el MISMO objeto `args`: se reemplaza su contenido en sitio.
        if (o.args && typeof o.args === "object" && !Array.isArray(o.args)) {
          for (const k of Object.keys(o.args)) delete o.args[k]
          Object.assign(o.args, JSON.parse(JSON.stringify(ui)))
        }
      }
    },
    "tool.execute.after": async (i, o) => {
      const lista = config(file).PostToolUse.filter((g) => aplica(g, i.tool))
      if (!lista.length) return
      const inicial = typeof o.output === "string" ? o.output : undefined
      let actual = inicial
      let filtrado = false
      for (const g of lista) {
        const r = await ejecutar(g, { event: "PostToolUse", tool: i.tool, args: i.args, sessionID: i.sessionID, cwd, output: String(actual ?? "").slice(0, MAX_ENTRADA_SALIDA) }, cwd, MAX_SALIDA_POST)
        if (r.code === 2) {
          const why = (r.stderr || r.stdout).trim().slice(0, 1000)
          if (why && actual !== undefined) actual += `\n\n[Gancho de usuario]: ${neutralizarSalida(why)}`
          continue
        }
        // 6.8: código 0 y {"updatedToolOutput":"…"} reemplaza el texto. Código ≠ 0, tiempo vencido o texto inválido: no cambia nada.
        if (r.code !== 0 || r.timedOut || actual === undefined) continue
        const nuevo = leerSalida(r.stdout).updatedToolOutput
        if (nuevo === undefined) continue
        const v = validarSalidaNueva(nuevo)
        if ("motivo" in v) {
          registrar(`PostToolUse: updatedToolOutput de «${g.command.slice(0, 80)}» para ${i.tool} se ignora: ${v.motivo}`)
          continue
        }
        actual = v.texto
        filtrado = true
      }
      if (actual === inicial || actual === undefined) return
      if (!filtrado) {
        o.output = actual
        return
      }
      // El original completo queda en disco ANTES de reemplazar: si no se puede guardar, no se reemplaza (un filtro nunca debe ocultar sin rastro).
      let ruta: string
      try {
        fs.mkdirSync(TRUNCATION_DIR, { recursive: true })
        ruta = path.join(TRUNCATION_DIR, ToolID.ascending())
        fs.writeFileSync(ruta, inicial ?? "")
      } catch (e) {
        registrar(`PostToolUse: no se pudo guardar la salida original de ${i.tool}; no se reemplaza (${e instanceof Error ? e.message : String(e)})`)
        return
      }
      o.output = `[Un gancho de usuario filtró esta salida. El original completo (${Buffer.byteLength(inicial ?? "", "utf-8")} bytes) está en ${ruta}; si algo parece faltar, léelo con la herramienta read.]\n${actual}`
    },
    // 6.8 PostToolUseFailure: solo informa; su stdout (código 0, ≤ 2000) se añade al error que ve el modelo. El fallo sigue siendo fallo.
    "tool.execute.failure": async (i, o) => {
      const extra: string[] = []
      for (const g of config(file).PostToolUseFailure) {
        if (!aplica(g, i.tool)) continue
        const r = await ejecutar(g, { event: "PostToolUseFailure", tool: i.tool, args: i.args, sessionID: i.sessionID, cwd, error: i.error }, cwd)
        const t = neutralizarSalida(textoContexto(r))
        if (t) extra.push(t)
      }
      if (extra.length) o.contexto = extra.join("\n").slice(0, MAX_CONTEXTO_FALLO)
    },
    // 6.8 PermissionDenied: solo informa y NO espera (no retrasa la negativa). Sin argumentos de la llamada. No hay reintento.
    "permission.denied": async (i) => {
      const lista = config(file).PermissionDenied.filter((g) => aplica(g, i.permission))
      if (!lista.length) return
      const p = (async () => {
        for (const g of lista) {
          await ejecutar(g, { event: "PermissionDenied", tool: i.permission, sessionID: i.sessionID, cwd, origen: i.origen, reglas: i.reglas }, cwd).catch(() => {})
        }
      })().finally(() => pendientes.delete(p))
      pendientes.add(p)
    },
  }
}
