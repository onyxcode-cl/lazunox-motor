import { afterEach, describe, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { Plugin } from "../../src/plugin"
import { Provider } from "@/provider/provider"
import { LLM } from "../../src/session/llm"
import { SessionCompaction } from "../../src/session/compaction"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionSummary } from "../../src/session/summary"
import { Session as SessionNs } from "@/session/session"
import { Todo } from "@/session/todo"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { assistantMsg, cfg, createModel, llm, plano, reply, userMsg, wide } from "./compactacion-util"
import { BLOQUE_MAX_BYTES } from "../../src/session/contexto-vigente"

// Plan PLAN-REBOBINAR-Y-COMPACTACION.md, C2: bloque <contexto-vigente> tras compactar y gancho PostCompact.

const stub = llm()
// Plugin falso: el gancho de usuario PostCompact (en producción lo registra lazunox-ganchos.ts) y la entrada que recibió.
let gancho: string | undefined
let ganchoEntrada: unknown
const plugin = Layer.mock(Plugin.Service)({
  trigger: <Name extends string, Input, Output>(name: Name, input: Input, output: Output) => {
    if (name !== "experimental.session.compacted") return Effect.succeed(output)
    return Effect.sync(() => {
      ganchoEntrada = input
      if (gancho) (output as { context: string[] }).context.push(gancho)
      return output
    })
  },
  list: () => Effect.succeed([]),
  init: () => Effect.void,
})
const summaryLayer = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({ summarize: () => Effect.void, diff: () => Effect.succeed([]), computeDiff: () => Effect.succeed([]) }),
)
const env = AppNodeBuilder.build(
  LayerNode.group([
    SessionCompaction.node,
    SessionNs.node,
    SessionProjector.node,
    Database.node,
    EventV2Bridge.node,
    CrossSpawnSpawner.node,
    Todo.node,
    BackgroundJob.node,
  ]),
  [
    [Provider.node, wide().layer],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
    [SessionSummary.node, summaryLayer],
    [LLM.node, stub.llmLayer],
    [Plugin.node, plugin],
    [Config.node, cfg({ tail_turns: 0 })],
  ],
)
const it = testEffect(env)

afterEach(() => {
  stub.reset()
  gancho = undefined
  ganchoEntrada = undefined
  delete process.env.LAZUNOX_COMPACT_REINYECTAR
})

const modelo = createModel({ context: 100_000, output: 32_000 })
const habilidad = (dir: string, nombre: string, cuerpo: string) => {
  fs.mkdirSync(path.join(dir, ".agents", "skills", nombre), { recursive: true })
  fs.writeFileSync(path.join(dir, ".agents", "skills", nombre, "SKILL.md"), `---\nname: ${nombre}\ndescription: Habilidad de prueba\n---\n${cuerpo}\n`)
}

/** Sesión con un turno que cargó la habilidad `nombre` y leyó un archivo de `sub/` (adjuntó su AGENTS.md); luego la compacta entera. */
const compactarConCarga = (opts: { dir: string; habilidades?: string[]; cargados?: string[]; tareas?: boolean; ayudante?: boolean }) =>
  Effect.gen(function* () {
    const ssn = yield* SessionNs.Service
    const session = yield* ssn.create({})
    if (opts.tareas)
      yield* (yield* Todo.Service).update({
        sessionID: session.id,
        todos: [
          { content: "Migrar la tabla de usuarios", status: "in_progress", priority: "high" },
          { content: "Escribir las pruebas", status: "pending", priority: "medium" },
        ],
      })
    const u = yield* userMsg(session.id, "primer turno")
    yield* assistantMsg(session.id, u.id, {
      text: "listo",
      tools: [
        ...(opts.habilidades ?? []).map((n) => ({ tool: "skill", input: { name: n }, output: `<skill_content name="${n}">…</skill_content>`, metadata: { name: n } })),
        ...(opts.cargados ? [{ tool: "read", input: { filePath: path.join(opts.dir, "sub", "x.ts") }, output: "contenido", metadata: { loaded: opts.cargados } }] : []),
      ],
    })
    yield* userMsg(session.id, "segundo turno")
    if (opts.ayudante)
      yield* BackgroundJob.Service.use((jobs) =>
        jobs.start({ id: "ses_ayudante1", type: "explore", title: "Revisar los logs", metadata: { parentSessionId: session.id }, run: Effect.never }),
      )
    return { session, ...(yield* compactar(session.id)) }
  })

