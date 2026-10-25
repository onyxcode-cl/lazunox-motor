// Servidor MCP de prueba para los formularios (elicitation/create). Lo usan las pruebas de la fase B2.
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ElicitResultSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const server = new Server({ name: "mcp-elicitation-stdio", version: "1.0.0" }, { capabilities: { tools: {} } })

const FORM = {
  type: "object",
  properties: { nombre: { type: "string", title: "Nombre" }, edad: { type: "integer", minimum: 0 } },
  required: ["nombre"],
}

const objeto = (properties: Record<string, unknown> = {}) => ({ type: "object", properties })
let tardio: unknown = "pendiente"

server.setRequestHandler(ListToolsRequestSchema, () =>
  Promise.resolve({
    tools: [
      { name: "form", description: "Pide un formulario", inputSchema: objeto({ schema: {}, message: {}, abortAfterMs: {} }) },
      { name: "caps", description: "Capacidades del cliente", inputSchema: objeto() },
      { name: "late", description: "Pide un formulario DESPUÉS de terminar la llamada", inputSchema: objeto() },
      { name: "late_result", description: "Resultado del formulario tardío", inputSchema: objeto() },
      { name: "sleep", description: "Espera", inputSchema: objeto({ ms: {} }) },
      { name: "urlform", description: "Pide un formulario en modo url", inputSchema: objeto() },
    ],
  }),
)

const texto = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] })

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = (request.params.arguments ?? {}) as Record<string, any>
  switch (request.params.name) {
    case "caps":
      return texto(server.getClientCapabilities() ?? {})
    case "sleep":
      await new Promise((r) => setTimeout(r, Number(args.ms ?? 100)))
      return texto("dormido")
    case "late": {
      setTimeout(() => {
        server
          .elicitInput({ message: "tardío", requestedSchema: FORM as any })
          .then((r) => (tardio = r))
          .catch((e) => (tardio = { error: String(e?.message ?? e) }))
      }, 150)
      return texto("ok")
    }
    case "late_result":
      return texto(tardio)
    case "urlform": {
      try {
        const r = await server.request(
          { method: "elicitation/create", params: { mode: "url", message: "m", elicitationId: "e1", url: "https://example.com" } },
          ElicitResultSchema,
        )
        return texto({ resultado: r })
      } catch (e: any) {
        return texto({ error: String(e?.message ?? e) })
      }
    }
    case "form": {
      const controller = new AbortController()
      if (args.abortAfterMs) setTimeout(() => controller.abort(), Number(args.abortAfterMs))
      try {
        const r = await server.elicitInput(
          { message: args.message ?? "¿Quién eres?", requestedSchema: (args.schema ?? FORM) as any },
          { signal: controller.signal },
        )
        return texto({ action: r.action, content: r.content })
      } catch (e: any) {
        return texto({ error: String(e?.message ?? e) })
      }
    }
  }
  throw new Error("tool desconocida")
})

await server.connect(new StdioServerTransport())
