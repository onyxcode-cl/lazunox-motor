// Lazunox (4B, P16): LSP estable. Solo con LAZUNOX_LSP=1.
// Reglas: (1) los servidores salen SOLO del PATH del sistema (nunca la carpeta del proyecto, nunca descargas, nunca
// el directorio de binarios que baja la app); (2) el comando de un servidor propio solo viene de la configuración de
// la app/usuario (config global), jamás de la del proyecto; (3) lo que dice el servidor es DATO: mensajes acotados,
// una línea, sin etiquetas; (4) tamaño máximo por mensaje del servidor y plazos para todo.
import fs from "fs"
import path from "path"
import { Transform } from "stream"
import type { ChildProcessWithoutNullStreams } from "child_process"
import type * as LSPServer from "./server"
import type * as LSPClient from "./client"
import { spawn as lspspawn } from "./launch"

export const MAX_MENSAJE_BYTES = 4 * 1024 * 1024
export const MAX_CABECERA_BYTES = 1024
export const MAX_TEXTO_DIAGNOSTICO = 300
export const MAX_DIAGNOSTICOS_POR_ARCHIVO = 200
export const MAX_SALIDA_HERRAMIENTA = 20_000

export function plazoMs(env: NodeJS.ProcessEnv = process.env) {
  const n = Number(env.LAZUNOX_LSP_TIMEOUT_MS)
  return Number.isFinite(n) && n >= 100 && n <= 60_000 ? Math.floor(n) : 10_000
}

const win = process.platform === "win32"
const norm = (p: string) => {
  const r = path.resolve(p)
  return win ? r.toLowerCase() : r
}

/** ¿`p` está dentro de `base` (o es `base`)? */
export function dentro(p: string, base: string) {
  const rel = path.relative(norm(base), norm(p))
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

function real(p: string) {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return p
  }
}

/** Carpetas del PATH del sistema que NO son del proyecto: absolutas, no vacías, fuera del proyecto y sin `node_modules`. */
export function pathSeguro(raices: string[], env: NodeJS.ProcessEnv = process.env) {
  const crudo = env.PATH ?? env.Path ?? ""
  const bases = raices.filter(Boolean).flatMap((r) => [r, real(r)])
  const out: string[] = []
  for (const entrada of crudo.split(path.delimiter)) {
    const e = entrada.trim().replace(/^"(.*)"$/, "$1")
    if (!e || !path.isAbsolute(e)) continue
    if (e.split(/[\\/]+/).includes("node_modules")) continue
    if (bases.some((b) => dentro(e, b) || dentro(real(e), b))) continue
    if (!out.includes(e)) out.push(e)
  }
  return out
}

