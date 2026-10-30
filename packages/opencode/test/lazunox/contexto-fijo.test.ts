// Lazunox 4D (P36): `SessionContextoFijo.calcular` (la ruta `GET /experimental/session/{id}/contexto-fijo` la cubre httpapi-exercise).
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Exit, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { Config } from "@/config/config"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Provider } from "@/provider/provider"
import { Skill } from "@/skill"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Session } from "../../src/session/session"
import { SessionContextoFijo, tokensDe } from "../../src/session/contexto-fijo"
import { SystemPrompt } from "../../src/session/system"
import { SessionID } from "../../src/session/schema"
import { NotFoundError } from "../../src/storage/storage"
import { provideTmpdirInstance } from "../fixture/fixture"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([CrossSpawnSpawner.node, LayerNodePlatform.filesystem, InstanceStore.node]), [
    [
      InstanceBootstrap.node,
      Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
    ],
  ]),
)

const agente = { name: "build", mode: "primary", options: {}, permission: [{ permission: "*", pattern: "*", action: "allow" }], prompt: "P".repeat(400) }
const ayudante = { name: "explore", mode: "subagent", options: {}, permission: [], description: "D".repeat(100) }
const oculto = { name: "titulo", mode: "primary", hidden: true, options: {}, permission: [], description: "NO" }

// Desglose: modelo, herramientas integradas y skills simulados (nada se ejecuta).
const modelo = {
  id: "modelo-x",
  providerID: "prov",
  api: { id: "modelo-x", npm: "@ai-sdk/openai-compatible" },
  limit: { context: 100_000, output: 8_000 },
  capabilities: {},
}
const MARCA = "Available agent types and the tools they have access to:"
const integradas = [
  { id: "read", description: "R".repeat(40), jsonSchema: { type: "object" } },
  { id: "bash", description: "B".repeat(40), jsonSchema: { type: "object" } },
  { id: "task", description: "T".repeat(20) + "\n" + MARCA + "\n- explore: " + "D".repeat(100), jsonSchema: { type: "object" } },
]
const skillsDisponibles = [
  { name: "corta", description: "c", location: "/s/corta/SKILL.md", content: "" },
  { name: "larga", description: "l".repeat(200), location: "/s/larga/SKILL.md", content: "" },
]
const usuario = (extra: Record<string, unknown> = {}) => ({
  info: { role: "user", agent: "build", model: { providerID: "prov", modelID: "modelo-x" }, ...extra },
  parts: [],
})

const actual: { agente: any; mensajes: any[]; defecto: string; cfg: any } = {
  agente,
  mensajes: [],
  defecto: "modelo-x",
  cfg: {},
}

const capa = (dir: string, mcpDefs: Record<string, unknown> = {}, clientes: Record<string, unknown> = {}) =>
  AppNodeBuilder.build(SessionContextoFijo.node, [
    [Config.node, Layer.succeed(Config.Service, TestConfig.make({ get: () => Effect.succeed(actual.cfg) }))],
    [Global.node, Global.layerWith({ home: dir, config: dir })],
    [RuntimeFlags.node, RuntimeFlags.layer({})],
    [
      Session.node,
      Layer.succeed(
        Session.Service,
        Session.Service.of({
          get: (id: SessionID) =>
            id === SessionID.make("ses_noexiste")
              ? Effect.fail(new NotFoundError({ message: "nope" }))
              : Effect.succeed({ id, permission: [], ...(id === SessionID.make("ses_hija") ? { parentID: "ses_padre" } : {}) } as any),
          messages: () => Effect.succeed(actual.mensajes),
        } as any),
      ),
    ],
    [
      Agent.node,
      Layer.succeed(
        Agent.Service,
        Agent.Service.of({
          get: () => Effect.succeed(actual.agente as any),
          list: () => Effect.succeed([agente, ayudante, oculto] as any),
          defaultInfo: () => Effect.succeed(actual.agente as any),
        } as any),
      ),
    ],
    [
      MCP.node,
      Layer.succeed(
        MCP.Service,
        MCP.Service.of({
          tools: () => Effect.succeed(mcpDefs),
          clients: () => Effect.succeed(clientes),
          instructions: () => Effect.succeed([]),
        } as any),
      ),
    ],
    [
      Provider.node,
      Layer.succeed(
        Provider.Service,
        Provider.Service.of({
          getModel: (_p: string, m: string) =>
            m === "modelo-x" ? Effect.succeed(modelo as any) : Effect.fail(new Error("no existe") as any),
          defaultModel: () => Effect.succeed({ providerID: "prov", modelID: actual.defecto } as any),
        } as any),
      ),
    ],
    [
      ToolRegistry.node,
      Layer.succeed(ToolRegistry.Service, ToolRegistry.Service.of({ tools: () => Effect.succeed(integradas as any) } as any)),
    ],
    [
      Skill.node,
      Layer.succeed(Skill.Service, Skill.Service.of({ available: () => Effect.succeed(skillsDisponibles as any) } as any)),
    ],
    [
      SystemPrompt.node,
      Layer.succeed(
        SystemPrompt.Service,
        SystemPrompt.Service.of({
          skills: () => Effect.succeed("S".repeat(400)),
          mcp: () => Effect.succeed("M".repeat(80)),
          environment: () => Effect.succeed(["E".repeat(40)]),
        } as any),
      ),
    ],
  ])

