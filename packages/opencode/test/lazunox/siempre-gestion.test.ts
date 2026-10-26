import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Layer, Option } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { archivo, borrarTodas, borrarUno, guardar, idDe, leer, persistible } from "../../src/permission/siempre-disco"
import { Permission } from "../../src/permission"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { SessionID } from "../../src/session/schema"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "../server/httpapi-layer"

// Ola 7, 7.22: listar, borrar uno y borrar todos los «siempre» guardados en disco.
const ON = { LAZUNOX_PERMISSION_PERSIST: "1" } as NodeJS.ProcessEnv
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lzx-siempre-"))
const A = { permission: "bash", pattern: "git status *" }
const B = { permission: "bash", pattern: "bun test *" }
const C = { permission: "context7_query-docs", pattern: "*" }

describe("siempre-disco: gestión", () => {
  test("listar da id estable y no depende del interruptor", () => {
    const base = tmp()
    guardar("/p", [A, B, C], base, ON)
    const apagado = leer("/p", base, {} as NodeJS.ProcessEnv)
    expect(apagado.estado).toBe("ok")
    expect(apagado.reglas.map((r) => r.pattern)).toEqual(["git status *", "bun test *", "*"])
    expect(apagado.reglas[0]!.id).toBe(idDe(A))
    expect(leer("/p", base, ON).reglas.map((r) => r.id)).toEqual(apagado.reglas.map((r) => r.id))
    expect(leer("/otra", base, ON)).toEqual({ reglas: [], estado: "ausente", ignoradas: 0 })
  })

  test("borrar uno no afecta a los demás ni a otras carpetas", () => {
    const base = tmp()
    guardar("/p", [A, B, C], base, ON)
    guardar("/q", [A], base, ON)
    expect(borrarUno("/p", idDe(B), base, ON)).toEqual(B)
    expect(leer("/p", base, ON).reglas.map(({ permission, pattern }) => ({ permission, pattern }))).toEqual([A, C])
    expect(leer("/q", base, ON).reglas).toHaveLength(1)
    expect(borrarUno("/p", idDe(B), base, ON)).toBeUndefined() // ya no existe
    expect(borrarUno("/p", "inventado", base, ON)).toBeUndefined()
    expect(leer("/p", base, ON).reglas).toHaveLength(2)
    expect((fs.statSync(archivo("/p", base)).mode & 0o777).toString(8)).toBe("600")
  })

  test("borrar todos solo vacía esa carpeta", () => {
    const base = tmp()
    guardar("/p", [A, B], base, ON)
    guardar("/q", [A], base, ON)
    expect(borrarTodas("/p", base, ON)).toHaveLength(2)
    expect(leer("/p", base, ON).estado).toBe("ausente")
    expect(leer("/q", base, ON).reglas).toHaveLength(1)
    expect(borrarTodas("/p", base, ON)).toEqual([])
  })

  test("nunca se guarda una acción prohibida (lista de exclusión, comodín de herramienta propia, patrones raros)", () => {
    const base = tmp()
    const env = { ...ON, LAZUNOX_PERMISSION_NO_PERSIST: "computer_*" }
    const prohibidas = [
      { permission: "external_directory", pattern: "/etc/*" },
      { permission: "doom_loop", pattern: "x" },
      { permission: "computer_click", pattern: "x" },
      { permission: "bash", pattern: "*" },
      { permission: "edit", pattern: "*" },
      { permission: "bash", pattern: "a\nb" },
    ]
    guardar("/p", [...prohibidas, A], base, env)
    expect(leer("/p", base, env).reglas.map((r) => r.permission)).toEqual(["bash"])
    for (const r of prohibidas) expect(persistible(r, env)).toBe(false)
    // Aunque alguien las escriba a mano en el archivo, ni se listan ni se cargan: se cuentan como ignoradas.
    fs.writeFileSync(archivo("/h", base), JSON.stringify({ directory: "/h", rules: [...prohibidas, A] }))
    const l = leer("/h", base, env)
    expect(l.reglas).toHaveLength(1)
    expect(l.ignoradas).toBe(prohibidas.length)
  })

  test("archivo corrupto: no lanza, se informa y borrar uno no lo toca; borrar todos lo quita", () => {
    const base = tmp()
    fs.mkdirSync(base, { recursive: true })
    const roto = archivo("/p", base)
    for (const contenido of ["{no es json", JSON.stringify({ directory: "/otra", rules: [A] }), JSON.stringify({ directory: "/p", rules: "x" }), "null"]) {
      fs.writeFileSync(roto, contenido)
      expect(leer("/p", base, ON)).toEqual({ reglas: [], estado: "corrupto", ignoradas: 0 })
      expect(borrarUno("/p", idDe(A), base, ON)).toBeUndefined()
      expect(fs.readFileSync(roto, "utf-8")).toBe(contenido)
    }
    expect(borrarTodas("/p", base, ON)).toEqual([])
    expect(fs.existsSync(roto)).toBe(false)
    // Y guardar de nuevo funciona sobre un archivo roto.
    fs.writeFileSync(roto, "{{")
    guardar("/p", [A], base, ON)
    expect(leer("/p", base, ON).reglas).toHaveLength(1)
  })

  test("reglas con basura mezclada: las válidas se listan, el resto se cuenta", () => {
    const base = tmp()
    fs.writeFileSync(archivo("/p", base), JSON.stringify({ directory: "/p", rules: [A, null, 3, { permission: 1 }, A, B] }))
    const l = leer("/p", base, ON)
    expect(l.reglas).toHaveLength(2) // A repetida se une
    expect(l.ignoradas).toBe(3)
  })

  test("concurrencia: guardados y borrados intercalados no se pierden ni dejan restos", async () => {
    const base = tmp()
    const muchas = Array.from({ length: 40 }, (_, i) => ({ permission: "bash", pattern: `cmd${i} *` }))
    await Promise.all(
      muchas.map(async (r, i) => {
        await Promise.resolve()
        guardar("/p", [r], base, ON)
        if (i % 2 === 1) borrarUno("/p", idDe(r), base, ON)
      }),
    )
    const quedan = leer("/p", base, ON).reglas.map((r) => r.pattern).sort()
    expect(quedan).toEqual(muchas.filter((_, i) => i % 2 === 0).map((r) => r.pattern).sort())
    expect(fs.readdirSync(base).filter((f) => f.endsWith(".tmp") || f.endsWith(".lock"))).toEqual([])
  })

  test("concurrencia entre procesos: el cerrojo evita perder escrituras", async () => {
    const base = tmp()
    const modulo = path.resolve(import.meta.dir, "../../src/permission/siempre-disco.ts")
    const script = `import { guardar } from ${JSON.stringify(modulo)}
for (let i = 0; i < 15; i++) guardar("/p", [{ permission: "bash", pattern: process.argv[2] + "-" + i }], ${JSON.stringify(base)}, { LAZUNOX_PERMISSION_PERSIST: "1" })`
    const f = path.join(base, "hijo.ts")
    fs.writeFileSync(f, script)
    const procs = ["a", "b", "c"].map((n) => Bun.spawn([process.execPath, f, n], { stdout: "ignore", stderr: "ignore" }))
    await Promise.all(procs.map((p) => p.exited))
    expect(leer("/p", base, ON).reglas).toHaveLength(45)
  })
})

