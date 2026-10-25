import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { NodePath } from "@effect/platform-node"
import { Cause, Duration, Effect, Layer, Option, Schedule, Context } from "effect"
import path from "path"
import type { Agent } from "../agent/agent"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { evaluate } from "@/permission/evaluate"
import { Config } from "@/config/config"
import { ToolID } from "./schema"
import { TRUNCATION_DIR } from "./truncation-dir"

const RETENTION = Duration.days(7)

export const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024
/**
 * Lazunox (P04): topes por herramienta, en bytes (≈ caracteres; tokens ≈ caracteres/4). Valen solo si la configuración
 * (`tool_output`) no fija un tope propio; `LAZUNOX_TOPES_HERRAMIENTA=0` los apaga y queda el tope global. grep y glob ya
 * se acotan a 100 resultados dentro de la herramienta; la API pública del resto queda igual.
 */
export const TOPES_HERRAMIENTA: Readonly<Record<string, { maxBytes: number }>> = {
  bash: { maxBytes: 30_000 },
  webfetch: { maxBytes: 50 * 1024 },
}
/** Tope de tokens de un resultado MCP (modo `Claude Code`: 25k). `LAZUNOX_MCP_TOPE_TOKENS` (o `MAX_MCP_OUTPUT_TOKENS`) lo cambia. */
export const MCP_TOPE_TOKENS = 25_000
/** Bytes que se reservan dentro del tope para el aviso «salida truncada…» que se añade al final. */
const RESERVA_AVISO_BYTES = 1024

export function topeTokensMcp(env: Record<string, string | undefined> = process.env) {
  const raw = env.LAZUNOX_MCP_TOPE_TOKENS ?? env.MAX_MCP_OUTPUT_TOKENS
  const n = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : MCP_TOPE_TOKENS
}

/** Opciones de `output()` para un resultado MCP: ≤ tope de tokens (preview + aviso), sin tope de líneas. */
export function opcionesMcp(env: Record<string, string | undefined> = process.env): Options {
  return { maxBytes: Math.max(RESERVA_AVISO_BYTES, topeTokensMcp(env) * 4 - RESERVA_AVISO_BYTES), maxLines: Number.MAX_SAFE_INTEGER }
}

export const DIR = TRUNCATION_DIR
export const GLOB = path.join(TRUNCATION_DIR, "*")

export type Result = { content: string; truncated: false } | { content: string; truncated: true; outputPath: string }

export interface Options {
  maxLines?: number
  maxBytes?: number
  /** Lazunox (P04): id de la herramienta, para aplicar su tope propio (ver `TOPES_HERRAMIENTA`). */
  tool?: string
  direction?: "head" | "tail"
}

function hasTaskTool(agent?: Agent.Info) {
  if (!agent?.permission) return false
  return evaluate("task", "*", agent.permission).action !== "deny"
}

export interface Interface {
  readonly cleanup: () => Effect.Effect<void>
  readonly write: (text: string) => Effect.Effect<string>
  /**
   * Returns output unchanged when it fits within the limits, otherwise writes the full text
   * to the truncation directory and returns a preview plus a hint to inspect the saved file.
   */
  readonly output: (text: string, options?: Options, agent?: Agent.Info) => Effect.Effect<Result>
  /**
   * Resolved truncation limits: values from `tool_output` in opencode config, or MAX_LINES / MAX_BYTES if unset.
   */
  readonly limits: (tool?: string) => Effect.Effect<{ maxLines: number; maxBytes: number }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Truncate") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service