function esEjecutable(f: string) {
  try {
    if (!fs.statSync(f).isFile()) return false
    if (!win) fs.accessSync(f, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Resuelve el comando a una ruta absoluta con el PATH seguro. Nada de rutas relativas, nada del proyecto.
 * Un comando con ruta absoluta se admite solo si queda fuera del proyecto.
 */
export function resolver(cmd: string, raices: string[], env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!cmd || cmd.includes("\0")) return undefined
  const bases = raices.filter(Boolean).flatMap((r) => [r, real(r)])
  const fueraDelProyecto = (f: string) => !bases.some((b) => dentro(f, b) || dentro(real(f), b))
  if (/[\\/]/.test(cmd) || (win && /^[a-zA-Z]:/.test(cmd))) {
    if (!path.isAbsolute(cmd)) return undefined
    return esEjecutable(cmd) && fueraDelProyecto(cmd) ? cmd : undefined
  }
  const exts = win
    ? ["", ...(env.PATHEXT ?? env.PathExt ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
    : [""]
  for (const dir of pathSeguro(raices, env)) {
    for (const ext of exts) {
      const f = path.join(dir, cmd + ext)
      // En Windows sin extensión no hay nada ejecutable: solo vale con una de PATHEXT.
      if (win && ext === "") continue
      if (esEjecutable(f) && fueraDelProyecto(f)) return f
    }
  }
  return undefined
}

/** Entorno para el servidor: el del proceso, con el PATH ya filtrado. */
export function entornoSeguro(raices: string[], extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  const seguro = pathSeguro(raices, env).join(path.delimiter)
  for (const k of Object.keys(env)) if (k.toLowerCase() === "path") delete env[k]
  env[win ? "Path" : "PATH"] = seguro
  return env
}

// Servidores admitidos por defecto: id (de server.ts) -> binario y argumentos. Ningún otro se arranca.
export const COMANDOS: Record<string, { bin: string; args: string[] }> = {
  typescript: { bin: "typescript-language-server", args: ["--stdio"] },
  deno: { bin: "deno", args: ["lsp"] },
  pyright: { bin: "pyright-langserver", args: ["--stdio"] },
  gopls: { bin: "gopls", args: [] },
  rust: { bin: "rust-analyzer", args: [] },
  clangd: { bin: "clangd", args: [] },
  bash: { bin: "bash-language-server", args: ["start"] },
  "yaml-ls": { bin: "yaml-language-server", args: ["--stdio"] },
  "lua-ls": { bin: "lua-language-server", args: [] },
  zls: { bin: "zls", args: [] },
  "ocaml-lsp": { bin: "ocamllsp", args: [] },
}

/**
 * Pone un guardián entre la salida del servidor y el lector JSON-RPC: si anuncia un mensaje de más de `max` bytes,
 * una cabecera sin sentido o demasiado larga, se mata al servidor y se descarta todo lo que siga.
 */
export function guardarSalida(proc: ChildProcessWithoutNullStreams, max = MAX_MENSAJE_BYTES, onViolacion?: (m: string) => void) {
  let resto = 0
  let cabecera = Buffer.alloc(0)
  let muerto = false
  const violar = (motivo: string) => {
    muerto = true
    try {
      proc.kill("SIGKILL")
    } catch {}
    onViolacion?.(motivo)
  }
  const guardia = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (muerto) return cb()
      let i = 0
      while (i < chunk.length && !muerto) {
        if (resto > 0) {
          const n = Math.min(resto, chunk.length - i)
          resto -= n
          i += n
          continue
        }
        cabecera = Buffer.concat([cabecera, chunk.subarray(i, i + 1)])
        i++
        if (cabecera.length > MAX_CABECERA_BYTES) {
          violar("cabecera demasiado larga")
          break
        }
        if (cabecera.length >= 4 && cabecera.subarray(-4).toString("latin1") === "\r\n\r\n") {
          const m = /content-length:\s*(\d+)/i.exec(cabecera.toString("latin1"))
          cabecera = Buffer.alloc(0)
          if (!m) {
            violar("mensaje sin Content-Length")
            break
          }
          const len = Number(m[1])
          if (!Number.isSafeInteger(len) || len > max) {
            violar(`mensaje de ${m[1]} bytes (tope ${max})`)
            break
          }
          resto = len
        }
      }
      // Si se violó el tope no pasa nada de este trozo: el lector no ve ni un byte del mensaje enorme.
      if (muerto) return cb()
      cb(null, chunk)
    },
  })
  proc.stdout.pipe(guardia)
  Object.defineProperty(proc, "stdout", { value: guardia, configurable: true })
  return guardia
}

/** Arranca un servidor ya resuelto, con entorno filtrado y guardián de salida. */
export function arrancar(abs: string, args: string[], root: string, raices: string[], extraEnv?: Record<string, string>) {
  const proc = lspspawn(abs, args, { cwd: root, env: entornoSeguro(raices, extraEnv) })
  guardarSalida(proc)
  return proc as ChildProcessWithoutNullStreams
}

type ServidorUsuario = {
  command: readonly string[]
  extensions?: readonly string[]
  disabled?: boolean
  env?: Record<string, string>
  initialization?: Record<string, any>
}

/**
 * Construye la tabla de servidores del modo estable.
 * - `base`: los servidores del código (para reutilizar `root` y `extensions`).
 * - `usuario`: `lsp` de la configuración GLOBAL (la de la app o el usuario). Es la única fuente de comandos propios.
 * - `proyecto`: `lsp` de la configuración fusionada; solo puede APAGAR servidores (`disabled`), nunca fijar comandos.
 */
export function servidores(input: {
  base: Record<string, LSPServer.Info>
  usuario: unknown
  proyecto: unknown
  raices: string[]
  aviso?: (m: string) => void
}) {
  const out: Record<string, LSPServer.Info> = {}
  for (const [id, cmd] of Object.entries(COMANDOS)) {
    const b = input.base[id]
    if (!b) continue
    out[id] = {
      ...b,
      async spawn(root) {
        // Se resuelve al arrancar (no antes): si el usuario instala el servidor luego, se ve.
        const abs = resolver(cmd.bin, input.raices)
        if (!abs) return undefined
        const process = arrancar(abs, cmd.args, root, input.raices)
        // typescript-language-server busca `typescript` por su cuenta; no se le pasa la ruta del proyecto.
        return { process }
      },
    }
  }
  const usuario = input.usuario && typeof input.usuario === "object" ? (input.usuario as Record<string, any>) : {}
  for (const [name, item] of Object.entries(usuario) as [string, ServidorUsuario][]) {
    if (!item || typeof item !== "object") continue
    if (item.disabled) {
      delete out[name]
      continue
    }
    if (!Array.isArray(item.command) || item.command.length === 0 || item.command.some((x) => typeof x !== "string")) continue
    const existing = input.base[name]
    out[name] = {
      ...existing,
      id: name,
      root: existing?.root ?? (async (_f, ctx) => ctx.directory),
      extensions: [...(item.extensions ?? existing?.extensions ?? [])],
      async spawn(root) {
        const abs = resolver(item.command[0], input.raices)
        if (!abs) return undefined
        return {
          process: arrancar(abs, item.command.slice(1), root, input.raices, item.env),
          initialization: item.initialization,
        }
      },
    }
  }
  // La configuración del proyecto solo apaga.
  const proj = input.proyecto && typeof input.proyecto === "object" ? (input.proyecto as Record<string, any>) : {}
  for (const [name, item] of Object.entries(proj)) {
    if (item && typeof item === "object" && item.disabled) delete out[name]
    else if (item && typeof item === "object" && Array.isArray((item as any).command) && !usuario[name])
      input.aviso?.(`el servidor LSP «${name}» viene de la configuración del proyecto y se ignora`)
  }
  return out
}

/** Un texto del servidor es un dato: una línea, sin control, sin etiquetas, acotado. */
export function limpiarTexto(s: unknown, max = MAX_TEXTO_DIAGNOSTICO) {
  let t = typeof s === "string" ? s : String(s ?? "")
  // eslint-disable-next-line no-control-regex
  t = t.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/</g, "&lt;")
  if (t.length > max) t = t.slice(0, max) + "…"
  return t
}

export function limpiarDiagnosticos(list: LSPClient.Diagnostic[]): LSPClient.Diagnostic[] {
  return list.slice(0, MAX_DIAGNOSTICOS_POR_ARCHIVO).map((d) => ({ ...d, message: limpiarTexto(d.message) }))
}

/** Recorta la salida de la herramienta `lsp` (datos del servidor). */
export function acotarSalida(texto: string, max = MAX_SALIDA_HERRAMIENTA) {
  if (texto.length <= max) return texto
  return `${texto.slice(0, max)}\n… [salida del servidor recortada: ${texto.length} caracteres, tope ${max}]`
}
