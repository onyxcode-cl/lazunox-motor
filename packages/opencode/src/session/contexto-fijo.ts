// Lazunox (4D, P36): peso aproximado del contexto fijo de una sesión (lo que viaja en CADA petición).
// Solo lectura: cifras (tokens ≈ caracteres / 4), nunca contenido. Ruta: `GET /experimental/session/{id}/contexto-fijo`.
//
// Desglose (feat/contexto-desglose): además de `partes` (sin cambios, para clientes viejos) se devuelven `desglose`,
// `listas` y `ventana`. Desde este cambio `tokens` es la suma de `desglose`, que ahora incluye el prompt de sistema
// (prompt del agente o del proveedor + entorno) y las herramientas integradas: antes solo sumaba `partes`.
// Nada se ejecuta: las herramientas se resuelven igual que en `session/tools.ts` (registro + permisos) solo para medirlas.
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Context, Effect, Layer, Option } from "effect"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { Skill } from "@/skill"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Session } from "./session"
import { Instruction } from "./instruction"
import { SystemPrompt } from "./system"
import { ContextoMinimo } from "./contexto-minimo"
import { ventana as ventanaDe } from "./overflow"
import type { SessionID } from "./schema"

export interface Desglose {
  /** Prompt del agente (o el base del proveedor) + `system` del último mensaje + entorno. */
  sistema: number
  /** Herramientas integradas visibles (nombre, descripción y esquema), sin la lista de ayudantes de `task`. */
  herramientas: number
  mcpInstrucciones: number
  mcpHerramientas: number
  skills: number
  /** Instrucciones tipo AGENTS.md / CLAUDE.md / `instructions` de la configuración. */
  memoria: number
  /** Lista de ayudantes que viaja en la descripción de la herramienta `task`. */
  agentes: number
}

export interface ContextoFijo {
  /** Suma de `desglose`. */
  tokens: number
  aproximado: true
  /** Compatibilidad: mismo cálculo de siempre (no suma sistema ni herramientas; `agentes` incluye el prompt del agente). */
  partes: { agentes: number; skills: number; mcp: number; instrucciones: number }
  /** Reglas por ruta definidas en el proyecto; se cargan solo al leer o editar un archivo que coincide y NO suman al total. */
  reglasPorRuta: number
  desglose: Desglose
  listas: {
    mcp: { nombre: string; servidor: string; tokens: number }[]
    memoria: { ruta: string; tokens: number }[]
    skills: { nombre: string; tokens: number }[]
  }
  /** Ventana del modelo de la sesión; todo 0 si no hay modelo resoluble. */
  ventana: { contexto: number; usable: number; reservado: number }
}

/** Aproximación estable: caracteres / 4, redondeado hacia arriba. */
export const tokensDe = (texto: string | undefined) => (texto ? Math.ceil(texto.length / 4) : 0)

/** Tope de elementos por lista (ordenadas por tokens, de mayor a menor). */
export const LISTA_MAX = 300
/** Cabecera con la que `ToolRegistry` agrega la lista de ayudantes a la descripción de `task`. */
const MARCA_AYUDANTES = "Available agent types and the tools they have access to:"

