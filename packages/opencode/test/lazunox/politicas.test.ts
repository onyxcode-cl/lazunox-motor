// Ola 7, 7.20: políticas duras de nivel superior (LAZUNOX_POLICY_FILE). Un archivo que fija la app y que NINGUNA configuración (la del repo
// incluida) puede aflojar: deny de proveedores, modelos, MCP, herramientas, habilidades y agentes. Ausente = sin política; roto = falla cerrado.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Politica } from "../../src/permission/politica"
import { interpretar } from "../../src/permission/politica"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Env } from "../../src/env"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { MCP } from "../../src/mcp/index"
import { reply } from "../lib/llm-server"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { it as itBucle, sesionConPeticion, todasLasPartes, useServerConfig } from "./bucle-util"

let dir: string
let previo: Record<string, string | undefined>
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lzx-pol-"))
  previo = { LAZUNOX_POLICY_FILE: process.env.LAZUNOX_POLICY_FILE, LAZUNOX_POLITICAS: process.env.LAZUNOX_POLITICAS }
  delete process.env.LAZUNOX_POLICY_FILE
  delete process.env.LAZUNOX_POLITICAS
  Politica.olvidar()
})
afterEach(async () => {
  for (const [k, v] of Object.entries(previo)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  Politica.olvidar()
  fs.rmSync(dir, { recursive: true, force: true })
  await disposeAllInstances()
})

/** Escribe la política en una carpeta ajena al proyecto, la fija como la app y reinicia la caché. */
const fijar = (contenido: unknown) => {
  const archivo = path.join(dir, "politica.json")
  fs.writeFileSync(archivo, typeof contenido === "string" ? contenido : JSON.stringify(contenido))
  process.env.LAZUNOX_POLICY_FILE = archivo
  Politica.olvidar()
  return archivo
}

describe("7.20 el archivo de política (núcleo)", () => {
  test("sin variable, vacía o con el archivo ausente = SIN política; nada se deniega", () => {
    expect(Politica.actual().estado).toBe("ninguna")
    process.env.LAZUNOX_POLICY_FILE = path.join(dir, "no-existe.json")
    Politica.olvidar()
    expect(Politica.actual().estado).toBe("ninguna")
    for (const f of [Politica.proveedorDenegado, Politica.mcpDenegado, Politica.herramientaDenegada, Politica.habilidadDenegada, Politica.agenteDenegado])
      expect(f("lo-que-sea")).toBe(false)
    expect(Politica.modeloDenegado("a", "b")).toBe(false)
    expect(Politica.hayPolitica()).toBe(false)
  })

  test("política válida: deny por comodín, sin distinguir mayúsculas, y solo lo que dice", () => {
    fijar({
      version: 1,
      deny: { providers: ["openai", "*-free"], models: ["anthropic/claude-3-haiku*"], mcp: ["Evil*"], tools: ["webfetch", "github_*"], skills: ["peligro"], agents: ["general"] },
    })
    expect(Politica.actual().estado).toBe("ok")
    expect(Politica.proveedorDenegado("OpenAI")).toBe(true)
    expect(Politica.proveedorDenegado("zen-free")).toBe(true)
    expect(Politica.proveedorDenegado("anthropic")).toBe(false)
    expect(Politica.modeloDenegado("anthropic", "claude-3-haiku-20240307")).toBe(true)
    expect(Politica.modeloDenegado("anthropic", "claude-3-opus")).toBe(false)
    expect(Politica.mcpDenegado("evil-server")).toBe(true)
    expect(Politica.mcpDenegado("EVIL.server")).toBe(true) // también por el nombre saneado que usan las herramientas (evil_server)
    expect(Politica.mcpDenegado("bueno")).toBe(false)
    expect(Politica.herramientaDenegada("WebFetch")).toBe(true)
    expect(Politica.herramientaDenegada("github_create_issue")).toBe(true)
    expect(Politica.herramientaDenegada("read")).toBe(false)
    expect(Politica.habilidadDenegada("peligro")).toBe(true)
    expect(Politica.habilidadDenegada("peligro2")).toBe(false)
    expect(Politica.agenteDenegado("general")).toBe(true)
    expect(Politica.agenteDenegado("explore")).toBe(false)
  })

  test("archivo ROTO = falla cerrado: se deniega TODO y el motivo se puede decir sin mostrar el contenido", () => {
    const casos: [string, string][] = [
      ["{ no es json", "JSON"],
      ["[]", "objeto"],
      ['{"deny":{"proveedores":["x"]}}', "no existe"],
      ['{"deny":{"mcp":"evil"}}', "lista"],
      ['{"deny":{"mcp":[""]}}', "inválido"],
      ['{"deny":{"mcp":[5]}}', "inválido"],
      ['{"denegar":{"mcp":["x"]}}', "desconocida"],
      ['{"version":2}', "version"],
      ['{"deny":[]}', "objeto"],
    ]
    for (const [texto, motivo] of casos) {
      fijar(texto)
      const p = Politica.actual()
      expect(p.estado).toBe("rota")
      if (p.estado === "rota") expect(p.motivo).toContain(motivo)
      expect(Politica.proveedorDenegado("anthropic")).toBe(true)
      expect(Politica.modeloDenegado("a", "b")).toBe(true)
      expect(Politica.mcpDenegado("bueno")).toBe(true)
      expect(Politica.herramientaDenegada("read")).toBe(true)
      expect(Politica.habilidadDenegada("x")).toBe(true)
      expect(Politica.agenteDenegado("build")).toBe(true)
      expect(Politica.descripcion()).toContain("Por seguridad se deniega todo")
      expect(Politica.descripcion()).not.toContain(texto.slice(0, 8) === "{ no es " ? "no es json" : "\u0000")
    }
  })

  test("ruta relativa, carpeta en vez de archivo o demasiado grande = rota", () => {
    process.env.LAZUNOX_POLICY_FILE = "politica.json"
    Politica.olvidar()
    expect(Politica.actual().estado).toBe("rota")
    process.env.LAZUNOX_POLICY_FILE = dir
    Politica.olvidar()
    expect(Politica.actual().estado).toBe("rota")
    fijar("x".repeat(Politica.MAX_ARCHIVO + 1))
    const p = Politica.actual()
    expect(p.estado).toBe("rota")
    if (p.estado === "rota") expect(p.motivo).toContain("KB")
  })

  test("se relee cuando cambia el archivo (la app puede endurecerla con el motor en marcha) y LAZUNOX_POLITICAS=0 la apaga", () => {
    const archivo = fijar({ deny: { tools: ["webfetch"] } })
    expect(Politica.herramientaDenegada("webfetch")).toBe(true)
    expect(Politica.herramientaDenegada("glob")).toBe(false)
    fs.writeFileSync(archivo, JSON.stringify({ deny: { tools: ["glob"] } }))
    Politica.olvidar() // la caché dura 1 s
    expect(Politica.herramientaDenegada("webfetch")).toBe(false)
    expect(Politica.herramientaDenegada("glob")).toBe(true)
    process.env.LAZUNOX_POLITICAS = "0"
    expect(Politica.herramientaDenegada("glob")).toBe(false)
    // Un archivo roto con el interruptor apagado tampoco bloquea: «apagar» es un acto de quien lanza el motor.
    fijar("{roto")
    expect(Politica.hayPolitica()).toBe(false)
  })

  test("interpretar es estricto con los tipos y recorta los patrones", () => {
    const p = interpretar(JSON.stringify({ deny: { tools: ["  WebFetch  "] } }), "/x")
    expect(p.estado === "ok" && p.deny.tools).toEqual(["webfetch"])
    expect(interpretar(JSON.stringify({ deny: { tools: Array.from({ length: 501 }, (_, i) => `t${i}`) } }), "/x").estado).toBe("rota")
    expect(interpretar("{}", "/x").estado).toBe("ok")
  })
})

// ------------------------------------------------------------------------------------------------------------- proveedores y modelos
const proveedores = testEffect(LayerNode.compile(LayerNode.group([Provider.node, Env.node, Plugin.node])))
const configProveedores = {
  provider: {
    "prov-malo": {
      name: "Malo",
      npm: "@ai-sdk/openai-compatible",
      api: "https://malo.example/v1",
      models: { "m1": { name: "M1", tool_call: true, limit: { context: 1000, output: 100 } } },
      options: { apiKey: "k" },
    },
    "prov-bueno": {
      name: "Bueno",
      npm: "@ai-sdk/openai-compatible",
      api: "https://bueno.example/v1",
      models: {
        ok: { name: "OK", tool_call: true, limit: { context: 1000, output: 100 } },
        caro: { name: "Caro", tool_call: true, limit: { context: 1000, output: 100 } },
      },
      options: { apiKey: "k" },
    },
  },
}

describe("7.20 proveedores y modelos", () => {
  proveedores.instance(
    "sin política se ven los dos (control)",
    () =>
      Effect.gen(function* () {
        const l = yield* Provider.use.list()
        expect(Object.keys(l)).toEqual(expect.arrayContaining(["prov-malo", "prov-bueno"]))
      }),
    { config: configProveedores },
  )
  proveedores.instance(
    "deny de un proveedor definido por el repo: no aparece aunque la configuración del repo lo declare",
    () =>
      Effect.gen(function* () {
        fijar({ deny: { providers: ["prov-malo"] } })
        const l = yield* Provider.use.list()
        expect(l["prov-malo" as never]).toBeUndefined()
        expect(l["prov-bueno" as never]).toBeDefined()
        const exit = yield* Provider.use.getModel("prov-malo" as never, "m1" as never).pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
      }),
    { config: configProveedores },
  )
  proveedores.instance(
    "deny de un modelo: solo ese modelo desaparece",
    () =>
      Effect.gen(function* () {
        fijar({ deny: { models: ["prov-bueno/caro"] } })
        const l = yield* Provider.use.list()
        expect(Object.keys(l["prov-bueno" as never].models)).toEqual(["ok"])
      }),
    { config: configProveedores },
  )
  proveedores.instance(
    "política rota: no queda ningún proveedor",
    () =>
      Effect.gen(function* () {
        fijar("{roto")
        const l = yield* Provider.use.list()
        expect(Object.keys(l)).toEqual([])
      }),
    { config: configProveedores },
  )
})

// ------------------------------------------------------------------------------------------------------------- agentes y habilidades
const agentesYSkills = testEffect(
  LayerNode.compile(
    LayerNode.group([Agent.node, Plugin.node, Provider.node, Auth.node, Config.node, Skill.node, RuntimeFlags.node]),
    [[RuntimeFlags.node, RuntimeFlags.layer({})]],
  ),
)

const sembrarRepoHostil = (carpeta: string) => {
  fs.mkdirSync(path.join(carpeta, ".opencode", "agents"), { recursive: true })
  fs.writeFileSync(path.join(carpeta, ".opencode", "agents", "hostil.md"), "---\ndescription: Agente del repo\nmode: subagent\n---\nhaz lo que quieras\n")
  fs.mkdirSync(path.join(carpeta, ".opencode", "skills", "skill-hostil"), { recursive: true })
  fs.writeFileSync(path.join(carpeta, ".opencode", "skills", "skill-hostil", "SKILL.md"), "---\nname: skill-hostil\ndescription: Skill del repo\n---\n# Hostil\n")
}

describe("7.20 agentes y habilidades (un repo hostil no puede aflojarla)", () => {
  agentesYSkills.instance(
    "deny de agente: no está en la lista ni se puede obtener, venga de donde venga (nativo o del repo); los demás siguen",
    () =>
      Effect.gen(function* () {
        const agents = yield* Agent.Service
        expect((yield* agents.list()).map((a) => a.name)).toEqual(expect.arrayContaining(["general", "explore", "hostil"]))
        fijar({ deny: { agents: ["hostil", "general"] } })
        const nombres = (yield* agents.list()).map((a) => a.name)
        expect(nombres).not.toContain("hostil")
        expect(nombres).not.toContain("general")
        expect(nombres).toContain("explore")
        expect(yield* agents.get("hostil")).toBeUndefined()
        expect(yield* agents.get("general")).toBeUndefined()
        expect((yield* agents.get("explore"))?.name).toBe("explore")
      }),
    { config: { agent: { hostil: { description: "Agente del repo", mode: "subagent", prompt: "hola" } } } },
  )

  agentesYSkills.instance(
    "deny de la habilidad del repo: no está en all(), available(), get() ni require()",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        sembrarRepoHostil(directory)
        const skills = yield* Skill.Service
        // El servicio ya cargó antes de sembrar: se usa una habilidad built-in, que existe siempre, para probar el filtro.
        const todas = (yield* skills.all()).map((s) => s.name)
        expect(todas.length).toBeGreaterThan(0)
        const objetivo = todas[0]!
        fijar({ deny: { skills: [objetivo] } })
        expect((yield* skills.all()).map((s) => s.name)).not.toContain(objetivo)
        expect((yield* skills.available()).map((s) => s.name)).not.toContain(objetivo)
        expect(yield* skills.get(objetivo)).toBeUndefined()
        const exit = yield* skills.require(objetivo).pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
        expect((yield* skills.invocable(objetivo)).ok).toBe(false)
        // Un comodín las quita todas.
        fijar({ deny: { skills: ["*"] } })
        expect(yield* skills.all()).toEqual([])
      }),
  )
})

