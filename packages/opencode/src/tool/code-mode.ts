import * as Tool from "./tool"
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { Cause, Effect, Schema } from "effect"
import { CodeMode, Tool as SandboxTool, toolError } from "@opencode-ai/codemode"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import * as McpEnCurso from "@/mcp/en-curso"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { BackgroundJob } from "@/background/job"
import { LazunoxWake } from "./lazunox-wake"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { InstanceRef } from "@/effect/instance-ref"
import { TrabajosDisco } from "./shell/trabajos-disco"
import { ShellBackground } from "./shell/background"

export const CODE_MODE_TOOL = "execute"

const DESCRIPTION =
  "Run a confined orchestration script with access to connected MCP tools. If the script takes longer than yield_ms it keeps running in the background and you get a cell_id: use execute_wait to keep waiting, read the result or terminate it. Calls it already made are never undone."

const WAIT_DESCRIPTION =
  "Wait for a script started with execute that was still running (use its cell_id), or terminate it with terminate: true. Returns the final result when it finishes, or says it is still running."

export const Parameters = Schema.Struct({
  code: Schema.String.annotate({
    description: "Script body executed by the confined interpreter.",
  }),
  yield_ms: Schema.optional(Schema.Number).annotate({
    description:
      "Optional. How many milliseconds to wait for the script before returning while it keeps running (default 30000). If it is still running you get a cell_id: call execute_wait to keep waiting, read its progress, or terminate it.",
  }),
})

export const WaitParameters = Schema.Struct({
  cell_id: Schema.String.annotate({ description: "The cell_id returned by execute while the script was still running." }),
  yield_ms: Schema.optional(Schema.Number).annotate({
    description: "Optional. Milliseconds to wait before returning again (default 30000).",
  }),
  terminate: Schema.optional(Schema.Boolean).annotate({
    description: "Optional. true stops the script instead of waiting. What it already did is not undone.",
  }),
})

type CallEntry = { tool: string; status: "running" | "completed" | "error"; input?: Record<string, unknown> }

type Metadata = {
  toolCalls: CallEntry[]
  error?: boolean
  cellId?: string
}

type Attachment = NonNullable<Tool.ExecuteResult["attachments"]>[number]

type CatalogEntry = {
  path: string
  key: string
  server: string
  local: string
  tool: MCP.McpTool
}

function groupByServer(mcpTools: Record<string, MCP.McpTool>, servers: readonly string[]): Map<string, CatalogEntry[]> {
  const byLongest = [...servers].sort((a, b) => b.length - a.length)
  const groups = new Map<string, CatalogEntry[]>()
  for (const key of Object.keys(mcpTools).sort((a, b) => a.localeCompare(b))) {
    const server =
      byLongest.find((name) => key.startsWith(name + "_")) ?? (key.includes("_") ? key.slice(0, key.indexOf("_")) : key)
    const local = server && key.startsWith(server + "_") ? key.slice(server.length + 1) : key
    const entry: CatalogEntry = {
      path: `${server}.${local}`,
      key,
      server,
      local,
      tool: mcpTools[key]!,
    }
    groups.set(server, [...(groups.get(server) ?? []), entry])
  }
  return groups
}

// Lazunox: OpenCode no fija límites en Code Mode (un script podría encadenar cientos de llamadas MCP). Estos valores por defecto
// se pueden bajar o subir con LAZUNOX_CODE_MODE_TIMEOUT_MS, LAZUNOX_CODE_MODE_MAX_TOOL_CALLS y LAZUNOX_CODE_MODE_MAX_OUTPUT_BYTES.
const limitFromEnv = (name: string, fallback: number) => {
  const n = Number(process.env[name])
  return Number.isInteger(n) && n > 0 ? n : fallback
}
export const CODE_MODE_YIELD_MS = limitFromEnv("LAZUNOX_CODE_MODE_YIELD_MS", 30_000)
export const CODE_MODE_MAX_CELLS = limitFromEnv("LAZUNOX_CODE_MODE_MAX_CELLS", 3)
export const CODE_MODE_LIMITS = {
  timeoutMs: limitFromEnv("LAZUNOX_CODE_MODE_TIMEOUT_MS", 600_000),
  maxToolCalls: limitFromEnv("LAZUNOX_CODE_MODE_MAX_TOOL_CALLS", 1000),
  maxOutputBytes: limitFromEnv("LAZUNOX_CODE_MODE_MAX_OUTPUT_BYTES", 5_000_000),
} as const