const recortar = <T extends { tokens: number }>(lista: T[]) =>
  lista.toSorted((a, b) => b.tokens - a.tokens).slice(0, LISTA_MAX)

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
    const provider = yield* Provider.Service
    const registry = yield* ToolRegistry.Service
    const skill = yield* Skill.Service
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service

    const buscarModelo = (providerID: string, modelID: string) =>
      provider.getModel(ProviderV2.ID.make(providerID), ModelV2.ID.make(modelID)).pipe(
        Effect.map((m) => m as Provider.Model | undefined),
        Effect.orElseSucceed(() => undefined),
      )

    // Modelo del último mensaje de usuario/asistente; si no hay o ya no existe, el por defecto; si tampoco, ninguno.
    const modeloDe = Effect.fnUntraced(function* (mensajes: ReadonlyArray<SessionV1.WithParts>) {
      const ultimo = mensajes.findLast((m) => m.info.role === "user" || m.info.role === "assistant")?.info
      const ref =
        ultimo?.role === "user"
          ? ultimo.model
          : ultimo?.role === "assistant"
            ? { providerID: ultimo.providerID, modelID: ultimo.modelID }
            : undefined
      if (ref?.providerID && ref.modelID) {
        const m = yield* buscarModelo(ref.providerID, ref.modelID)
        if (m) return m
      }
      const defecto = yield* provider.defaultModel().pipe(Effect.option)
      if (Option.isNone(defecto)) return undefined
      return yield* buscarModelo(defecto.value.providerID, defecto.value.modelID)
    })

    const calcular: Interface["calcular"] = Effect.fn("SessionContextoFijo.calcular")(function* (sessionID) {
      const session = yield* sessions.get(sessionID)
      const mensajes = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
      const ultimo = mensajes.findLast((m) => m.info.role === "user")
      const usuario = ultimo && ultimo.info.role === "user" ? ultimo.info : undefined
      const nombre = usuario?.agent
      const defecto = yield* agents.defaultInfo().pipe(Effect.orDie)
      const agente = nombre ? yield* agents.get(nombre).pipe(Effect.orElseSucceed(() => defecto)) : defecto
      const modelo = yield* modeloDe(mensajes)

      // Agentes (compatibilidad): el prompt del agente actual y la lista de ayudantes disponibles (nombre y descripción).
      const todos = yield* agents.list().pipe(Effect.orDie)
      const ayudantes = todos
        .filter((a) => a.mode !== "primary" && !a.hidden)
        .map((a) => `${a.name}: ${a.description ?? ""}`)
        .join("\n")
      const agentes = tokensDe(agente.prompt) + tokensDe(ayudantes)

      // Lazunox (6.3): igual que en la petición real, un ayudante en contexto mínimo no suma skills, AGENTS.md ni MCP sin herramientas.
      const minimo =
        ContextoMinimo.decidir({
          agent: agente,
          esHija: session.parentID !== undefined,
          permissionSesion: session.permission,
        }) === "minimo"
      const skills = minimo ? 0 : tokensDe(yield* sys.skills(agente))

      // MCP: instrucciones de los servidores y definiciones (nombre, descripción y esquema) de las herramientas visibles.
      const ruleset = Permission.merge(agente.permission, session.permission ?? [])
      const defs: Record<string, MCP.McpTool> = yield* mcp.tools().pipe(Effect.orElseSucceed(() => ({})))
      const clientes: Record<string, unknown> = yield* mcp.clients().pipe(Effect.orElseSucceed(() => ({})))
      const servidorDe = (clave: string, client: unknown) =>
        Object.entries(clientes).find(([, c]) => c !== undefined && c === client)?.[0] ?? clave.split("_")[0] ?? clave
      const claves = Object.keys(defs)
      const ocultas = Permission.disabled(claves, ruleset)
      let defsChars = 0
      const listaMcp: ContextoFijo["listas"]["mcp"] = []
      for (const clave of claves) {
        if (ocultas.has(clave)) continue
        const fuente = defs[clave]!
        const chars =
          clave.length + (fuente.def.description?.length ?? 0) + JSON.stringify(fuente.def.inputSchema ?? {}).length
        defsChars += chars
        listaMcp.push({ nombre: clave, servidor: servidorDe(clave, fuente.client), tokens: Math.ceil(chars / 4) })
      }
      const mcpInstrucciones = tokensDe(
        yield* minimo ? sys.mcp(agente, session.permission, true) : sys.mcp(agente, session.permission),
      )
      const mcpHerramientas = Math.ceil(defsChars / 4)

      // Memoria (AGENTS.md, CLAUDE.md, `instructions`): mismos bloques que `Instruction.system()`, con su ruta.
      const bloques = minimo
        ? []
        : yield* instruction.systemConRutas().pipe(Effect.orElseSucceed(() => [] as { ruta: string; texto: string }[]))
      const instrucciones = tokensDe(bloques.map((b) => b.texto).join("\n\n"))

      const reglasPorRuta = yield* instruction.contarReglas()

      // Sistema: lo que arma `llm/request.ts` (prompt del agente o el del proveedor, `system` del último mensaje) + el entorno.
      const promptAgente = minimo && !agente.prompt ? ContextoMinimo.promptCorto : agente.prompt
      const base = promptAgente ? [promptAgente] : modelo ? SystemPrompt.provider(modelo) : []
      const entorno = modelo ? yield* sys.environment(modelo) : []
      const sistema = tokensDe(
        [...base, ...(usuario?.system ? [usuario.system] : []), ...entorno].filter(Boolean).join("\n"),
      )

      // Herramientas integradas: las que resuelve el registro para este modelo y agente, menos las que niegan los permisos
      // o el último mensaje (igual que `resolveTools` en llm/request.ts). La lista de ayudantes de `task` va a `agentes`.
      const integradas = yield* registry.tools({
        providerID: ProviderV2.ID.make(modelo?.providerID ?? ""),
        modelID: ModelV2.ID.make(modelo?.api.id ?? ""),
        agent: agente,
        permission: session.permission,
      })
      const negadas = Permission.disabled(
        integradas.map((t) => t.id),
        ruleset,
      )
      let herramientasChars = 0
      let ayudantesChars = 0
      for (const item of integradas) {
        if (negadas.has(item.id) || usuario?.tools?.[item.id] === false) continue
        let esquema: unknown
        try {
          const crudo = ToolJsonSchema.fromTool(item)
          esquema = modelo ? ProviderTransform.schema(modelo, crudo) : crudo
        } catch {
          esquema = {}
        }
        let descripcion = item.description ?? ""
        const corte = item.id === "task" ? descripcion.indexOf(MARCA_AYUDANTES) : -1
        if (corte >= 0) {
          ayudantesChars += descripcion.length - corte
          descripcion = descripcion.slice(0, corte)
        }
        herramientasChars += item.id.length + descripcion.length + (JSON.stringify(esquema ?? {})?.length ?? 0)
      }

      // Skills: una entrada por skill que ve el modelo (mismo filtro que `SystemPrompt.skills`).
      const conSkills = !minimo && !Permission.disabled(["skill"], agente.permission).has("skill")
      const disponibles = conSkills ? yield* skill.available(agente, { paraModelo: true }) : []
      const listaSkills = disponibles
        .filter((s) => s.description !== undefined)
        .map((s) => ({
          nombre: s.name,
          tokens: tokensDe(
            `<skill><name>${s.name}</name><description>${(s.description ?? "").slice(0, 300)}</description><location>${s.location}</location></skill>`,
          ),
        }))

      const desglose: Desglose = {
        sistema,
        herramientas: Math.ceil(herramientasChars / 4),
        mcpInstrucciones,
        mcpHerramientas,
        skills,
        memoria: instrucciones,
        agentes: Math.ceil(ayudantesChars / 4),
      }
      const cfg = yield* config.get()
      const ventana = modelo
        ? ventanaDe({ cfg, model: modelo, outputTokenMax: flags.outputTokenMax })
        : { contexto: 0, usable: 0, reservado: 0 }

      return {
        tokens: Object.values(desglose).reduce((a, b) => a + b, 0),
        aproximado: true as const,
        partes: { agentes, skills, mcp: mcpInstrucciones + mcpHerramientas, instrucciones },
        reglasPorRuta,
        desglose,
        listas: {
          mcp: recortar(listaMcp),
          memoria: recortar(bloques.map((b) => ({ ruta: b.ruta, tokens: tokensDe(b.texto) }))),
          skills: recortar(listaSkills),
        },
        ventana,
      }
    })

    return Service.of({ calcular })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Session.node,
    Agent.node,
    MCP.node,
    Instruction.node,
    SystemPrompt.node,
    Provider.node,
    ToolRegistry.node,
    Skill.node,
    Config.node,
    RuntimeFlags.node,
  ],
})

export * as SessionContextoFijo from "./contexto-fijo"
