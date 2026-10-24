import { Effect, Exit, Fiber, Schema, Scope, Stream } from "effect"
import os from "os"
import { createWriteStream } from "node:fs"
import * as Tool from "./tool"
import path from "path"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { lazy } from "@/util/lazy"
import { Language, type Node } from "web-tree-sitter"

import { FSUtil } from "@opencode-ai/core/fs-util"
import { fileURLToPath } from "url"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Shell } from "@opencode-ai/core/shell"
import { ShellID } from "./shell/id"

import * as Truncate from "./truncate"
import { Plugin } from "@/plugin"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ShellPrompt, type Parameters } from "./shell/prompt"
import { BashArity } from "@/permission/arity"
import { ShellBackground, type Job } from "./shell/background"
import { LazunoxWake } from "./lazunox-wake"
import { TrabajosDisco } from "./shell/trabajos-disco"

export { Parameters } from "./shell/prompt"

const BACKGROUND_NOTE = `

Background mode (Lazunox): for long-running commands (dev servers, watchers, long builds, tests) pass background: true. The call waits at most yield_ms (default 10000, minimum 1000); if the command has not finished it keeps running and you get a shell_id plus the output so far. Then use the shell_wait tool with that shell_id to keep waiting, read ONLY the new output, or stop it with terminate: true. Never relaunch a command that is still running. Background commands go through the same permission checks and environment as normal ones; the timeout parameter does not apply to them (a lifetime cap does, default 30 minutes), at most 3 per session and 6 in the whole engine. Without background the tool behaves as before.`

const MAX_METADATA_LENGTH = 30_000
const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])
const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  // Leave PowerShell aliases out for now. Common ones like cat/cp/mv/rm/mkdir
  // already hit the entries above, and alias normalization should happen in one
  // place later so we do not risk double-prompting.
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
const CMD_FILES = new Set([
  "copy",
  "del",
  "dir",
  "erase",
  "md",
  "mkdir",
  "move",
  "rd",
  "ren",
  "rename",
  "rmdir",
  "type",
])
const FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])

type Part = {
  type: string
  text: string
}

type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
}

type Chunk = {
  text: string
  size: number
}

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1].length === 1) return text
  return
}

function dynamic(text: string, ps: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

function prefix(text: string) {
  const match = /[?*[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

function pathArgs(list: Part[], ps: boolean, cmd = false) {
  if (!ps) {
    return list
      .slice(1)
      .filter(
        (item) =>
          !item.text.startsWith("-") &&
          !(cmd && item.text.startsWith("/")) &&
          !(list[0]?.text === "chmod" && item.text.startsWith("+")),
      )
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH)
}

function tail(text: string, maxLines: number, maxBytes: number) {
  const lines = text.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return {
      text,
      cut: false,
    }
  }

  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return {
    text: out.join("\n"),
    cut: true,
  }
}

const parse = Effect.fn("ShellTool.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => parser().then((p) => (ps ? p.ps : p.bash).parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree
})

const ask = Effect.fn("ShellTool.ask")(function* (ctx: Tool.Context, scan: Scan, input: { command: string }) {
  if (scan.dirs.size > 0) {
    const directories = Array.from(scan.dirs)
    const globs = directories.map((dir) => {
      if (process.platform === "win32") return FSUtil.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      metadata: {
        command: input.command,
        directories,
        patterns: globs,
      },
    })
  }

  if (scan.patterns.size === 0) return
  yield* ctx.ask({
    permission: ShellID.ToolID,
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    metadata: {
      command: input.command,
    },
  })
})

function cmd(shell: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && Shell.ps(shell)) {
    return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      stdin: "ignore",
      detached: false,
    })
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
}
const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

    /** Espera como mucho yieldMs a que el trabajo termine y arma la respuesta con solo la salida nueva. */
