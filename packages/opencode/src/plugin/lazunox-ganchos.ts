import fs from "node:fs"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"

// Lazunox: ganchos de usuario por comando (como los hooks de Claude Code), solo del archivo que la APP fija en LAZUNOX_HOOKS_FILE.
// Un proyecto NO puede traer sus propios ganchos (sería ejecución de código de un repositorio ajeno): el archivo vive en la carpeta de datos de
// la app, lo escribe la persona. Formato:
//   { "hooks": { "PreToolUse": [{ "matcher": "bash|edit", "command": "./revisar.sh", "timeout": 10 }], "PostToolUse": [ … ], "PreCompact": [ … ], "Stop": [ … ] } }
// El comando recibe por stdin un JSON { event, tool, args, sessionID, cwd[, output] }. PreToolUse: código de salida 2 = BLOQUEA la herramienta y el
// modelo recibe el stderr; cualquier otro código (o un fallo, o pasarse del tiempo) no bloquea. PostToolUse: código 2 añade el stderr al resultado.

export type Gancho = { matcher?: string; command: string; timeout?: number }
export type Config = { PreToolUse: Gancho[]; PostToolUse: Gancho[]; PreCompact: Gancho[]; Stop: Gancho[] }
const VACIO = (): Config => ({ PreToolUse: [], PostToolUse: [], PreCompact: [], Stop: [] })

const MAX_ARCHIVO = 64 * 1024
const MAX_GANCHOS = 20
const MAX_SALIDA = 8 * 1024
const TIEMPO_DEFECTO = 10
const TIEMPO_MAX = 60

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
  return { PreToolUse: lista(hooks.PreToolUse), PostToolUse: lista(hooks.PostToolUse), PreCompact: lista(hooks.PreCompact), Stop: lista(hooks.Stop) }
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
export const ejecutar = (g: Gancho, payload: unknown, cwd: string): Promise<Resultado> =>
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
    const tope = (acc: string, d: Buffer) => (acc.length >= MAX_SALIDA ? acc : (acc + d.toString("utf-8")).slice(0, MAX_SALIDA))
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
  return {
    // PreCompact: lo que el comando escriba en stdout (código 0) se suma al contexto del resumen (p. ej. «recuerda el plan y las reglas»).
    "experimental.session.compacting": async (i, o) => {
      for (const g of config(file).PreCompact) {
        const r = await ejecutar(g, { event: "PreCompact", sessionID: i.sessionID, cwd }, cwd)
        const txt = r.stdout.trim().slice(0, 4000)
        if (r.code === 0 && txt) o.context.push(txt)
      }
    },
    // Stop: la sesión quedó ociosa (terminó su turno). Solo informativo: no bloquea nada.
    event: async ({ event }) => {
      const props = event.properties as { sessionID?: string; status?: { type?: string } } | undefined
      if (event.type !== "session.status" || props?.status?.type !== "idle") return
      const sessionID = props.sessionID
      for (const g of config(file).Stop) await ejecutar(g, { event: "Stop", sessionID, cwd }, cwd)
    },
    "tool.execute.before": async (i, o) => {
      for (const g of config(file).PreToolUse) {
        if (!aplica(g, i.tool)) continue
        const r = await ejecutar(g, { event: "PreToolUse", tool: i.tool, args: o.args, sessionID: i.sessionID, cwd }, cwd)
        if (r.code === 2) {
          const why = (r.stderr || r.stdout).trim().slice(0, 1000)
          throw new Error(`Un gancho de usuario bloqueó esta herramienta${why ? `: ${why}` : "."}`)
        }
      }
    },
    "tool.execute.after": async (i, o) => {
      for (const g of config(file).PostToolUse) {
        if (!aplica(g, i.tool)) continue
        const r = await ejecutar(g, { event: "PostToolUse", tool: i.tool, args: i.args, sessionID: i.sessionID, cwd, output: String(o.output ?? "").slice(0, 4000) }, cwd)
        if (r.code === 2) {
          const why = (r.stderr || r.stdout).trim().slice(0, 1000)
          if (why && typeof o.output === "string") o.output += `\n\n[Gancho de usuario]: ${why}`
        }
      }
    },
  }
}