export function describeCatalog(mcpTools: Record<string, MCP.McpTool>, servers: readonly string[]): string {
  return CodeMode.make({
    tools: toolTree(
      [...groupByServer(mcpTools, servers).values()].flat(),
      () => () => Effect.fail(toolError("Tool preview is not executable.")),
    ),
  }).instructions()
}

const lastSegment = (uri: string) => {
  const trimmed = uri.split(/[?#]/, 1)[0]!.replace(/\/+$/, "")
  const segment = trimmed.slice(trimmed.lastIndexOf("/") + 1)
  return segment.length > 0 ? segment : undefined
}

const dataUrl = (mime: string, base64: string) => `data:${mime};base64,${base64}`

function projectMcpResult(result: CallToolResult, collect: (attachment: Attachment) => void): unknown {
  const text: string[] = []
  let files = 0
  let images = 0
  const push = (attachment: Attachment) => {
    files += 1
    if (attachment.mime.startsWith("image/")) images += 1
    collect(attachment)
  }
  for (const block of result.content) {
    switch (block.type) {
      case "text":
        text.push(block.text)
        break
      case "image":
      case "audio":
        push({ type: "file", mime: block.mimeType, url: dataUrl(block.mimeType, block.data) })
        break
      case "resource": {
        if ("text" in block.resource) {
          text.push(block.resource.text)
          break
        }
        const mime = block.resource.mimeType ?? "application/octet-stream"
        push({ type: "file", mime, url: dataUrl(mime, block.resource.blob), filename: lastSegment(block.resource.uri) })
        break
      }
      case "resource_link":
        // A link is a reference, not fetchable media; hand it to the program instead of the attachment channel.
        text.push(`${block.name}: ${block.uri}`)
        break
    }
  }

  if (result.structuredContent !== undefined && result.structuredContent !== null) return result.structuredContent
  if (text.length > 0) return text.join("\n")
  if (files > 0) {
    const noun = files === images ? "image" : "file"
    return `[${files} ${noun}${files === 1 ? "" : "s"} attached to the result]`
  }
  return null
}

type Run = (input: unknown) => Effect.Effect<unknown, unknown>

function toolTree(catalog: readonly CatalogEntry[], run: (entry: CatalogEntry) => Run) {
  const tree: Record<string, Record<string, SandboxTool.Definition>> = {}
  for (const entry of catalog) {
    const namespace = (tree[entry.server] ??= {})
    namespace[entry.local] = SandboxTool.make({
      description: entry.tool.def.description ?? "",
      input: entry.tool.def.inputSchema as SandboxTool.JsonSchema,
      output: entry.tool.def.outputSchema as SandboxTool.JsonSchema | undefined,
      run: run(entry),
    })
  }
  return tree
}

const invokeChildTool = Effect.fn("CodeMode.invokeChildTool")(function* (input: {
  plugin: Plugin.Interface
  entry: CatalogEntry
  args: Record<string, unknown>
  callID: string
  ctx: Tool.Context
}) {
  yield* input.plugin.trigger(
    "tool.execute.before",
    { tool: input.entry.key, sessionID: input.ctx.sessionID, callID: input.callID },
    { args: input.args },
  )
  const result: CallToolResult = yield* Effect.gen(function* () {
    yield* input.ctx.ask({ permission: input.entry.key, metadata: {}, patterns: ["*"], always: ["*"] })
    // Deliberately mirrors McpCatalog.convertTool's transport call so the MCP service stays free of tool-loop concerns.
    // Lazunox: la llamada se registra como «viva» (formularios MCP) y, con la variable activa, su tiempo lo mide un
    // temporizador que se pausa mientras haya un formulario abierto (mcp/en-curso.ts).
    return yield* McpEnCurso.conLlamadaViva({
      call: {
        key: input.entry.key,
        sessionID: input.ctx.sessionID,
        messageID: input.ctx.messageID,
        callID: input.callID,
        abort: input.ctx.abort,
        client: input.entry.tool.client,
      },
      timeoutMs: input.entry.tool.timeout,
      use: (t) =>
        Effect.promise(async () => {
          const raw = await input.entry.tool.client.callTool(
            { name: input.entry.tool.def.name, arguments: input.args },
            CallToolResultSchema,
            {
              resetTimeoutOnProgress: true,
              signal: t.signal,
              timeout: t.timeout,
              // The MCP SDK only sends a progress token when this hook is present, enabling timeout resets.
              onprogress: () => t.onprogress(),
            },
          )
          if (raw.isError)
            throw new Error(
              raw.content
                .flatMap((item) => (item.type === "text" ? [item.text] : []))
                .filter((text) => text.trim())
                .join("\n\n") || "MCP tool returned an error",
            )
          return raw
        }),
    })
  }).pipe(
    Effect.withSpan("Tool.execute", {
      attributes: {
        "tool.name": input.entry.key,
        "tool.call_id": input.callID,
        "session.id": input.ctx.sessionID,
        "message.id": input.ctx.messageID,
      },
    }),
  )
  yield* input.plugin.trigger(
    "tool.execute.after",
    { tool: input.entry.key, sessionID: input.ctx.sessionID, callID: input.callID, args: input.args },
    result,
  )
  return result
})

// Lazunox: directorio de la instancia si hay (en pruebas sueltas no la hay).
const instanceDirectory = Effect.map(InstanceRef, (ctx) => ctx?.directory ?? "")

export const CELL_JOB_TYPE = TrabajosDisco.CELL_JOB_TYPE

// `execute` no debe bloquear la conversación más de ~50 s (la app vigila las ejecuciones largas); `execute_wait` puede esperar más.
const MAX_YIELD_EXECUTE_MS = 50_000
const MAX_YIELD_WAIT_MS = 300_000

const clampYield = (value: number | undefined, max = MAX_YIELD_EXECUTE_MS) => {
  const requested = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : CODE_MODE_YIELD_MS
  return Math.min(Math.max(requested, 1_000), Math.min(max, CODE_MODE_LIMITS.timeoutMs))
}

// Lazunox (celda viva): registro por celda, a nivel de módulo, para que `execute_wait` vea lo mismo que `execute`.
// La revocación vive aquí (por celda, nunca global). Al terminar, la celda se borra del registro salvo que esté revocada
// (así `execute_wait` sigue explicando por qué se detuvo); las revocadas se guardan acotadas.
export const CELL_REVOKED_MESSAGE =
  "El usuario rechazó un permiso dentro de este programa: no se ejecutan más herramientas."
const SUMMARY_MAX_CHARS = 1_000
const SUMMARY_INPUT_MAX = 80
const REVOKED_KEEP = 50

type CellRecord = {
  sessionID: string
  startedAt: number
  calls: CallEntry[]
  revoked: boolean
}
const cellRecords = new Map<string, CellRecord>()

const finishCell = (cellId: string) => {
  const rec = cellRecords.get(cellId)
  if (!rec) return
  if (!rec.revoked) return void cellRecords.delete(cellId)
  rec.calls = []
  // Solo se conservan las últimas REVOKED_KEEP celdas revocadas (el Map conserva el orden de inserción).
  const revoked = [...cellRecords.entries()].filter(([, r]) => r.revoked)
  for (const [id] of revoked.slice(0, Math.max(0, revoked.length - REVOKED_KEEP))) cellRecords.delete(id)
}

const isPermissionRefusal = (error: unknown) =>
  error instanceof PermissionV1.RejectedError ||
  error instanceof PermissionV1.CorrectedError ||
  (typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    (error._tag === "PermissionRejectedError" || error._tag === "PermissionCorrectedError"))

const shorten = (value: unknown, max: number) => {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value)
    const flat = (text ?? "").replace(/\s+/g, " ")
    return flat.length > max ? flat.slice(0, max) + "…" : flat
  } catch {
    return "(no se pudo resumir)"
  }
}