// --- Rutas HTTP ---
const it = testEffect(httpApiLayer)
const json = <T>(r: HttpClientResponse.HttpClientResponse) => r.json.pipe(Effect.map((v) => v as T))
const guardadas = process.env.LAZUNOX_PERMISSION_DIR
const persist = process.env.LAZUNOX_PERMISSION_PERSIST
afterEach(async () => {
  if (guardadas === undefined) delete process.env.LAZUNOX_PERMISSION_DIR
  else process.env.LAZUNOX_PERMISSION_DIR = guardadas
  if (persist === undefined) delete process.env.LAZUNOX_PERMISSION_PERSIST
  else process.env.LAZUNOX_PERMISSION_PERSIST = persist
  await disposeAllInstances()
})

describe("rutas /permission/siempre", () => {
  it.instance("listar, borrar uno (404 si no existe) y borrar todos", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const base = tmp()
      process.env.LAZUNOX_PERMISSION_DIR = base
      delete process.env.LAZUNOX_PERMISSION_PERSIST // apagado: aun así se puede gestionar
      guardar(directory, [A, B, C], base, ON)

      const lista = yield* json<{ activo: boolean; reglas: { id: string; permission: string; pattern: string }[]; aviso?: string }>(
        yield* requestInDirectory("/permission/siempre", directory),
      )
      expect(lista.activo).toBe(false)
      expect(lista.reglas.map((r) => r.pattern)).toEqual(["git status *", "bun test *", "*"])
      expect(lista.aviso).toBeUndefined()

      const uno = yield* requestInDirectory(`/permission/siempre/${lista.reglas[1]!.id}`, directory, { method: "DELETE" })
      expect(uno.status).toBe(200)
      const falta = yield* requestInDirectory(`/permission/siempre/${lista.reglas[1]!.id}`, directory, { method: "DELETE" })
      expect(falta.status).toBe(404)
      const tras = yield* json<{ reglas: { pattern: string }[] }>(yield* requestInDirectory("/permission/siempre", directory))
      expect(tras.reglas.map((r) => r.pattern)).toEqual(["git status *", "*"])

      expect(yield* json(yield* requestInDirectory("/permission/siempre", directory, { method: "DELETE" }))).toEqual({ borradas: 2 })
      expect((yield* json<{ reglas: unknown[] }>(yield* requestInDirectory("/permission/siempre", directory))).reglas).toEqual([])
    }),
  )

  it.instance("archivo corrupto: responde con aviso, sin romper", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const base = tmp()
      process.env.LAZUNOX_PERMISSION_DIR = base
      fs.writeFileSync(archivo(directory, base), "{roto")
      const lista = yield* json<{ reglas: unknown[]; aviso?: string }>(yield* requestInDirectory("/permission/siempre", directory))
      expect(lista.reglas).toEqual([])
      expect(lista.aviso).toContain("dañado")
      expect(yield* json(yield* requestInDirectory("/permission/siempre", directory, { method: "DELETE" }))).toEqual({ borradas: 0 })
      expect(fs.existsSync(archivo(directory, base))).toBe(false)
    }),
  )
})

