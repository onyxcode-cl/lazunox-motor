// Ola 7, paquete 7.21: imágenes, audio y blobs de MCP a archivo y con tope. Con LAZUNOX_MCP_BINARIOS=0 se documenta el comportamiento de antes.
import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { McpInvocar } from "../../src/mcp/invocar"
import { TRUNCATION_DIR } from "../../src/tool/truncation-dir"
import { coincideTipo } from "../../src/mcp/binarios"

afterEach(() => {
  delete process.env.LAZUNOX_MCP_BINARIOS
  delete process.env.LAZUNOX_MCP_IMAGEN_MAX_BYTES
})

// PNG mínimo válido en cabecera + relleno
const png = (n: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(Math.max(0, n - 8), 7)])
const b64 = (b: Buffer) => b.toString("base64")

function montar(content: any[], extra: Partial<McpInvocar.RunInput> = {}) {
  const entry = {
    def: { name: "shot", description: "d", inputSchema: { type: "object", properties: {} } },
    client: { callTool: async () => ({ content }) },
    timeout: 1000,
  } as any
  const input: McpInvocar.RunInput = {
    key: "x_shot",
    entry,
    args: {},
    opts: { toolCallId: "call-1", abortSignal: new AbortController().signal, messages: [] },
    ctx: { sessionID: "ses_1" as any, ask: () => Effect.void },
    messageID: "msg_1",
    plugin: { trigger: ((_n: string, _i: any, o: any) => Effect.succeed(o)) as any },
    truncate: { output: (text: string) => Effect.succeed({ content: text, truncated: false }) } as any,
    agent: { name: "build", mode: "primary", options: {}, permission: [] } as any,
    processor: { completeToolCall: () => Effect.void },
    ...extra,
  }
  return input
}
const correr = (content: any[], extra: Partial<McpInvocar.RunInput> = {}) => Effect.runPromise(McpInvocar.run(montar(content, extra)))
const rutaEn = (texto: string) => texto.match(new RegExp(`${TRUNCATION_DIR.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}[^ )\\]]+`))?.[0]

describe("7.21 imagen", () => {
  test("pequeña: se guarda, se adjunta y el texto da ruta, tipo y tamaño", async () => {
    const out = await correr([{ type: "image", mimeType: "image/png", data: b64(png(2000)) }])
    const ruta = rutaEn(out.output)!
    expect(ruta).toBeDefined()
    expect(path.basename(ruta)).toMatch(/^tool_[A-Za-z0-9]+\.png$/)
    expect((await fs.readFile(ruta)).length).toBe(2000)
    expect(out.output).toContain("image/png")
    expect(out.attachments.length).toBe(1)
  })
  test("grande (sobre el tope): NO entra al contexto, queda en archivo con aviso", async () => {
    const grande = png(300 * 1024)
    const out = await correr([{ type: "image", mimeType: "image/png", data: b64(grande) }])
    expect(out.attachments.length).toBe(0)
    const ruta = rutaEn(out.output)!
    expect((await fs.readFile(ruta)).length).toBe(grande.length)
    expect(out.output).toContain("tope")
    expect(out.output).not.toContain(b64(grande).slice(0, 200))
  })
  test("el tope se configura con LAZUNOX_MCP_IMAGEN_MAX_BYTES", async () => {
    process.env.LAZUNOX_MCP_IMAGEN_MAX_BYTES = "1000"
    expect((await correr([{ type: "image", mimeType: "image/png", data: b64(png(2000)) }])).attachments.length).toBe(0)
    process.env.LAZUNOX_MCP_IMAGEN_MAX_BYTES = String(1024 * 1024)
    expect((await correr([{ type: "image", mimeType: "image/png", data: b64(png(300 * 1024)) }])).attachments.length).toBe(1)
  })
  test("modelo sin visión: se guarda y no se adjunta", async () => {
    const out = await correr([{ type: "image", mimeType: "image/png", data: b64(png(2000)) }], { admiteImagen: false })
    expect(out.attachments.length).toBe(0)
    expect(out.output).toContain("no admite imágenes")
    expect(rutaEn(out.output)).toBeDefined()
  })
  test("el tipo se comprueba: bytes que no son PNG se guardan como .bin y no se adjuntan", async () => {
    const out = await correr([{ type: "image", mimeType: "image/png", data: b64(Buffer.from("<script>alert(1)</script>")) }])
    expect(out.attachments.length).toBe(0)
    expect(rutaEn(out.output)!.endsWith(".bin")).toBe(true)
    expect(out.output).toContain("NO coincide")
  })
  test("el nombre lo genera el motor: un mimeType con ../ no escapa de la carpeta", async () => {
    const out = await correr([{ type: "image", mimeType: "../../../etc/passwd", data: b64(png(100)) }])
    const ruta = rutaEn(out.output)!
    expect(path.dirname(ruta)).toBe(TRUNCATION_DIR)
    expect(ruta.endsWith(".bin")).toBe(true)
  })
  test("interruptor apagado: entra en base64 sin tope (comportamiento de antes)", async () => {
    process.env.LAZUNOX_MCP_BINARIOS = "0"
    const out = await correr([{ type: "image", mimeType: "image/png", data: b64(png(300 * 1024)) }])
    expect(out.attachments.length).toBe(1)
    expect(rutaEn(out.output)).toBeUndefined()
  })
})

describe("7.21 audio y blobs", () => {
  test("audio: se guarda y se avisa (antes se descartaba en silencio)", async () => {
    const out = await correr([{ type: "audio", mimeType: "audio/wav", data: b64(Buffer.from("RIFFxxxxWAVE")) }])
    const ruta = rutaEn(out.output)!
    expect(ruta.endsWith(".wav")).toBe(true)
    expect(out.attachments.length).toBe(0)
    expect(out.output).toContain("audio/wav")
  })
  test("audio con el interruptor apagado: se descarta como antes", async () => {
    process.env.LAZUNOX_MCP_BINARIOS = "0"
    const out = await correr([{ type: "audio", mimeType: "audio/wav", data: b64(Buffer.from("RIFFxxxxWAVE")) }])
    expect(out.output).toBe("")
    expect(out.attachments.length).toBe(0)
  })
  test("blob de un tipo no adjuntable: antes se omitía con nota, ahora queda en archivo", async () => {
    const out = await correr([{ type: "resource", resource: { uri: "file:///x.zip", mimeType: "application/zip", blob: b64(Buffer.from("PK\x03\x04hola")) } }])
    expect(out.attachments.length).toBe(0)
    expect(rutaEn(out.output)!.endsWith(".zip")).toBe(true)
  })
  test("blob PDF: se guarda y se sigue adjuntando", async () => {
    const out = await correr([{ type: "resource", resource: { uri: "file:///x.pdf", mimeType: "application/pdf", blob: b64(Buffer.from("%PDF-1.4 hola")) } }])
    expect(out.attachments.length).toBe(1)
    expect(rutaEn(out.output)!.endsWith(".pdf")).toBe(true)
  })
  test("el texto y el resto de partes siguen igual", async () => {
    const out = await correr([{ type: "text", text: "hola" }, { type: "image", mimeType: "image/png", data: b64(png(100)) }])
    expect(out.output.startsWith("hola")).toBe(true)
  })
})

describe("7.21 comprobación de tipo", () => {
  test("firmas", () => {
    expect(coincideTipo("image/png", png(20))).toBe(true)
    expect(coincideTipo("image/jpeg", png(20))).toBe(false)
    expect(coincideTipo("audio/wav", png(20))).toBeUndefined()
  })
})