/** Resumen acotado (≤ 1 KB) de una celda en curso: llamadas completadas, las 3 últimas y segundos transcurridos. */
export const summarizeCell = (rec: Pick<CellRecord, "calls" | "startedAt">, now = Date.now()) => {
  const made = rec.calls.filter(Boolean)
  const completed = made.filter((c) => c.status === "completed").length
  const seconds = Math.max(0, Math.round((now - rec.startedAt) / 1000))
  const lines = [`Resumen: ${completed} llamada(s) completada(s), ${seconds} s transcurridos.`]
  const last = made.slice(-3)
  if (last.length > 0) {
    lines.push("Últimas llamadas:")
    for (const c of last) {
      const input = c.input === undefined ? "" : shorten(c.input, SUMMARY_INPUT_MAX)
      lines.push(`- ${c.tool}(${input}) [${c.status}]`)
    }
  }
  const text = lines.join("\n")
  return text.length > SUMMARY_MAX_CHARS ? text.slice(0, SUMMARY_MAX_CHARS - 1) + "…" : text
}

type Settled =
  | { kind: "done"; text: string }
  | { kind: "running"; text: string }
  | { kind: "failed"; message: string }
  | { kind: "cancelled"; text: string }

/** Traduce el estado de la celda (trabajo en segundo plano) en lo que ve el modelo. */
const settledResult = (waited: BackgroundJob.WaitResult, cellId: string): Settled => {
  const rec = cellRecords.get(cellId)
  const info = waited.info
  if (!info) return { kind: "failed", message: `No existe la celda ${cellId} (¿ya terminó hace tiempo o se reinició el motor?).` }
  // Una celda revocada nunca entrega su resultado, aunque el script haya alcanzado a terminar atrapando los errores.
  if (rec?.revoked) return { kind: "cancelled", text: CELL_REVOKED_MESSAGE }
  if (info.status === "running") {
    return {
      kind: "running",
      text: [
        `Script en curso (cell_id=${cellId}). Sigue ejecutándose.`,
        ...(rec ? [summarizeCell(rec)] : []),
        "No lo vuelvas a lanzar. Usa execute_wait con este cell_id para seguir esperando o leer el resultado, o terminate: true para pararlo (lo ya hecho no se deshace).",
      ].join("\n"),
    }
  }
  if (info.status === "completed") return { kind: "done", text: info.output ?? "" }
  if (info.status === "cancelled") return { kind: "cancelled", text: "Script terminado (lo que ya había hecho no se deshizo)." }
  return { kind: "failed", message: info.error ?? "El script falló." }
}