describe("contexto fijo (4D)", () => {
  test_tokens()

  it.live("suma agentes, skills, MCP e instrucciones y cuenta las reglas por ruta sin sumarlas", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await fs.writeFile(path.join(dir, "AGENTS.md"), "I".repeat(1000))
          await fs.mkdir(path.join(dir, ".opencode/rules"), { recursive: true })
          await fs.writeFile(path.join(dir, ".opencode/rules/r.md"), "---\npaths: src/**\n---\n" + "R".repeat(5000))
        })
        const defs = { srv_a: { def: { description: "d".repeat(40), inputSchema: { type: "object" } } } }
        return yield* Effect.gen(function* () {
          const svc = yield* SessionContextoFijo.Service
          const r = yield* svc.calcular(SessionID.make("ses_x"))
          expect(r.aproximado).toBe(true)
          // agente (400/4) + ayudante visible "explore: " + 100 caracteres; el oculto y el primario no cuentan.
          expect(r.partes.agentes).toBe(100 + Math.ceil(("explore: ".length + 100) / 4))
          expect(r.partes.skills).toBe(100)
          expect(r.partes.mcp).toBe(20 + Math.ceil(("srv_a".length + 40 + JSON.stringify({ type: "object" }).length) / 4))
          // AGENTS.md (1000) + cabecera «Instructions from: <ruta>\n»; las reglas por ruta NO suman.
          expect(r.partes.instrucciones).toBeGreaterThanOrEqual(250)
          expect(r.partes.instrucciones).toBeLessThan(250 + 40)
          expect(r.reglasPorRuta).toBe(1)
          // Desde el desglose `tokens` es la suma de `desglose` (incluye sistema y herramientas), ya no la de `partes`.
          const d = r.desglose
          expect(r.tokens).toBe(d.sistema + d.herramientas + d.mcpInstrucciones + d.mcpHerramientas + d.skills + d.memoria + d.agentes)
          // `partes` no cambia y cuadra con el desglose en lo que comparten.
          expect(d.mcpInstrucciones + d.mcpHerramientas).toBe(r.partes.mcp)
          expect(d.skills).toBe(r.partes.skills)
          expect(d.memoria).toBe(r.partes.instrucciones)
          // Sin mensajes: modelo por defecto; sistema = prompt del agente + "\n" + entorno.
          expect(d.sistema).toBe(Math.ceil((400 + 1 + 40) / 4))
          // read, bash y task (sin la lista de ayudantes): id + descripción + esquema.
          const esquema = JSON.stringify({ type: "object" }).length
          expect(d.herramientas).toBe(Math.ceil((4 + 40 + esquema + 4 + 40 + esquema + 4 + 21 + esquema) / 4))
          expect(d.agentes).toBe(Math.ceil((MARCA + "\n- explore: " + "D".repeat(100)).length / 4))
          expect(r.listas.memoria).toHaveLength(1)
          expect(r.listas.memoria[0]!.ruta).toBe(path.join(dir, "AGENTS.md"))
          expect(r.listas.memoria[0]!.tokens).toBe(r.partes.instrucciones)
          expect(r.listas.mcp).toEqual([{ nombre: "srv_a", servidor: "srv", tokens: r.desglose.mcpHerramientas }])
          expect(r.listas.skills.map((x) => x.nombre)).toEqual(["larga", "corta"])
          expect(r.ventana).toEqual({ contexto: 100_000, usable: 92_000, reservado: 8_000 })
        }).pipe(Effect.provide(capa(dir, defs)))
      }),
    ),
  )

  it.live("Ola 6 (6.3): la hija en contexto mínimo (bandera encendida) no suma skills ni AGENTS.md", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(dir, "AGENTS.md"), "I".repeat(1000)))
        const previo = process.env.LAZUNOX_AYUDANTES_MINIMOS
        actual.agente = { ...agente, name: "lector", contexto: "minimo", permission: [{ permission: "*", pattern: "*", action: "deny" }] }
        try {
          return yield* Effect.gen(function* () {
            const svc = yield* SessionContextoFijo.Service
            delete process.env.LAZUNOX_AYUDANTES_MINIMOS
            const apagada = yield* svc.calcular(SessionID.make("ses_hija"))
            process.env.LAZUNOX_AYUDANTES_MINIMOS = "1"
            const hija = yield* svc.calcular(SessionID.make("ses_hija"))
            const raiz = yield* svc.calcular(SessionID.make("ses_x"))
            expect(apagada.partes.skills).toBe(100)
            expect(apagada.partes.instrucciones).toBeGreaterThanOrEqual(250)
            expect(hija.partes.skills).toBe(0)
            expect(hija.partes.instrucciones).toBe(0)
            expect(hija.tokens).toBeLessThan(apagada.tokens)
            // la sesión raíz no es hija: igual que antes
            expect(raiz.partes.skills).toBe(100)
          }).pipe(Effect.provide(capa(dir)))
        } finally {
          actual.agente = agente
          if (previo === undefined) delete process.env.LAZUNOX_AYUDANTES_MINIMOS
          else process.env.LAZUNOX_AYUDANTES_MINIMOS = previo
        }
      }),
    ),
  )

  it.live("desglose: modelo y `system`/`tools` del último mensaje, permisos y nombre del servidor MCP", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const cliente = {}
        const defs = {
          "mi-servidor_buscar": { client: cliente, def: { description: "b".repeat(8), inputSchema: {} } },
          "mi-servidor_borrar": { client: cliente, def: { description: "x".repeat(8), inputSchema: {} } },
        }
        actual.mensajes = [usuario({ system: "U".repeat(8), tools: { read: false } })]
        actual.defecto = "nada"
        actual.agente = {
          ...agente,
          permission: [
            { permission: "*", pattern: "*", action: "allow" },
            { permission: "bash", pattern: "*", action: "deny" },
            { permission: "mi-servidor_borrar", pattern: "*", action: "deny" },
          ],
        }
        try {
          return yield* Effect.gen(function* () {
            const r = yield* (yield* SessionContextoFijo.Service).calcular(SessionID.make("ses_x"))
            // el modelo sale del último mensaje (el por defecto no existe): hay entorno y ventana.
            expect(r.desglose.sistema).toBe(Math.ceil((400 + 1 + 8 + 1 + 40) / 4))
            // `read` lo apaga el mensaje y `bash` lo niega el permiso: solo queda `task`.
            expect(r.desglose.herramientas).toBe(Math.ceil((4 + 21 + JSON.stringify({ type: "object" }).length) / 4))
            expect(r.listas.mcp).toEqual([
              { nombre: "mi-servidor_buscar", servidor: "mi-servidor", tokens: Math.ceil(("mi-servidor_buscar".length + 8 + 2) / 4) },
            ])
            expect(r.ventana.contexto).toBe(100_000)
          }).pipe(Effect.provide(capa(dir, defs, { "mi-servidor": cliente })))
        } finally {
          actual.mensajes = []
          actual.defecto = "modelo-x"
          actual.agente = agente
        }
      }),
    ),
  )

  it.live("ventana: sin modelo todo 0; `compaction.auto: false` no reserva; `reserved` y `limit.input` como overflow.ts", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        try {
          return yield* Effect.gen(function* () {
            const svc = yield* SessionContextoFijo.Service
            actual.defecto = "nada"
            const sin = yield* svc.calcular(SessionID.make("ses_x"))
            expect(sin.ventana).toEqual({ contexto: 0, usable: 0, reservado: 0 })
            // sin modelo el sistema es solo el prompt del agente (sin entorno).
            expect(sin.desglose.sistema).toBe(100)
            actual.defecto = "modelo-x"
            actual.cfg = { compaction: { auto: false } }
            expect((yield* svc.calcular(SessionID.make("ses_x"))).ventana).toEqual({ contexto: 100_000, usable: 100_000, reservado: 0 })
            actual.cfg = { compaction: { reserved: 5_000 } }
            ;(modelo.limit as any).input = 90_000
            expect((yield* svc.calcular(SessionID.make("ses_x"))).ventana).toEqual({ contexto: 100_000, usable: 85_000, reservado: 15_000 })
          }).pipe(Effect.provide(capa(dir)))
        } finally {
          actual.defecto = "modelo-x"
          actual.cfg = {}
          delete (modelo.limit as any).input
        }
      }),
    ),
  )

  it.live("listas: como mucho 300 elementos, de mayor a menor", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const defs = Object.fromEntries(
          Array.from({ length: 305 }, (_, i) => [`s_t${i}`, { def: { description: "d".repeat(i * 4), inputSchema: {} } }]),
        )
        return yield* Effect.gen(function* () {
          const r = yield* (yield* SessionContextoFijo.Service).calcular(SessionID.make("ses_x"))
          expect(r.listas.mcp).toHaveLength(SessionContextoFijo.LISTA_MAX)
          expect(r.listas.mcp[0]!.nombre).toBe("s_t304")
          const tokens = r.listas.mcp.map((x) => x.tokens)
          expect(tokens).toEqual(tokens.toSorted((a, b) => b - a))
          // el total sí cuenta todas las herramientas visibles, no solo las 300 listadas
          expect(r.desglose.mcpHerramientas).toBeGreaterThan(tokens.reduce((a, b) => a + b, 0) - 300)
        }).pipe(Effect.provide(capa(dir, defs)))
      }),
    ),
  )

  it.live("sesión inexistente: NotFoundError", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const exit = yield* Effect.gen(function* () {
          return yield* (yield* SessionContextoFijo.Service).calcular(SessionID.make("ses_noexiste"))
        }).pipe(Effect.provide(capa(dir)), Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    ),
  )
})

import { test } from "bun:test"
function test_tokens() {
  test("tokensDe: caracteres / 4 hacia arriba, vacío es 0", () => {
    expect(tokensDe(undefined)).toBe(0)
    expect(tokensDe("")).toBe(0)
    expect(tokensDe("abcde")).toBe(2)
  })
}
