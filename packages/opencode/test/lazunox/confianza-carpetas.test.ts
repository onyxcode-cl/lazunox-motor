// Lazunox (lazunox.16, B2): confianza de carpetas. Pruebas de unidad: bandera, lista de confianza (rutas físicas, enlaces, hijas y
// superiores), clasificación de rutas frías/cerradas y carga «en frío» por instancia (config del proyecto, instalación, plugins).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { FolderTrust } from "@opencode-ai/core/folder-trust"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Npm } from "@opencode-ai/core/npm"
import { Effect, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import fs from "fs"
import fsp from "fs/promises"
import path from "path"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Env } from "../../src/env"
import { InstanceStore } from "../../src/project/instance-store"
import { esRutaFria } from "../../src/server/routes/instance/httpapi/middleware/instance-context"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const unexpectedHttp = HttpClient.make((request) => Effect.die(`unexpected http request: ${request.method} ${request.url}`))
const layer = LayerNode.compile(LayerNode.group([Config.node, FSUtil.node, Env.node, CrossSpawnSpawner.node]), [
  [Auth.node, AuthTest.empty],
  [Account.node, AccountTest.empty],
  [Npm.node, NpmTest.noop],
  [httpClient, Layer.succeed(HttpClient.HttpClient, unexpectedHttp)],
])
const it = testEffect(layer)

const withEnv = <A, E, R>(entries: Record<string, string | undefined>, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous: Record<string, string | undefined> = {}
      for (const [k, v] of Object.entries(entries)) {
        previous[k] = process.env[k]
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        for (const [k, v] of Object.entries(previous)) {
          if (v === undefined) delete process.env[k]
          else process.env[k] = v
        }
      }),
  )

describe("bandera LAZUNOX_TRUST_REQUIRED (E4)", () => {
  const saved = process.env.LAZUNOX_TRUST_REQUIRED
  afterEach(() => {
    if (saved === undefined) delete process.env.LAZUNOX_TRUST_REQUIRED
    else process.env.LAZUNOX_TRUST_REQUIRED = saved
  })
  test("apagada solo con unset, vacío, 0 y false; cualquier otro valor la enciende", () => {
    delete process.env.LAZUNOX_TRUST_REQUIRED
    expect(FolderTrust.required()).toBe(false)
    for (const off of ["", "0", "false"]) {
      process.env.LAZUNOX_TRUST_REQUIRED = off
      expect(FolderTrust.required()).toBe(false)
    }
    for (const on of ["1", "true", "yes", "TRUE", "FALSE", "on", " "]) {
      process.env.LAZUNOX_TRUST_REQUIRED = on
      expect(FolderTrust.required()).toBe(true)
    }
  })
})

describe("lista de carpetas confiadas (E2, E7, enlaces)", () => {
  let base: string
  beforeEach(() => {
    FolderTrust.reset()
    base = fs.realpathSync(fs.mkdtempSync(path.join(require("os").tmpdir(), "confianza-")))
  })
  afterEach(() => {
    FolderTrust.reset()
    fs.rmSync(base, { recursive: true, force: true })
  })
  const mk = (...p: string[]) => {
    const d = path.join(base, ...p)
    fs.mkdirSync(d, { recursive: true })
    return d
  }

  test("confía la ruta física exacta; hijas y superiores NO quedan confiadas (E2)", () => {
    const T = mk("proj")
    const child = mk("proj", "sub")
    expect(FolderTrust.trust(T)?.added).toBe(true)
    expect(FolderTrust.isTrusted(T)).toBe(true)
    expect(FolderTrust.isTrusted(child)).toBe(false)
    expect(FolderTrust.isTrusted(base)).toBe(false)
    expect(FolderTrust.isTrusted(path.join(T, "node_modules", "pkg"))).toBe(false)
  })

  test("las grafías de la misma carpeta son la misma; las que resuelven a otra no", () => {
    const T = mk("proj")
    const O = mk("otra")
    mk("x")
    FolderTrust.trust(T)
    for (const v of [T + "/", T + "//", T + "/.", path.join(base, ".", "proj"), path.join(base, "x", "..", "proj")])
      expect(FolderTrust.isTrusted(v)).toBe(true)
    for (const v of [O, path.join(T, "..", "otra"), T + "\0", T + "%2f..%2fotra", "relativa", "", "/" + "a".repeat(5000)])
      expect(FolderTrust.isTrusted(v)).toBe(false)
  })

  test("TRUST es idempotente y devuelve la ruta canónica; los enlaces se guardan por su destino físico", () => {
    const V = mk("V")
    const L = path.join(base, "L")
    fs.symlinkSync(V, L)
    const first = FolderTrust.trust(L)!
    expect(first.entry.canonical).toBe(V)
    expect(first.added).toBe(true)
    expect(FolderTrust.trust(V)?.added).toBe(false)
    expect(FolderTrust.list().map((e) => e.canonical)).toEqual([V])
    expect(FolderTrust.isTrusted(L)).toBe(true)
    expect(FolderTrust.isTrusted(V)).toBe(true)
  })

  test("rutas inexistentes, archivos, relativas o con NUL no se confían (E7)", () => {
    const file = path.join(base, "archivo")
    fs.writeFileSync(file, "x")
    for (const bad of [path.join(base, "no-existe"), file, "proj", "./proj", "~/proj", "", "file:///x", base + "\0x", 42, null, ["/x"]])
      expect(FolderTrust.trust(bad)).toBeUndefined()
    expect(FolderTrust.list()).toEqual([])
    // si la carpeta aparece después, sigue sin confianza
    const later = path.join(base, "no-existe")
    fs.mkdirSync(later)
    expect(FolderTrust.isTrusted(later)).toBe(false)
  })

  test("un enlace que antes era la carpeta confiada deja de valer (stale)", () => {
    const T = mk("T")
    const V = mk("V")
    FolderTrust.trust(T)
    fs.renameSync(T, T + ".bak")
    fs.symlinkSync(V, T)
    const verdict = FolderTrust.check(T)
    expect(verdict.trusted).toBe(false)
    expect(verdict.trusted === false && verdict.stale?.canonical).toBe(T)
  })

  test("untrust acepta la ruta física o la registrada", () => {
    const V = mk("V")
    const L = path.join(base, "L")
    fs.symlinkSync(V, L)
    FolderTrust.trust(L)
    expect(FolderTrust.untrust(V).length).toBe(1)
    expect(FolderTrust.isTrusted(L)).toBe(false)
    expect(FolderTrust.untrust(V)).toEqual([])
  })
})