export const CodeModeTool = Tool.define(
  CODE_MODE_TOOL,
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const agents = yield* Agent.Service
    const sessions = yield* Session.Service
    const plugin = yield* Plugin.Service
    const jobs = yield* BackgroundJob.Service

    const init: Tool.DefWithoutID<typeof Parameters, Metadata> = {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: Effect.fn("CodeMode.execute")(function* (params, ctx) {
        if (ctx.abort.aborted) {
          return {
            title: CODE_MODE_TOOL,
            metadata: { toolCalls: [], error: true },
            output: "Execution cancelled.",
          } satisfies Tool.ExecuteResult<Metadata>
        }
        const agent = yield* agents.get(ctx.agent)
        const session = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)
        const ruleset = Permission.merge(agent.permission, session.permission ?? [])
        const mcpTools = Permission.visibleTools(yield* mcp.tools(), ruleset)
        const servers = Object.keys(yield* mcp.clients()).map(McpCatalog.sanitize)
        const catalog = [...groupByServer(mcpTools, servers).values()].flat()

        const calls: CallEntry[] = []
        const attachments: Attachment[] = []
        const publish = () =>
          ctx.metadata({ title: CODE_MODE_TOOL, metadata: { toolCalls: calls.map((c) => ({ ...c })) } })

        // Lazunox: resumen de lo que cada llamada ya devolvió, para que el modelo retome sin repetir si un límite corta el script.
        const done: { tool: string; input: string; result: string }[] = []
        const preview = (value: unknown, max: number) => {
          try {
            const text = typeof value === "string" ? value : JSON.stringify(value)
            return (text ?? "").length > max ? (text ?? "").slice(0, max) + "…" : (text ?? "")
          } catch {
            return "(no se pudo resumir)"
          }
        }

        // Lazunox: el script corre como una «celda» que puede seguir viva después de que esta llamada devuelva el control (pausa y
        // espera al estilo de Codex). `ctx.abort` se dispara al terminar el turno del modelo, así que las llamadas internas usan una
        // señal propia que solo se activa al terminar o cancelar la celda.
        const cellAbort = new AbortController()
        const cellCtx: Tool.Context = { ...ctx, abort: cellAbort.signal }

        const cellId = `cm_${(ctx.callID ?? "").replace(/[^A-Za-z0-9]/g, "").slice(-8)}${Math.random().toString(36).slice(2, 6)}`
        const record: CellRecord = { sessionID: ctx.sessionID, startedAt: Date.now(), calls, revoked: false }
        // Un rechazo de permiso revoca ESTA celda: las llamadas siguientes fallan al instante y la celda se termina.
        const revoke = Effect.gen(function* () {
          if (record.revoked) return
          record.revoked = true
          cellAbort.abort()
          // Se cancela desde otra fibra: cancelar el trabajo cierra su ámbito, y esta llamada corre dentro de él.
          yield* Effect.forkDetach(jobs.cancel(cellId))
        })

        let childCalls = 0
        const callTool = (entry: CatalogEntry) => (input: unknown) =>
          Effect.gen(function* () {
            if (record.revoked) return yield* Effect.fail(toolError(CELL_REVOKED_MESSAGE))
            childCalls += 1
            const result = yield* invokeChildTool({
              plugin,
              entry,
              args: (input ?? {}) as Record<string, unknown>,
              callID: `${ctx.callID ?? entry.key}/${childCalls}`,
              ctx: cellCtx,
            })
            const projected = projectMcpResult(result, (attachment: Attachment) => void attachments.push(attachment))
            if (done.length < 30)
              done.push({ tool: entry.key, input: preview(input, 120), result: preview(projected, 300) })
            return projected
          }).pipe(
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
              const error = Cause.squash(cause)
              if (isPermissionRefusal(error)) return revoke.pipe(Effect.andThen(Effect.fail(toolError(CELL_REVOKED_MESSAGE, error))))
              return Effect.fail(toolError(error instanceof Error ? error.message : String(error), error))
            }),
          )

        const runtime = CodeMode.make({
          tools: toolTree(catalog, callTool),
          limits: CODE_MODE_LIMITS,
          onToolCallStart: ({ index, name, input }) =>
            Effect.suspend(() => {
              const shown = (() => {
                if (input === null || input === undefined) return
                if (typeof input === "object" && !Array.isArray(input)) {
                  const value = input as Record<string, unknown>
                  return Object.keys(value).length > 0 ? value : undefined
                }
                return { input }
              })()
              calls[index] = { tool: name, status: "running", ...(shown ? { input: shown } : {}) }
              return publish()
            }),
          onToolCallEnd: ({ index, outcome }) =>
            Effect.suspend(() => {
              const current = calls[index]
              if (current) calls[index] = { ...current, status: outcome === "success" ? "completed" : "error" }
              return publish()
            }),
        })

        const abort = Effect.callback<void>((resume) => {
          if (ctx.abort.aborted) return resume(Effect.void)
          const handler = () => resume(Effect.void)
          ctx.abort.addEventListener("abort", handler, { once: true })
          return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
        })

        // Cuerpo de la celda: ejecuta el script y devuelve el texto final (o falla con el mensaje para el modelo).
        const cell = Effect.gen(function* () {
          const result = yield* runtime.execute(params.code)
          const logs = result.logs ?? []
          const withLogs = (text: string) => {
            if (logs.length === 0) return text
            return text.length > 0 ? `${text}\n\nLogs:\n${logs.join("\n")}` : `Logs:\n${logs.join("\n")}`
          }

          if (!result.ok) {
            const hints = (result.error.suggestions ?? []).filter((hint) => !result.error.message.includes(hint))
            // Lazunox: al llegar a un límite el script se corta, pero lo que ya hizo se conserva (las llamadas hechas no se deshacen).
            // Se lo decimos al modelo para que retome por tandas en vez de repetir todo.
            const stopped =
              result.error.kind === "ToolCallLimitExceeded" || result.error.kind === "TimeoutExceeded"
                ? [
                    `El script se detuvo por un límite (${result.error.kind}). Las ${calls.filter((c) => c.status === "completed").length} llamadas que ya se completaron SÍ se ejecutaron y no se deshacen; solo se perdió lo que el script guardaba en memoria.`,
                    ...(done.length > 0
                      ? [
                          "Ya obtenido (no lo repitas):",
                          ...done.map((d, i) => `${i + 1}. ${d.tool}(${d.input}) -> ${d.result}`),
                        ]
                      : []),
                    "Para continuar, vuelve a ejecutar solo lo que faltó, en tandas más chicas, y devuelve los resultados parciales al terminar cada tanda (puedes envolver el bucle en try/catch: el límite se puede atrapar y devolver lo hecho hasta ese punto).",
                  ]
                : []
            return yield* Effect.fail(new Error(withLogs([result.error.message, ...hints, ...stopped].join("\n"))))
          }

          // The interpreter validates returned values as plain JSON, so stringify cannot throw;
          // it yields undefined only for a program that returns undefined.
          const output =
            typeof result.value === "string"
              ? result.value
              : (JSON.stringify(result.value, null, 2) ?? String(result.value))
          return withLogs(output)
        }).pipe(
          Effect.onInterrupt(() => Effect.sync(() => cellAbort.abort())),
          Effect.ensuring(Effect.sync(() => finishCell(cellId))),
        )

        // Celdas vivas de sesiones que ya no existen (borradas): se cancelan para que no queden scripts huérfanos.
        for (const j of (yield* jobs.list()).filter((j) => j.type === CELL_JOB_TYPE && j.status === "running")) {
          const owner = j.metadata?.["sessionID"]
          if (typeof owner !== "string" || owner === ctx.sessionID) continue
          const alive = yield* sessions.get(SessionID.make(owner)).pipe(
            Effect.map(() => true),
            Effect.catch(() => Effect.succeed(false)),
          )
          if (!alive) yield* jobs.cancel(j.id)
        }
        const running = (yield* jobs.list()).filter((j) => j.type === CELL_JOB_TYPE && j.status === "running")
        if (running.length >= CODE_MODE_MAX_CELLS) {
          // Solo se nombran las celdas de ESTA sesión: los ids de otras no se filtran.
          const own = running.filter((j) => j.metadata?.["sessionID"] === ctx.sessionID)
          return yield* Effect.fail(
            new Error(
              `Ya hay ${running.length} scripts en curso en esta carpeta` +
                (own.length > 0 ? ` (tuyos: ${own.map((j) => j.id).join(", ")})` : "") +
                `. Espera a que terminen con execute_wait o termina alguno tuyo con terminate: true.`,
            ),
          )
        }

        cellRecords.set(cellId, record)
        // Lazunox: marcador en disco (se borra al terminar la celda); si el motor muere queda como huérfano.
        const directory = yield* instanceDirectory
        TrabajosDisco.writeMarker({
          id: cellId,
          tipo: "celda",
          sessionID: ctx.sessionID,
          directory,
          pid: process.pid,
          enginePid: process.pid,
          cmdline: "",
          titulo: `Code Mode: ${params.code.trim().split("\n")[0] ?? ""}`,
          inicio: Date.now(),
        })
        yield* jobs.start({
          id: cellId,
          type: CELL_JOB_TYPE,
          title: "Code Mode",
          metadata: { sessionID: ctx.sessionID, titulo: `Code Mode: ${params.code.trim().split("\n")[0] ?? ""}`.slice(0, 200) },
          run: cell.pipe(Effect.ensuring(Effect.sync(() => TrabajosDisco.removeMarker(cellId)))),
        })

        // Lazunox: si la celda cede el control y nadie lee su resultado, se despierta a la conversación al terminar.
        const wakeOps = LazunoxWake.enabled() ? LazunoxWake.opsFrom(ctx.extra) : undefined
        if (wakeOps) {
          yield* jobs.wait({ id: cellId, timeout: CODE_MODE_LIMITS.timeoutMs + 60_000 }).pipe(
            Effect.flatMap((end) =>
              Effect.gen(function* () {
                yield* Effect.sleep(`${LazunoxWake.SETTLE_DELAY_MS} millis`)
                const consumed = LazunoxWake.cellConsumed(cellId)
                LazunoxWake.forgetCell(cellId)
                const info = end.info
                if (consumed || !info || info.status === "running" || info.status === "cancelled") return
                yield* LazunoxWake.send(wakeOps, {
                  sessionID: ctx.sessionID,
                  agent: ctx.agent,
                  since: record.startedAt,
                  what: `celda ${cellId}`,
                  text: LazunoxWake.cellNotice({
                    id: cellId,
                    estado: info.status === "completed" ? "terminada" : "con_error",
                    output: info.status === "completed" ? (info.output ?? "") : (info.error ?? ""),
                  }),
                })
              }),
            ),
            Effect.ignore,
            Effect.forkDetach,
          )
        }

        const yieldMs = clampYield(params.yield_ms)
        const waited = yield* Effect.raceFirst(
          jobs.wait({ id: cellId, timeout: yieldMs }),
          abort.pipe(Effect.map(() => "aborted" as const)),
        )

        if (waited === "aborted") {
          yield* jobs.cancel(cellId)
          return {
            title: CODE_MODE_TOOL,
            metadata: { toolCalls: calls, error: true },
            output: "Execution cancelled.",
          } satisfies Tool.ExecuteResult<Metadata>
        }

        const settled = settledResult(waited, cellId)
        if (settled.kind !== "running") LazunoxWake.markCellConsumed(cellId)
        if (settled.kind === "failed") return yield* Effect.fail(new Error(settled.message))
        return {
          title: CODE_MODE_TOOL,
          metadata: {
            toolCalls: calls,
            ...(record.revoked ? { error: true } : {}),
            ...(settled.kind === "running" ? { cellId } : {}),
          },
          output: settled.text,
          ...(settled.kind === "done" && attachments.length > 0 ? { attachments } : {}),
        } satisfies Tool.ExecuteResult<Metadata>
      }, Effect.orDie),
    }
    return init
  }),
)