const settle = Effect.fn("ShellTool.settle")(function* (
  job: Job,
  yieldMs: number,
  ctx: Tool.Context,
  limits: { maxLines: number; maxBytes: number },
) {
      const abort = Effect.callback<void>((resume) => {
        if (ctx.abort.aborted) return resume(Effect.void)
    const handler = () => resume(Effect.void)
    ctx.abort.addEventListener("abort", handler, { once: true })
    return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
  })
  let interrupted = false
  if (job.running) {
    const outcome = yield* Effect.raceFirst(
      Effect.promise(() => job.finished).pipe(Effect.timeoutOption(`${yieldMs} millis`)),
      abort.pipe(Effect.map(() => "aborted" as const)),
    )
    interrupted = outcome === "aborted"
  }
  const fresh = ShellBackground.readNew(job, limits.maxBytes)
  // Lazunox: el modelo ya vio el resultado final; no hace falta despertarlo después.
  if (!job.running) job.consumed = true
  const parts: string[] = []
  if (fresh.skipped > 0) parts.push(`...${fresh.skipped} bytes de salida nueva omitidos (se muestra el final)...`)
  parts.push(fresh.text || (job.running ? "(sin salida nueva)" : "(sin salida nueva)"))
  if (job.capped) {
    parts.push(`<aviso>La salida llegó al tope de ${ShellBackground.bgMaxOutput()} bytes; lo que el comando escriba después se descarta.</aviso>`)
  }
  const status = interrupted && job.running ? `Espera interrumpida; el comando sigue en curso (shell_id=${job.id}).` : ShellBackground.statusLine(job)
  parts.push(`<shell_status>\n${status}\n</shell_status>`)
  return {
    title: job.command,
    metadata: {
      output: fresh.text || preview(status),
      exit: job.running ? null : job.code,
      truncated: fresh.skipped > 0 || job.capped,
      shellId: job.id,
      running: job.running,
    } as BgMetadata,
    output: parts.join("\n\n"),
  }
})


type BgMetadata = { output: string; exit: number | null; truncated: boolean; outputPath?: string; shellId?: string; running?: boolean }

const WaitParameters = Schema.Struct({
  shell_id: Schema.String.annotate({ description: "The shell_id returned by shell with background: true." }),
  yield_ms: Schema.optional(Schema.Number).annotate({
    description: "Optional. Milliseconds to wait for the command before returning (default 10000, minimum 1000).",
  }),
  terminate: Schema.optional(Schema.Boolean).annotate({
    description: "Optional. true stops the command (kills its whole process group) instead of waiting. What it already did is not undone.",
  }),
})
type WaitParameters = Schema.Schema.Type<typeof WaitParameters>

const WAIT_DESCRIPTION =
  "Wait for a command started with shell and background: true (use its shell_id), or stop it with terminate: true. Returns ONLY the output produced since the last read plus the status: still running, finished with an exit code, terminated by you, or stopped for exceeding its lifetime cap. Only works on shells started from this same session."

export const SHELL_WAIT_TOOL = "shell_wait"

export const ShellWaitTool = Tool.define(
  SHELL_WAIT_TOOL,
  Effect.gen(function* () {
    const trunc = yield* Truncate.Service
    const init: Tool.DefWithoutID<typeof WaitParameters, BgMetadata> = {
      description: WAIT_DESCRIPTION,
      parameters: WaitParameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          ShellBackground.sweepDirectory(yield* InstanceState.directory)
          const job = ShellBackground.get(params.shell_id)
          // Lazunox: lápida de ESTA sesión (el motor se reinició y el comando se perdió).
          if (!job) {
            const lapida = TrabajosDisco.tombstoneFor(params.shell_id, ctx.sessionID)
            if (lapida) throw new Error(TrabajosDisco.lostMessage(lapida))
          }
          // Misma respuesta para «no existe» y «es de otra sesión»: no se revela el trabajo ajeno.
          if (!job || job.sessionID !== ctx.sessionID) {
            throw new Error(
              `No existe el shell ${params.shell_id} en esta sesión (¿ya se limpió, es de otra sesión o se reinició el motor?).`,
            )
          }
          if (params.terminate && job.running) yield* job.kill
          return yield* settle(job, ShellBackground.clampYield(params.yield_ms), ctx, yield* trunc.limits())
        }),
    }
    return init
  }),
)

