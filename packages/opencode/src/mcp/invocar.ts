// Lazunox: ÚNICO camino de ejecución de una herramienta MCP.
//
// Lo usan la llamada directa (`session/tools.ts`) y `mcp_call` (búsqueda diferida, `tool/tool-search.ts`).
// Así los ganchos (`tool.execute.before/after`), el permiso (`ctx.ask({ permission: key })`), la puerta del plan de la
// app y la inyección de `lazunox_session` ven siempre la clave REAL (`servidor_herramienta`) y el MISMO objeto `args`
// que llega a `callTool`. Nada de `mcp_call` puede saltarse permisos porque no existe otra forma de ejecutar.
import type { ToolExecutionOptions } from "ai"
import { Effect } from "effect"
import type { Agent } from "@/agent/agent"
import type { Plugin } from "@/plugin"
import type { Tool } from "@/tool/tool"
import { opcionesMcp, type Truncate } from "@/tool/truncate"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { PartID } from "@/session/schema"
import { McpCatalog } from "./catalog"
import * as EnCurso from "./en-curso"
import { conGanchoDeFallo } from "@/session/ganchos-fallo"
import type { MCP } from "."
import * as Binarios from "./binarios"

export const MAX_MCP_RESOURCE_BLOB_BYTES = 10 * 1024 * 1024
export const SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])

const tipoAdjuntable = (mime: string) => SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)

export function base64Size(value: string) {
  const trimmed = value.replace(/\s/g, "")
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding)
}