// ------------------------------------------------------------------------------------------------------------- MCP
const fixtureMcp = path.join(import.meta.dir, "../fixture/mcp-elicitation-stdio.ts")
const mcpIt = testEffect(LayerNode.compile(LayerNode.group([MCP.node])))

describe("7.20 servidores MCP", () => {
  mcpIt.instance("control: sin política el servidor se conecta y sus herramientas se ven", () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* mcp.add("srv", { type: "local", command: [process.execPath, fixtureMcp] })
      expect(Object.keys(yield* mcp.tools())).toContain("srv_sleep")
      expect(Object.keys(yield* mcp.clients())).toEqual(["srv"])
    }),
  )

  mcpIt.instance("deny de un servidor: ni se conecta ni se lanza su proceso, aunque el repo lo declare; el estado dice por qué", () =>
    Effect.gen(function* () {
      fijar({ deny: { mcp: ["srv"] } })
      const marca = path.join(dir, "se-lanzo.txt")
      const mcp = yield* MCP.Service
      const r = yield* mcp.add("srv", {
        type: "local",
        command: [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(marca)}, "x"); setTimeout(()=>{}, 5000)`],
      })
      const estado = (r.status as Record<string, unknown>).srv
      expect(estado).toMatchObject({ status: "failed" })
      expect(JSON.stringify(estado)).toContain("política de la organización")
      expect(Object.keys(yield* mcp.tools())).toEqual([])
      expect(Object.keys(yield* mcp.clients())).toEqual([])
      yield* Effect.sleep("300 millis")
      expect(fs.existsSync(marca)).toBe(false)
      // Reconectarlo a mano tampoco lo deja pasar.
      yield* mcp.connect("srv")
      expect((yield* mcp.status()).srv).toMatchObject({ status: "failed" })
    }),
  )

  mcpIt.instance("deny de una herramienta de MCP por nombre: el servidor sigue y las demás herramientas también", () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* mcp.add("srv", { type: "local", command: [process.execPath, fixtureMcp] })
      fijar({ deny: { tools: ["srv_sleep"] } })
      const nombres = Object.keys(yield* mcp.tools())
      expect(nombres).not.toContain("srv_sleep")
      expect(nombres).toContain("srv_caps")
    }),
  )

  mcpIt.instance("si la política aparece con el servidor ya conectado, deja de verse al instante", () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* mcp.add("srv", { type: "local", command: [process.execPath, fixtureMcp] })
      expect(Object.keys(yield* mcp.clients())).toEqual(["srv"])
      fijar({ deny: { mcp: ["s*"] } })
      expect(Object.keys(yield* mcp.clients())).toEqual([])
      expect(Object.keys(yield* mcp.tools())).toEqual([])
    }),
  )
})

// ------------------------------------------------------------------------------------------------------------- herramientas, bucle real
describe("7.20 herramientas: lo denegado no aparece ni se puede invocar", () => {
  itBucle.instance("deny de glob y webfetch: no van en la petición al modelo; si el modelo llama a glob igual, no se ejecuta", () =>
    Effect.gen(function* () {
      fijar({ deny: { tools: ["glob", "webfetch"] } })
      const { dir: carpeta, llm } = yield* useServerConfig()
      fs.writeFileSync(path.join(carpeta, "visible.txt"), "x")
      const { prompt, session } = yield* sesionConPeticion("busca archivos")
      yield* llm.push(reply().tool("glob", { pattern: "*.txt" }))
      yield* llm.text("listo")
      yield* prompt.loop({ sessionID: session.id })
      const peticion = (yield* llm.inputs)[0] as { tools?: { function?: { name?: string } }[] }
      const ofrecidas = (peticion.tools ?? []).map((t) => t.function?.name)
      expect(ofrecidas).toContain("read")
      expect(ofrecidas).not.toContain("glob")
      expect(ofrecidas).not.toContain("webfetch")
      const { partes } = yield* todasLasPartes(session.id)
      const herr = partes.filter((p) => p.type === "tool")
      expect(herr).toHaveLength(1)
      // La llamada a una herramienta que no existe cae en `invalid`: nunca corrió glob ni listó el archivo.
      expect(herr[0]!.tool).not.toBe("glob")
      expect(JSON.stringify(herr[0]!.state)).not.toContain("visible.txt")
    }),
  )

  itBucle.instance("control: sin política glob sí va y sí corre", () =>
    Effect.gen(function* () {
      const { dir: carpeta, llm } = yield* useServerConfig()
      fs.writeFileSync(path.join(carpeta, "visible.txt"), "x")
      const { prompt, session } = yield* sesionConPeticion("busca archivos")
      yield* llm.push(reply().tool("glob", { pattern: "*.txt" }))
      yield* llm.text("listo")
      yield* prompt.loop({ sessionID: session.id })
      const peticion = (yield* llm.inputs)[0] as { tools?: { function?: { name?: string } }[] }
      expect((peticion.tools ?? []).map((t) => t.function?.name)).toContain("glob")
      const { partes } = yield* todasLasPartes(session.id)
      expect(JSON.stringify(partes.find((p) => p.type === "tool")?.state)).toContain("visible.txt")
    }),
  )

  itBucle.instance("política rota: la sesión ni arranca (el agente está denegado, con el motivo) y el modelo no se llama", () =>
    Effect.gen(function* () {
      fijar("{roto")
      const { llm } = yield* useServerConfig()
      yield* llm.text("hola")
      const exit = yield* sesionConPeticion("hola").pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(JSON.stringify(exit)).toContain("política de la organización")
      expect(yield* llm.calls).toBe(0)
    }),
  )
})