// --- El servicio: lo borrado deja de valer en memoria ---
const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const envServicio = AppNodeBuilder.build(
  LayerNode.group([Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
  [[InstanceStore.bootstrapNode, noopBootstrap]],
)
const itServicio = testEffect(envServicio)

describe("Permission.siempre (servicio)", () => {
  itServicio.instance("borrar uno quita también lo aprobado en memoria; los demás siguen valiendo", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const base = tmp()
      process.env.LAZUNOX_PERMISSION_DIR = base
      process.env.LAZUNOX_PERMISSION_PERSIST = "1"
      // El servicio carga el disco al crear el estado de la carpeta (primera llamada).
      guardar(directory, [A, B], base, ON)
      const svc = yield* Permission.Service
      const pide = (patron: string) =>
        svc
          .ask({ sessionID: SessionID.make("ses_gestion"), permission: "bash", patterns: [patron], metadata: {}, always: [], ruleset: [] })
          .pipe(Effect.as("aprobada"), Effect.timeoutOption("150 millis"))
      const lista = yield* svc.siempre!.listar()
      expect(lista.activo).toBe(true)
      expect(lista.reglas).toHaveLength(2)
      expect(yield* pide("git status -s")).toEqual(Option.some("aprobada"))
      expect(yield* svc.siempre!.borrar(lista.reglas[0]!.id)).toBe(true)
      expect(yield* svc.siempre!.borrar(lista.reglas[0]!.id)).toBe(false)
      // Ya no está aprobada: la petición queda esperando respuesta (pendiente) en vez de pasar sola.
      expect(yield* pide("git status -s")).toEqual(Option.none())
      expect(yield* pide("bun test x")).toEqual(Option.some("aprobada"))
      expect(yield* svc.siempre!.borrarTodos()).toBe(1)
      expect(yield* pide("bun test x")).toEqual(Option.none())
    }),
  )
})