    const cleanup = Effect.fn("Truncate.cleanup")(function* () {
      const cutoff = Date.now() - Duration.toMillis(RETENTION)
      const entries = yield* fs.readDirectory(TRUNCATION_DIR).pipe(
        Effect.map((all) => all.filter((name) => name.startsWith("tool_"))),
        Effect.catch(() => Effect.succeed([])),
      )
      for (const entry of entries) {
        const file = path.join(TRUNCATION_DIR, entry)
        const info = yield* fs.stat(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
        const mtime = info && Option.getOrUndefined(info.mtime)
        if (!mtime || mtime.getTime() >= cutoff) continue
        yield* fs.remove(file).pipe(Effect.catch(() => Effect.void))
      }
    })

    const write = Effect.fn("Truncate.write")(function* (text: string) {
      const file = path.join(TRUNCATION_DIR, ToolID.ascending())
      yield* fs.ensureDir(TRUNCATION_DIR).pipe(Effect.orDie)
      yield* fs.writeFileString(file, text).pipe(Effect.orDie)
      return file
    })

    const limits = Effect.fn("Truncate.limits")(function* (tool?: string) {
      const propio = tool && process.env.LAZUNOX_TOPES_HERRAMIENTA !== "0" ? TOPES_HERRAMIENTA[tool] : undefined
      const base = propio?.maxBytes ?? MAX_BYTES
      const configSvc = yield* Effect.serviceOption(Config.Service)
      if (Option.isNone(configSvc)) return { maxLines: MAX_LINES, maxBytes: base }
      const cfg = yield* configSvc.value.get().pipe(Effect.catch(() => Effect.succeed(undefined)))
      return {
        maxLines: cfg?.tool_output?.max_lines ?? MAX_LINES,
        maxBytes: cfg?.tool_output?.max_bytes ?? base,
      }
    })

    const output = Effect.fn("Truncate.output")(function* (text: string, options: Options = {}, agent?: Agent.Info) {
      const resolved = yield* limits(options.tool)
      const maxLines = options.maxLines ?? resolved.maxLines
      const maxBytes = options.maxBytes ?? resolved.maxBytes
      const direction = options.direction ?? "head"
      const lines = text.split("\n")
      const totalBytes = Buffer.byteLength(text, "utf-8")

      if (lines.length <= maxLines && totalBytes <= maxBytes) {
        return { content: text, truncated: false } as const
      }

      const out: string[] = []
      let i = 0
      let bytes = 0
      let hitBytes = false

      if (direction === "head") {
        for (i = 0; i < lines.length && i < maxLines; i++) {
          const size = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0)
          if (bytes + size > maxBytes) {
            hitBytes = true
            break
          }
          out.push(lines[i])
          bytes += size
        }
      } else {
        for (i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
          const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
          if (bytes + size > maxBytes) {
            hitBytes = true
            break
          }
          out.unshift(lines[i])
          bytes += size
        }
      }

      // Lazunox: si la primera línea sola ya pasa el tope (JSON en una línea, archivos minificados), antes la vista previa
      // quedaba vacía; ahora se muestra el principio (o el final) de esa línea cortado en un límite de carácter.
      if (out.length === 0 && lines.length > 0 && maxBytes > 0) {
        const buf = Buffer.from(direction === "head" ? lines[0] : lines[lines.length - 1], "utf-8")
        const trozo = direction === "head" ? buf.subarray(0, maxBytes) : buf.subarray(buf.length - maxBytes)
        const texto = trozo.toString("utf-8").replaceAll("\uFFFD", "")
        out.push(texto)
        bytes = Buffer.byteLength(texto, "utf-8")
      }

      const removed = hitBytes ? totalBytes - bytes : lines.length - out.length
      const unit = hitBytes ? "bytes" : "lines"
      const preview = out.join("\n")
      const file = yield* write(text)

      const hint = hasTaskTool(agent)
        ? `The tool call succeeded but the output was truncated. Full output saved to: ${file}\nUse the Task tool to have explore agent process this file with Grep and Read (with offset/limit). Do NOT read the full file yourself - delegate to save context.`
        : `The tool call succeeded but the output was truncated. Full output saved to: ${file}\nUse Grep to search the full content or Read with offset/limit to view specific sections.`

      return {
        content:
          direction === "head"
            ? `${preview}\n\n...${removed} ${unit} truncated...\n\n${hint}`
            : `...${removed} ${unit} truncated...\n\n${hint}\n\n${preview}`,
        truncated: true,
        outputPath: file,
      } as const
    })

    yield* cleanup().pipe(
      Effect.catchCause((cause) => Effect.logError("truncation cleanup failed", { cause: Cause.pretty(cause) })),
      Effect.repeat(Schedule.spaced(Duration.hours(1))),
      Effect.delay(Duration.minutes(1)),
      Effect.forkScoped,
    )

    return Service.of({ cleanup, write, output, limits })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node] })

export * as Truncate from "./truncate"
