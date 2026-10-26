// Lazunox (4D, P36): peso aproximado del contexto fijo de una sesión (lo que viaja en CADA petición).
// Solo lectura: cifras (tokens ≈ caracteres / 4), nunca contenido. Ruta: `GET /experimental/session/{id}/contexto-fijo`.
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Session } from "./session"
import { Instruction } from "./instruction"
import { SystemPrompt } from "./system"
import type { SessionID } from "./schema"

export interface ContextoFijo {
  tokens: number
  aproximado: true
  partes: { agentes: number; skills: number; mcp: number; instrucciones: number }
  /** Reglas por ruta definidas en el proyecto; se cargan solo al leer o editar un archivo que coincide y NO suman al total. */
  reglasPorRuta: number
}

/** Aproximación estable: caracteres / 4, redondeado hacia arriba. */
export const tokensDe = (texto: string | undefined) => (texto ? Math.ceil(texto.length / 4) : 0)

export interface Interface {
  readonly calcular: (sessionID: SessionID) => Effect.Effect<ContextoFijo, Session.NotFound>
}

export class Service extends Context.Service<Service, Interface>()("@lazunox/SessionContextoFijo") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const mcp = yield* MCP.Service
    const instruction = yield* Instruction.Service
    const sys = yield* SystemPrompt.Service

    const calcular: Interface["calcular"] = Effect.fn("SessionContextoFijo.calcular")(function* (sessionID) {
      const session = yield* sessions.get(sessionID)
      const mensajes = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
      const ultimo = mensajes.findLast((m) => m.info.role === "user")
      const nombre = ultimo && ultimo.info.role === "user" ? ultimo.info.agent : undefined
      const defecto = yield* agents.defaultInfo().pipe(Effect.orDie)
      const agente = nombre ? yield* agents.get(nombre).pipe(Effect.orElseSucceed(() => defecto)) : defecto

      // Agentes: el prompt del agente actual y la lista de ayudantes disponibles (nombre y descripción).
      const todos = yield* agents.list().pipe(Effect.orDie)
      const ayudantes = todos
        .filter((a) => a.mode !== "primary" && !a.hidden)
        .map((a) => `${a.name}: ${a.description ?? ""}`)
        .join("\n")
      const agentes = tokensDe(agente.prompt) + tokensDe(ayudantes)

      const skills = tokensDe(yield* sys.skills(agente))

      // MCP: instrucciones de los servidores y definiciones (nombre, descripción y esquema) de las herramientas visibles.
      const ruleset = Permission.merge(agente.permission, session.permission ?? [])
      const defs = yield* mcp.tools().pipe(Effect.orElseSucceed(() => ({})))
      const claves = Object.keys(defs)
      const ocultas = Permission.disabled(claves, ruleset)
      let defsChars = 0
      for (const clave of claves) {
        if (ocultas.has(clave)) continue
        const def = (defs as Record<string, MCP.McpTool>)[clave]!.def
        defsChars += clave.length + (def.description?.length ?? 0) + JSON.stringify(def.inputSchema ?? {}).length
      }
      const mcpTokens = tokensDe(yield* sys.mcp(agente, session.permission)) + Math.ceil(defsChars / 4)

      const texto = yield* instruction.system().pipe(Effect.orElseSucceed(() => [] as string[]))
      const instrucciones = tokensDe(texto.join("\n\n"))

      const reglasPorRuta = yield* instruction.contarReglas()
      return {
        tokens: agentes + skills + mcpTokens + instrucciones,
        aproximado: true as const,
        partes: { agentes, skills, mcp: mcpTokens, instrucciones },
        reglasPorRuta,
      }
    })

    return Service.of({ calcular })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Session.node, Agent.node, MCP.node, Instruction.node, SystemPrompt.node],
})

export * as SessionContextoFijo from "./contexto-fijo"