export function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${Math.ceil(value / (1024 * 1024))} MB`
}

// La llamada viva y su gancho viven en `en-curso.ts` (registro por cliente para los formularios MCP).
export type LiveCall = EnCurso.LiveCall
export type OnCall = EnCurso.OnCall

export interface RunInput {
  /** Clave real `servidor_herramienta` (la que ven permisos, ganchos y la app). */
  readonly key: string
  readonly entry: MCP.McpTool
  readonly args: Record<string, unknown>
  readonly opts: ToolExecutionOptions
  readonly ctx: Pick<Tool.Context, "sessionID" | "ask">
  readonly messageID: string
  readonly plugin: Pick<Plugin.Interface, "trigger">
  readonly truncate: Pick<Truncate.Interface, "output">
  readonly agent: Agent.Info
  readonly processor: { completeToolCall: (callID: string, output: any) => Effect.Effect<unknown> }
  /** Gancho de «llamada viva». Por defecto registra la llamada en `en-curso.ts` (atribución de formularios MCP). */
  readonly onCall?: OnCall
  /** Título y metadatos extra del resultado (lo usa `mcp_call`; la llamada directa no los pone). */
  readonly title?: string
  readonly extraMetadata?: Record<string, unknown>
  /** Lazunox (7.21): ¿el modelo acepta imágenes? Sin dato (undefined) se asume que sí; las imágenes grandes igual van a archivo. */
  readonly admiteImagen?: boolean
}

type Contenido = Awaited<ReturnType<NonNullable<ReturnType<typeof McpCatalog.convertTool>["execute"]>>>["content"]

/** Texto que el modelo ve de un resultado MCP: partes de texto y recursos con texto, unidos como en `run`. */
export function textoDeContenido(content: Contenido): string {
  const partes: string[] = []
  for (const c of content as any[]) {
    if (c.type === "text") partes.push(c.text)
    else if (c.type === "resource" && c.resource?.text) partes.push(c.resource.text)
  }
  return partes.join("\n\n")
}

/** Sustituye todo el texto por `nuevo` conservando lo no textual (imágenes, blobs). El texto nuevo ocupa el lugar de la primera parte de texto. */
export function reemplazarTexto(content: Contenido, nuevo: string): Contenido {
  const out: any[] = []
  let puesto = false
  const poner = () => {
    if (puesto) return
    puesto = true
    out.push({ type: "text", text: nuevo })
  }
  for (const c of content as any[]) {
    if (c.type === "text") poner()
    else if (c.type === "resource" && c.resource?.text) {
      poner()
      if (c.resource.blob) {
        const { text: _t, ...resto } = c.resource
        out.push({ ...c, resource: resto })
      }
    } else out.push(c)
  }
  poner()
  return out as Contenido
}

export const run = Effect.fn("McpInvocar.run")(function* (input: RunInput) {
  const { key, entry, args, opts, ctx } = input
  const item = McpCatalog.convertTool(entry.def, entry.client, entry.timeout)
  const execute = item.execute
  if (!execute) return yield* Effect.die(new Error(`MCP tool ${key} is not executable`))
  const call: Omit<LiveCall, "pausar"> = {
    key,
    sessionID: ctx.sessionID,
    messageID: input.messageID,
    callID: opts.toolCallId,
    abort: opts.abortSignal,
    client: entry.client,
  }

  // El gancho recibe el MISMO objeto `args` que va a `callTool` (los plugins lo mutan en sitio).
  yield* input.plugin.trigger("tool.execute.before", { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId }, { args })
  const result: Awaited<ReturnType<NonNullable<typeof execute>>> = yield* Effect.gen(function* () {
    yield* ctx.ask({ permission: key, metadata: {}, patterns: ["*"], always: ["*"] })
    // Con formularios MCP activos, el tiempo de la llamada lo mide un temporizador que se pausa mientras haya un formulario
    // abierto (ver `en-curso.ts`); sin la variable `t` es transparente y se ejecuta exactamente lo de antes.
    return yield* EnCurso.conLlamadaViva({
      call,
      timeoutMs: entry.timeout,
      onCall: input.onCall,
      use: (t) =>
        Effect.promise(() => {
          if (!t.activo) return execute(args, opts)
          const vivo = McpCatalog.convertTool(entry.def, entry.client, t.timeout, t.onprogress)
          return vivo.execute!(args, { ...opts, abortSignal: t.signal })
        }),
    })
  }).pipe(
    conGanchoDeFallo(input.plugin, { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId, args }),
    Effect.withSpan("Tool.execute", {
      attributes: {
        "tool.name": key,
        "tool.call_id": opts.toolCallId,
        "session.id": ctx.sessionID,
        "message.id": input.messageID,
      },
    }),
  )
  // Lazunox (6.8): el gancho ve el texto del resultado como `output` (como en las herramientas nativas) y, si lo reemplaza o le añade algo,
  // solo cambia el TEXTO: imágenes, PDF y `metadata` quedan como estaban.
  const textoAntes = textoDeContenido(result.content)
  const vista = result as typeof result & { output?: string }
  vista.output = textoAntes
  yield* input.plugin.trigger(
    "tool.execute.after",
    { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
    vista,
  )
  const textoNuevo = vista.output
  delete vista.output
  if (typeof textoNuevo === "string" && textoNuevo !== textoAntes) result.content = reemplazarTexto(result.content, textoNuevo)

  const textParts: string[] = []
  const attachments: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[] = []
  const binarios = Binarios.binariosActivos()
  const topeImagen = Binarios.topeImagen()
  const admiteImagen = input.admiteImagen !== false
  const guardados: Array<Record<string, unknown>> = []
  // Lazunox (7.21): imagen/audio/blob → archivo del motor; el modelo recibe ruta, tipo y tamaño. La imagen solo se adjunta si el
  // modelo la admite y pesa menos que el tope.
  const guardarBinario = Effect.fn("McpInvocar.guardarBinario")(function* (
    data: string,
    mimeDeclarado: string | undefined,
    etiqueta: string,
    adjuntar: (g: Binarios.Guardado) => boolean,
    filename?: string,
  ) {
    const g = yield* Effect.promise(() => Binarios.guardar(data, mimeDeclarado))
    if (!g.ok) {
      textParts.push(`[Resultado binario MCP omitido: ${etiqueta} (${mimeDeclarado ?? "tipo desconocido"}, ${formatBytes(g.bytes)}): ${g.motivo}]`)
      return
    }
    guardados.push({ path: g.ruta, mime: g.mime, bytes: g.bytes })
    const aviso = g.tipoVerificado ? "" : " Aviso: el contenido NO coincide con el tipo declarado; se guardó como .bin."
    if (g.tipoVerificado && adjuntar(g)) {
      textParts.push(`[${etiqueta} MCP guardado en ${g.ruta} (${g.mime}, ${formatBytes(g.bytes)}) y adjuntado a la conversación.]`)
      attachments.push({ type: "file", mime: g.mime, url: `data:${g.mime};base64,${data.replace(/\s/g, "")}`, ...(filename ? { filename } : {}) })
      return
    }
    const razon = !g.tipoVerificado
      ? ""
      : g.mime.startsWith("image/")
        ? !admiteImagen
          ? " No se adjuntó: el modelo no admite imágenes."
          : ` No se adjuntó al contexto: pesa más que el tope (${formatBytes(topeImagen)}).`
        : g.mime.startsWith("audio/")
          ? " El audio no se puede adjuntar al contexto."
          : " No es un tipo que se adjunte al contexto."
    textParts.push(`[${etiqueta} MCP guardado en ${g.ruta} (${g.mime}, ${formatBytes(g.bytes)}).${razon}${aviso} Ábrelo por esa ruta si lo necesitas.]`)
  })
  const imagenAdjuntable = (g: Binarios.Guardado) => admiteImagen && g.bytes <= topeImagen
  for (const contentItem of result.content as any[]) {
    if (contentItem.type === "text") textParts.push(contentItem.text)
    else if (contentItem.type === "image") {
      if (binarios) yield* guardarBinario(contentItem.data, contentItem.mimeType, "Imagen", imagenAdjuntable)
      else
        attachments.push({
          type: "file",
          mime: contentItem.mimeType,
          url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
        })
    } else if (contentItem.type === "audio") {
      if (binarios) yield* guardarBinario(contentItem.data, contentItem.mimeType, "Audio", () => false)
    } else if (contentItem.type === "resource") {
      const { resource } = contentItem
      if (resource.text) textParts.push(resource.text)
      if (resource.blob) {
        const mime = resource.mimeType ?? "application/octet-stream"
        const size = base64Size(resource.blob)
        if (binarios) {
          // Se adjunta lo que ya se adjuntaba (tipos admitidos y bajo el máximo); las imágenes además con el tope y el modelo.
          yield* guardarBinario(
            resource.blob,
            mime,
            `Recurso ${resource.uri}`,
            (g) =>
              tipoAdjuntable(g.mime) && (g.mime.startsWith("image/") ? imagenAdjuntable(g) : g.bytes <= MAX_MCP_RESOURCE_BLOB_BYTES),
            resource.uri,
          )
          continue
        }
        if (!SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
          textParts.push(
            `[Binary MCP resource omitted: ${resource.uri} (${mime}, ${formatBytes(size)}) is not a supported attachment type]`,
          )
          continue
        }
        if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
          textParts.push(
            `[Binary MCP resource omitted: ${resource.uri} (${mime}, ${formatBytes(size)}) exceeds ${formatBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
          )
          continue
        }
        attachments.push({
          type: "file",
          mime,
          url: `data:${mime};base64,${resource.blob}`,
          filename: resource.uri,
        })
      }
    }
  }

  // Lazunox (P04): tope de 25k tokens por resultado MCP; el resto queda en un archivo de `Truncate.DIR` y el aviso da la ruta.
  const truncated = yield* input.truncate.output(textParts.join("\n\n"), opcionesMcp(), input.agent)
  const metadata = {
    ...result.metadata,
    truncated: truncated.truncated,
    ...(truncated.truncated && { outputPath: truncated.outputPath }),
    ...(guardados.length > 0 && { lazunoxBinarios: guardados }),
    ...input.extraMetadata,
  }

  const output = {
    title: input.title ?? "",
    metadata,
    output: truncated.content,
    attachments: attachments.map((attachment) => ({
      ...attachment,
      id: PartID.ascending(),
      sessionID: ctx.sessionID,
      messageID: input.messageID,
    })),
    content: result.content,
  }
  if (opts.abortSignal?.aborted && opts.toolCallId) {
    yield* input.processor.completeToolCall(opts.toolCallId, output)
  }
  return output
})

export * as McpInvocar from "./invocar"