export const CODE_MODE_WAIT_TOOL = "execute_wait"

export const CodeModeWaitTool = Tool.define(
  CODE_MODE_WAIT_TOOL,
  Effect.gen(function* () {
    const jobs = yield* BackgroundJob.Service

    const init: Tool.DefWithoutID<typeof WaitParameters, Metadata> = {
      description: WAIT_DESCRIPTION,
      parameters: WaitParameters,
      execute: Effect.fn("CodeMode.wait")(function* (params, ctx) {
        const id = params.cell_id
        ShellBackground.sweepDirectory(yield* instanceDirectory)
        const job = yield* jobs.get(id)
        // Lazunox: lápida de ESTA sesión (el motor se reinició y el script se perdió).
        if (!job) {
          const lapida = TrabajosDisco.tombstoneFor(id, ctx.sessionID)
          if (lapida) return yield* Effect.fail(new Error(TrabajosDisco.lostMessage(lapida)))
        }
        // Una celda solo la puede esperar o terminar la sesión que la lanzó (el mensaje es el mismo que si no existiera).
        if (!job || job.type !== CELL_JOB_TYPE || job.metadata?.["sessionID"] !== ctx.sessionID) {
          return yield* Effect.fail(
            new Error(`No existe la celda ${id} (¿ya terminó hace tiempo, no es de Code Mode o se reinició el motor?).`),
          )
        }

        if (params.terminate && job.status === "running") {
          LazunoxWake.markCellConsumed(id)
          yield* jobs.cancel(id)
          return {
            title: CODE_MODE_WAIT_TOOL,
            metadata: { toolCalls: [], cellId: id },
            output: "Script terminado. Lo que ya había hecho no se deshizo.",
          } satisfies Tool.ExecuteResult<Metadata>
        }

        const abort = Effect.callback<void>((resume) => {
          if (ctx.abort.aborted) return resume(Effect.void)
          const handler = () => resume(Effect.void)
          ctx.abort.addEventListener("abort", handler, { once: true })
          return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
        })
        const waited = yield* Effect.raceFirst(
          jobs.wait({ id, timeout: clampYield(params.yield_ms, MAX_YIELD_WAIT_MS) }),
          abort.pipe(Effect.map(() => "aborted" as const)),
        )
        // Interrumpir la espera NO mata el script: sigue vivo y se puede volver a esperar.
        if (waited === "aborted") {
          return {
            title: CODE_MODE_WAIT_TOOL,
            metadata: { toolCalls: [], cellId: id },
            output: `Espera interrumpida; el script ${id} sigue en curso.`,
          } satisfies Tool.ExecuteResult<Metadata>
        }

        const settled = settledResult(waited, id)
        if (settled.kind !== "running") LazunoxWake.markCellConsumed(id)
        if (settled.kind === "failed") return yield* Effect.fail(new Error(settled.message))
        return {
          title: CODE_MODE_WAIT_TOOL,
          metadata: { toolCalls: [], ...(settled.kind === "running" ? { cellId: id } : {}) },
          output: settled.text,
        } satisfies Tool.ExecuteResult<Metadata>
      }, Effect.orDie),
    }
    return init
  }),
)