describe("clasificación de rutas (E1)", () => {
  test("clase F: solo lecturas de historial", () => {
    for (const p of ["/session", "/session/status", "/session/ses_1", "/session/ses_1/children", "/session/ses_1/message", "/session/ses_1/message/msg_1", "/session/ses_1/todo", "/session/ses_1/uso", "/permission", "/question"])
      expect(esRutaFria("GET", p)).toBe(true)
  })
  test("clase C por defecto: lo demás, y todo lo que no sea GET", () => {
    for (const p of ["/agent", "/mcp", "/command", "/config", "/session/ses_1/diff", "/event", "/pty", "/experimental/session/ses_1/turnos", "/session/", "/permission/siempre", "/question/x/reply", "/nueva/ruta"])
      expect(esRutaFria("GET", p)).toBe(false)
    for (const m of ["POST", "PATCH", "DELETE", "PUT"])
      for (const p of ["/session", "/session/ses_1", "/session/ses_1/message", "/permission", "/question"]) expect(esRutaFria(m, p)).toBe(false)
  })
})

describe("instancia fría por carpeta (config del proyecto, instalación)", () => {
  const prepararProyecto = (dir: string) =>
    Effect.gen(function* () {
      const w = (rel: string, text: string) => FSUtil.use.writeWithDirs(path.join(dir, rel), text)
      yield* w("opencode.json", JSON.stringify({ model: "project/model", agent: { "del-json": { description: "x", mode: "subagent" } } }))
      yield* w(".opencode/command/centinela.md", "---\ndescription: c\n---\nhola")
      yield* w(".opencode/agent/centinela.md", "---\ndescription: a\nmode: subagent\n---\nhola")
      yield* w(".opencode/plugin/p.js", "export default async () => ({})")
    })
  const provideCold = <A, E, R>(dir: string, self: Effect.Effect<A, E, R>) =>
    InstanceStore.Service.use((store) => store.provide({ directory: dir, cold: true }, self))
  const provideFull = <A, E, R>(dir: string, self: Effect.Effect<A, E, R>) =>
    InstanceStore.Service.use((store) => store.provide({ directory: dir }, self))

  it.effect("fría: ni config del proyecto, ni agentes/comandos/plugins, ni .gitignore ni instalación; plena (control): sí", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* prepararProyecto(dir)
      const cold = yield* provideCold(
        dir,
        Effect.gen(function* () {
          const cfg = yield* Config.use.get()
          return { cfg, dirs: yield* Config.use.directories() }
        }),
      )
      expect(cold.cfg.model).not.toBe("project/model")
      expect(cold.cfg.command?.centinela).toBeUndefined()
      expect(cold.cfg.agent?.centinela).toBeUndefined()
      expect(cold.cfg.agent?.["del-json"]).toBeUndefined()
      expect((cold.cfg.plugin ?? []).some((p) => String(Array.isArray(p) ? p[0] : p).includes("p.js"))).toBe(false)
      expect(cold.dirs.some((d) => d.startsWith(dir))).toBe(false)
      expect(fs.existsSync(path.join(dir, ".opencode", ".gitignore"))).toBe(false)

      // Control: la misma carpeta, instancia plena (tras descartar lo que dejó la fría), sí carga todo.
      yield* InstanceStore.Service.use((store) => store.evict(dir))
      const full = yield* provideFull(dir, Config.use.get())
      expect(full.model).toBe("project/model")
      expect(full.command?.centinela).toBeDefined()
      expect(full.agent?.centinela).toBeDefined()
      expect((full.plugin ?? []).some((p) => String(Array.isArray(p) ? p[0] : p).includes("p.js"))).toBe(true)
    }).pipe(Effect.provide(testInstanceStoreLayer)),
  )

  it.effect("fría: sigue leyendo la config global/inline (OPENCODE_CONFIG_CONTENT)", () =>
    withEnv(
      { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "inline/model" }) },
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        yield* prepararProyecto(dir)
        const cfg = yield* provideCold(dir, Config.use.get())
        expect(cfg.model).toBe("inline/model")
      }),
    ).pipe(Effect.provide(testInstanceStoreLayer)),
  )

  it.effect("confianza encendida y sin git: no se hereda la config de las carpetas madre (E3); apagada, como siempre", () =>
    Effect.gen(function* () {
      const parent = yield* tmpdirScoped()
      const child = path.join(parent, "hija")
      yield* FSUtil.use.writeWithDirs(path.join(parent, ".opencode", "command", "de-la-madre.md"), "---\ndescription: m\n---\nhola")
      yield* FSUtil.use.writeWithDirs(path.join(child, ".opencode", "command", "de-la-hija.md"), "---\ndescription: h\n---\nhola")
      const conBandera = yield* withEnv({ LAZUNOX_TRUST_REQUIRED: "1" }, provideFull(child, Config.use.get()))
      expect(conBandera.command?.["de-la-hija"]).toBeDefined()
      expect(conBandera.command?.["de-la-madre"]).toBeUndefined()
      yield* InstanceStore.Service.use((store) => store.evict(child))
      const sin = yield* withEnv({ LAZUNOX_TRUST_REQUIRED: undefined }, provideFull(child, Config.use.get()))
      expect(sin.command?.["de-la-madre"]).toBeDefined()
    }).pipe(Effect.provide(testInstanceStoreLayer)),
  )

  it.effect("E8: con la confianza encendida, un plugin/agente/config enlazado fuera de la carpeta no se carga", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const fuera = yield* tmpdirScoped()
      yield* FSUtil.use.writeWithDirs(path.join(fuera, "ext.js"), "export default async () => ({})")
      yield* FSUtil.use.writeWithDirs(path.join(fuera, "ag.md"), "---\ndescription: a\nmode: subagent\n---\nhola")
      yield* FSUtil.use.writeWithDirs(path.join(fuera, "oc.json"), JSON.stringify({ model: "enlace/model" }))
      yield* FSUtil.use.writeWithDirs(path.join(dir, ".opencode", "plugin", "propio.js"), "export default async () => ({})")
      yield* FSUtil.use.writeWithDirs(path.join(dir, ".opencode", "agent", "propio.md"), "---\ndescription: a\nmode: subagent\n---\nhola")
      yield* Effect.promise(async () => {
        await fsp.mkdir(path.join(dir, ".opencode", "agent"), { recursive: true })
        await fsp.symlink(path.join(fuera, "ext.js"), path.join(dir, ".opencode", "plugin", "ext.js"))
        await fsp.symlink(path.join(fuera, "ag.md"), path.join(dir, ".opencode", "agent", "enlazado.md"))
        await fsp.symlink(path.join(fuera, "oc.json"), path.join(dir, "opencode.json"))
      })
      const spec = (c: { plugin?: unknown[] }) => (c.plugin ?? []).map((p) => String(Array.isArray(p) ? p[0] : p))
      const cfg = yield* withEnv({ LAZUNOX_TRUST_REQUIRED: "1" }, provideFull(dir, Config.use.get()))
      expect(spec(cfg).some((s) => s.includes("propio.js"))).toBe(true)
      expect(spec(cfg).some((s) => s.includes("ext.js"))).toBe(false)
      expect(cfg.agent?.propio).toBeDefined()
      expect(cfg.agent?.enlazado).toBeUndefined()
      expect(cfg.model).not.toBe("enlace/model")
      // Control sin la bandera: el comportamiento de siempre (los enlaces se siguen).
      yield* InstanceStore.Service.use((store) => store.evict(dir))
      const sin = yield* withEnv({ LAZUNOX_TRUST_REQUIRED: undefined }, provideFull(dir, Config.use.get()))
      expect(spec(sin).some((s) => s.includes("ext.js"))).toBe(true)
      expect(sin.agent?.enlazado).toBeDefined()
    }).pipe(Effect.provide(testInstanceStoreLayer)),
  )
})