export const ShellTool = Tool.define(
  ShellID.ToolID,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const fs = yield* FSUtil.Service
    const trunc = yield* Truncate.Service
    const plugin = yield* Plugin.Service
    const flags = yield* RuntimeFlags.Service
    const defaultTimeoutMs = flags.bashDefaultTimeoutMs ?? 2 * 60 * 1000
    // Lazunox: al terminar la instancia se matan sus shells en segundo plano y se borran sus archivos de salida.
    const bgState = yield* InstanceState.make((instance) =>
      Effect.sync(() => ShellBackground.sweepDirectory(instance.directory)).pipe(
        Effect.andThen(Effect.addFinalizer(() => ShellBackground.disposeDirectory(instance.directory))),
      ),
    )

    const cygpath = Effect.fn("ShellTool.cygpath")(function* (shell: string, text: string) {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return
      return FSUtil.normalizePath(file)
    })

    const resolvePath = Effect.fn("ShellTool.resolvePath")(function* (text: string, root: string, shell: string) {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && text.startsWith("/") && FSUtil.windowsPath(text) === text) {
          const file = yield* cygpath(shell, text)
          if (file) return file
        }
        return FSUtil.normalizePath(path.resolve(root, FSUtil.windowsPath(text)))
      }
      return path.resolve(root, text)
    })

    const argPath = Effect.fn("ShellTool.argPath")(function* (arg: string, cwd: string, ps: boolean, shell: string) {
      const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
      const file = text && prefix(text)
      if (!file || dynamic(file, ps)) return
      const next = ps ? provider(file) : file
      if (!next) return
      return yield* resolvePath(next, cwd, shell)
    })

    const collect = Effect.fn("ShellTool.collect")(function* (
      root: Node,
      cwd: string,
      ps: boolean,
      shell: string,
      instance: InstanceContext,
    ) {
      const scan: Scan = {
        dirs: new Set<string>(),
        patterns: new Set<string>(),
        always: new Set<string>(),
      }
      const shellKind = ShellID.toKind(Shell.name(shell))

      for (const node of commands(root)) {
        const command = parts(node)
        const tokens = command.map((item) => item.text)
        const cmd = ps || shellKind === "cmd" ? tokens[0]?.toLowerCase() : tokens[0]

        if (cmd && (FILES.has(cmd) || (shellKind === "cmd" && CMD_FILES.has(cmd)))) {
          for (const arg of pathArgs(command, ps, shellKind === "cmd")) {
            const resolved = yield* argPath(arg, cwd, ps, shell)
            yield* Effect.logInfo("resolved path", { arg, resolved })
            if (!resolved || containsPath(resolved, instance)) continue
            const dir = (yield* fs.isDir(resolved)) ? resolved : path.dirname(resolved)
            scan.dirs.add(dir)
          }
        }

        if (tokens.length && (!cmd || !CWD.has(cmd))) {
          scan.patterns.add(source(node))
          scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
        }
      }

      return scan
    })

    const shellEnv = Effect.fn("ShellTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      return {
        ...process.env,
        ...extra.env,
      }
    })

    const run = Effect.fn("ShellTool.run")(function* (
      input: {
        shell: string
        command: string
        cwd: string
        env: NodeJS.ProcessEnv
        timeout: number
      },
      ctx: Tool.Context,
    ) {
      const limits = yield* trunc.limits()
      const keep = limits.maxBytes * 2
      let full = ""
      let last = ""
      const list: Chunk[] = []
      let used = 0
      let file = ""
      let sink: ReturnType<typeof createWriteStream> | undefined
      let cut = false
      let expired = false
      let aborted = false

      const closeSink = Effect.fnUntraced(function* () {
        const stream = sink
        if (!stream) return
        sink = undefined
        if (stream.destroyed || stream.closed) return
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              let settled = false
              const done = () => {
                if (settled) return
                settled = true
                stream.off("close", done)
                stream.off("error", done)
                stream.off("finish", done)
                resolve()
              }
              stream.once("close", done)
              stream.once("error", done)
              stream.once("finish", done)
              stream.end(done)
            }),
        ).pipe(Effect.catch(() => Effect.void))
      })

      yield* ctx.metadata({
        metadata: {
          output: "",
        },
      })

      const code: number | null = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(closeSink)
          const handle = yield* spawner.spawn(cmd(input.shell, input.command, input.cwd, input.env))

          yield* Effect.forkScoped(
            Stream.runForEach(Stream.decodeText(handle.all), (chunk) => {
              const size = Buffer.byteLength(chunk, "utf-8")
              list.push({ text: chunk, size })
              used += size
              while (used > keep && list.length > 1) {
                const item = list.shift()
                if (!item) break
                used -= item.size
                cut = true
              }

              last = preview(last + chunk)

              if (file) {
                sink?.write(chunk)
              } else {
                full += chunk
                if (Buffer.byteLength(full, "utf-8") > limits.maxBytes) {
                  return trunc.write(full).pipe(
                    Effect.andThen((next) =>
                      Effect.sync(() => {
                        file = next
                        cut = true
                        sink = createWriteStream(next, { flags: "a" })
                        full = ""
                      }),
                    ),
                    Effect.andThen(
                      ctx.metadata({
                        metadata: {
                          output: last,
                        },
                      }),
                    ),
                  )
                }
              }

              return ctx.metadata({
                metadata: {
                  output: last,
                },
              })
            }),
          )

          const abort = Effect.callback<void>((resume) => {
            if (ctx.abort.aborted) return resume(Effect.void)
            const handler = () => resume(Effect.void)
            ctx.abort.addEventListener("abort", handler, { once: true })
            return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
          })

          const timeout = Effect.sleep(`${input.timeout + 100} millis`)

          const exit = yield* Effect.raceAll([
            handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code }))),
            abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null }))),
            timeout.pipe(Effect.map(() => ({ kind: "timeout" as const, code: null }))),
          ])

          if (exit.kind === "abort") {
            aborted = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }
          if (exit.kind === "timeout") {
            expired = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }

          return exit.kind === "exit" ? exit.code : null
        }),
      ).pipe(Effect.orDie)

      const meta: string[] = []
      if (expired) {
        meta.push(
          `shell tool terminated command after exceeding timeout ${input.timeout} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.`,
        )
      }
      if (aborted) meta.push("User aborted the command")
      const raw = list.map((item) => item.text).join("")
      const end = tail(raw, limits.maxLines, limits.maxBytes)
      if (end.cut) cut = true
      if (!file && end.cut) {
        file = yield* trunc.write(raw)
      }

      let output = end.text
      if (!output) output = "(no output)"

      if (cut && file) {
        output = `...output truncated...\n\nFull output saved to: ${file}\n\n` + output
      }

      if (meta.length > 0) {
        output += "\n\n<shell_metadata>\n" + meta.join("\n") + "\n</shell_metadata>"
      }
      return {
        title: input.command,
        metadata: {
          output: last || preview(output),
          exit: code,
          truncated: cut,
          ...(cut && file ? { outputPath: file } : {}),
        } as BgMetadata,
        output,
      }
    })

    /** Lazunox: lanza el comando como trabajo en segundo plano (scope propio, no el de la llamada). */
    const startBackground = Effect.fn("ShellTool.startBackground")(function* (input: {
      shell: string
      command: string
      cwd: string
      env: NodeJS.ProcessEnv
      sessionID: string
      directory: string
      /** Lazunox: aviso al terminar (ver lazunox-wake.ts). Opcional: sin promptOps no hay aviso. */
      onFinish?: (job: Job) => Effect.Effect<void>
    }) {
      yield* InstanceState.get(bgState)
      ShellBackground.sweepDirectory(input.directory)
      ShellBackground.prune()
      const scope = yield* Scope.make()
      let resolve!: () => void
      const finished = new Promise<void>((r) => (resolve = r))
      const job: Job = {
        id: ShellBackground.newId(),
        sessionID: input.sessionID,
        directory: input.directory,
        command: input.command,
        startedAt: Date.now(),
        file: "",
        written: 0,
        capped: false,
        readOffset: 0,
        running: true,
        code: null,
        finished,
        kill: Effect.void,
      }
      job.file = ShellBackground.fileFor(job.id)
      const handle = yield* spawner.spawn(cmd(input.shell, input.command, input.cwd, input.env)).pipe(
        Scope.provide(scope),
        Effect.tapError(() => Scope.close(scope, Exit.void)),
        Effect.orDie,
      )
      // Lazunox: marcador en disco para detectar el trabajo si el motor muere sin avisar.
      TrabajosDisco.writeMarker({
        id: job.id,
        tipo: "shell",
        sessionID: input.sessionID,
        directory: input.directory,
        pid: handle.pid,
        enginePid: process.pid,
        cmdline: TrabajosDisco.cmdlineOf(handle.pid),
        titulo: input.command,
        inicio: job.startedAt,
      })

      const finish = (code: number | null) => {
        if (!job.running) return Effect.void
        job.running = false
        job.code = code
        job.reason ??= "exit"
        job.finishedAt = Date.now()
        TrabajosDisco.removeMarker(job.id)
        resolve()
        // Sin huérfanos: lo que el comando haya dejado vivo en su grupo de procesos se detiene.
        if (process.platform !== "win32") {
          try {
            process.kill(-handle.pid, "SIGTERM")
          } catch {}
        }
        const wake = input.onFinish ? input.onFinish(job).pipe(Effect.ignore, Effect.forkDetach, Effect.asVoid) : Effect.void
        return Effect.andThen(wake, Scope.close(scope, Exit.void).pipe(Effect.forkDetach, Effect.asVoid))
      }
      const stop = (reason: "terminated" | "lifetime") =>
        Effect.gen(function* () {
          if (!job.running) return
          job.reason = reason
          yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.ignore)
          yield* finish(null)
        })
      job.kill = stop("terminated")

      const reader = yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
        Effect.sync(() => ShellBackground.append(job, chunk)),
      ).pipe(Effect.ignore, Effect.forkIn(scope))
      yield* handle.exitCode.pipe(
        Effect.map((code) => Number(code) as number | null),
        Effect.catch(() => Effect.succeed(null as number | null)),
        // Deja drenar la salida pendiente (máx. 2 s por si un hijo mantiene abierta la tubería).
        Effect.tap(() => Fiber.await(reader).pipe(Effect.timeoutOption("2 seconds"))),
        Effect.flatMap(finish),
        Effect.forkIn(scope),
      )
      yield* Effect.sleep(`${ShellBackground.bgMaxLifeMs()} millis`).pipe(
        Effect.andThen(stop("lifetime")),
        Effect.forkIn(scope),
      )
      ShellBackground.register(job)
      return job
    })

    return () =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const shell = Shell.acceptable(cfg.shell)
        const name = Shell.name(shell)
        const limits = yield* trunc.limits()
        const prompt = ShellPrompt.render(name, process.platform, limits, defaultTimeoutMs)
        yield* Effect.logInfo("shell tool using shell", { shell })

        return {
          description: prompt.description + BACKGROUND_NOTE,
          parameters: prompt.parameters,
          execute: (params: Parameters, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const instanceCtx = yield* InstanceState.context
              const cwd = params.workdir
                ? yield* resolvePath(params.workdir, instanceCtx.directory, shell)
                : instanceCtx.directory
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              const timeout = params.timeout ?? defaultTimeoutMs
              const ps = Shell.ps(shell)
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const tree = yield* Effect.acquireRelease(parse(params.command, ps), (tree) =>
                    Effect.sync(() => tree.delete()),
                  )
                  const scan = yield* collect(tree.rootNode, cwd, ps, shell, instanceCtx)
                  if (!containsPath(cwd, instanceCtx)) scan.dirs.add(cwd)
                  yield* ask(ctx, scan, params)
                }),
              )

              if (params.background) {
                const refused = ShellBackground.quota(ctx.sessionID)
                if (refused) throw new Error(refused)
                // Lazunox: despertar a la conversación al terminar (agente actual, nunca más permisos). Sin promptOps no avisa.
                const wakeOps = LazunoxWake.enabled() ? LazunoxWake.opsFrom(ctx.extra) : undefined
                const job = yield* startBackground({
                  onFinish: wakeOps
                    ? (job) =>
                        Effect.gen(function* () {
                          // Margen para que un shell_wait que justo termina marque el resultado como consumido.
                          yield* Effect.sleep(`${LazunoxWake.SETTLE_DELAY_MS} millis`)
                          if (job.consumed || job.notified || job.reason === "terminated") return
                          job.notified = true
                          yield* LazunoxWake.send(wakeOps, {
                            sessionID: ctx.sessionID,
                            agent: ctx.agent,
                            since: job.startedAt,
                            what: `shell ${job.id}`,
                            text: LazunoxWake.shellNotice({
                              id: job.id,
                              estado: job.reason === "lifetime" ? "tope_de_vida" : "terminado",
                              codigo: job.code,
                              output: ShellBackground.peekTail(job, LazunoxWake.MAX_BYTES * 2),
                            }),
                          })
                        })
                    : undefined,
                  shell,
                  command: params.command,
                  cwd,
                  env: yield* shellEnv(ctx, cwd),
                  sessionID: ctx.sessionID,
                  directory: instanceCtx.directory,
                })
                return yield* settle(job, ShellBackground.clampYield(params.yield_ms), ctx, limits)
              }

              return yield* run(
                {
                  shell,
                  command: params.command,
                  cwd,
                  env: yield* shellEnv(ctx, cwd),
                  timeout,
                },
                ctx,
              )
            }),
        }
      })
  }),
)