const compactar = (sessionID: SessionNs.Info["id"]) =>
  Effect.gen(function* () {
    const ssn = yield* SessionNs.Service
    stub.push(reply("RESUMEN"))
    yield* SessionCompaction.use.create({ sessionID, agent: "build", model: { providerID: "test" as never, modelID: "test-model" as never }, auto: false })
    const msgs = yield* MessageV2.filterCompactedEffect(sessionID)
    const parent = msgs.at(-1)!.info.id
    yield* SessionCompaction.use.process({ parentID: parent, messages: msgs, sessionID, auto: false })
    const marcador = (yield* ssn.messages({ sessionID })).find((m) => m.info.id === parent)!
    const bloque = marcador.parts.find((p) => p.type === "text")
    return { parent, marcador, bloque: bloque?.type === "text" ? bloque : undefined }
  })

describe("reinyección <contexto-vigente> tras compactar", () => {
  it.instance(
    "tareas, habilidad cargada, AGENTS.md de subcarpeta, ayudante vivo y PostCompact llegan al bloque y a la petición siguiente",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        habilidad(directory, "mi-habilidad", "REGLA-DE-LA-HABILIDAD: siempre usa tabs")
        fs.mkdirSync(path.join(directory, "sub"), { recursive: true })
        fs.writeFileSync(path.join(directory, "sub", "AGENTS.md"), "REGLA-DE-SUB: no toques los snapshots")
        gancho = "[Gancho PostCompact]\nMARCADOR-POSTCOMPACT-77"

        const { bloque, session } = yield* compactarConCarga({
          dir: directory,
          habilidades: ["mi-habilidad"],
          cargados: [path.join(directory, "sub", "AGENTS.md")],
          tareas: true,
          ayudante: true,
        })
        expect(bloque).toBeDefined()
        expect(bloque!.synthetic).toBe(true)
        for (const x of [
          "<contexto-vigente>",
          "[in_progress] Migrar la tabla de usuarios",
          "[pending] Escribir las pruebas",
          "REGLA-DE-LA-HABILIDAD",
          "REGLA-DE-SUB",
          "ses_ayudante1",
          "Revisar los logs",
          "MARCADOR-POSTCOMPACT-77",
          "[Gancho PostCompact]",
        ])
          expect(bloque!.text).toContain(x)
        expect(Buffer.byteLength(bloque!.text)).toBeLessThanOrEqual(BLOQUE_MAX_BYTES)
        expect(ganchoEntrada).toMatchObject({ sessionID: session.id, trigger: "manual", parcial: false })

        // La parte compaction guarda solo etiquetas.
        const parte = (yield* (yield* SessionNs.Service).messages({ sessionID: session.id })).flatMap((m) => m.parts).find((p) => p.type === "compaction")
        expect(parte && parte.type === "compaction" && parte.lazunox?.reinyectado).toEqual(["plan:2", "habilidades:1", "instrucciones:1", "ayudantes:1", "gancho:1"])
        expect(JSON.stringify(parte)).not.toContain("REGLA-DE")

        // La petición siguiente al modelo lleva el bloque (junto a la pregunta sintética y el resumen).
        const siguiente = yield* MessageV2.toModelMessagesEffect(yield* MessageV2.filterCompactedEffect(session.id), modelo)
        const texto = JSON.stringify(siguiente)
        expect(texto).toContain("What did we do so far?")
        expect(texto).toContain("REGLA-DE-LA-HABILIDAD")
        expect(texto).toContain("REGLA-DE-SUB")
        expect(texto).toContain("MARCADOR-POSTCOMPACT-77")
      }),
    { git: true },
  )

  it.instance(
    "el bloque no pasa de 16 KB: lo que no cabe sale solo con su nombre",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        habilidad(directory, "enorme", "E".repeat(100_000))
        fs.mkdirSync(path.join(directory, "sub"), { recursive: true })
        fs.writeFileSync(path.join(directory, "sub", "AGENTS.md"), "S".repeat(100_000))
        const { bloque } = yield* compactarConCarga({
          dir: directory,
          habilidades: ["enorme"],
          cargados: [path.join(directory, "sub", "AGENTS.md")],
          tareas: true,
        })
        expect(Buffer.byteLength(bloque!.text)).toBeLessThanOrEqual(BLOQUE_MAX_BYTES)
        expect(bloque!.text).toContain("### enorme")
        expect(bloque!.text).toContain("vuelve a cargarla si la necesitas")
        expect(bloque!.text).toContain("[in_progress] Migrar la tabla de usuarios")
        expect(bloque!.text).not.toContain("EEEEEEEEEE")
      }),
    { git: true },
  )

  it.instance(
    "con la lista vacía no se reinyecta nada",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { bloque, session } = yield* compactarConCarga({ dir: directory })
        expect(bloque).toBeUndefined()
        const parte = (yield* (yield* SessionNs.Service).messages({ sessionID: session.id })).flatMap((m) => m.parts).find((p) => p.type === "compaction")
        expect(parte && parte.type === "compaction" && parte.lazunox?.reinyectado).toEqual([])
      }),
    { git: true },
  )

  it.instance(
    "LAZUNOX_COMPACT_REINYECTAR=0 apaga el bloque (el gancho se avisa pero su salida no entra)",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        process.env.LAZUNOX_COMPACT_REINYECTAR = "0"
        gancho = "[Gancho PostCompact]\nNO-DEBE-ENTRAR"
        const { bloque, session } = yield* compactarConCarga({ dir: directory, tareas: true })
        expect(bloque).toBeUndefined()
        expect(ganchoEntrada).toBeDefined()
        const texto = JSON.stringify(yield* MessageV2.toModelMessagesEffect(yield* MessageV2.filterCompactedEffect(session.id), modelo))
        expect(texto).not.toContain("NO-DEBE-ENTRAR")
        expect(texto).not.toContain("contexto-vigente")
      }),
    { git: true },
  )

  it.instance(
    "solo entra lo que está dentro del proyecto y es un archivo de instrucciones real (enlaces, otros archivos y rutas ajenas se ignoran)",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const fuera = fs.mkdtempSync(path.join(path.dirname(directory), "fuera-"))
        fs.writeFileSync(path.join(fuera, "AGENTS.md"), "SECRETO-FUERA-DEL-PROYECTO")
        fs.mkdirSync(path.join(directory, "enlace"), { recursive: true })
        fs.symlinkSync(path.join(fuera, "AGENTS.md"), path.join(directory, "enlace", "AGENTS.md"))
        fs.mkdirSync(path.join(directory, "sub"), { recursive: true })
        fs.writeFileSync(path.join(directory, "sub", "notas.txt"), "NO-ES-INSTRUCCION")
        fs.writeFileSync(path.join(directory, "sub", "AGENTS.md"), "INSTRUCCION-LEGITIMA")
        const { bloque } = yield* compactarConCarga({
          dir: directory,
          cargados: [
            path.join(fuera, "AGENTS.md"),
            path.join(directory, "enlace", "AGENTS.md"),
            path.join(directory, "sub", "notas.txt"),
            path.join(directory, "..", "..", "etc", "passwd"),
            path.join(directory, "sub", "AGENTS.md"),
          ],
        })
        expect(bloque!.text).toContain("INSTRUCCION-LEGITIMA")
        for (const x of ["SECRETO-FUERA-DEL-PROYECTO", "NO-ES-INSTRUCCION", "root:"]) expect(bloque!.text).not.toContain(x)
        fs.rmSync(fuera, { recursive: true, force: true })
      }),
    { git: true },
  )

  it.instance(
    "dos compactaciones seguidas: la habilidad y las tareas siguen presentes en la segunda",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        habilidad(directory, "persistente", "CONTENIDO-PERSISTENTE")
        const { session } = yield* compactarConCarga({ dir: directory, habilidades: ["persistente"], tareas: true })
        yield* userMsg(session.id, "tercer turno")
        const otra = yield* compactar(session.id)
        expect(otra.bloque).toBeDefined()
        expect(otra.bloque!.text).toContain("CONTENIDO-PERSISTENTE")
        expect(otra.bloque!.text).toContain("[in_progress] Migrar la tabla de usuarios")
        // El bloque viejo se oculta junto con su compactación: solo hay uno visible en la petición.
        const texto = JSON.stringify(yield* MessageV2.toModelMessagesEffect(yield* MessageV2.filterCompactedEffect(session.id), modelo))
        expect(texto.split("<contexto-vigente>").length - 1).toBe(1)
      }),
    { git: true },
  )

  it.instance(
    "la petición de resumen no cambia por la reinyección (no se mete en el prompt del resumen)",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        habilidad(directory, "mi-habilidad", "REGLA-DE-LA-HABILIDAD")
        yield* compactarConCarga({ dir: directory, habilidades: ["mi-habilidad"], tareas: true })
        // La lista de tareas ya iba al resumen antes de este cambio; el contenido de la habilidad no se duplica ahí.
        expect(plano(stub.peticiones[0]!)).toContain("Lista de tareas de la sesión")
        expect(plano(stub.peticiones[0]!)).not.toContain("REGLA-DE-LA-HABILIDAD")
      }),
    { git: true },
  )
})
