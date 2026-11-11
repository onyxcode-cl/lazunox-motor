// Lazunox (lazunox.16, B2, ronda 2): prueba de regresión del bloqueante 2 (RI1-B2, B2-22/E8): la vía v2 (location
// services) no debe cargar un plugin cuyo archivo, dentro de una carpeta `.opencode` confiada, es un ENLACE
// SIMBÓLICO con destino fuera de la cadena del proyecto.
import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "@opencode-ai/core/config"
import { ConfigExternalPlugin } from "@opencode-ai/core/config/plugin/external"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { Npm } from "@opencode-ai/core/npm"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { host } from "./host"

const it = testEffect(Layer.empty)

function withEnv<A, E, R>(vars: Record<string, string | undefined>, effect: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
      Object.entries(vars).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      })
      return previous
    }),
    effect,
    (previous) =>
      Effect.sync(() =>
        Object.entries(previous).forEach(([key, value]) => {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }),
      ),
  )
}

const npmStub = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: () => Effect.die("unused npm.add"),
    install: () => Effect.die("unused npm.install"),
    which: () => Effect.die("unused npm.which"),
  }),
)

// Sin git, `projectDirectory === directory` reproduce lo que hace `Project.resolve` cuando no hay repo (la carpeta
// misma, no la raíz del disco "/"; para esta prueba basta con que sea igual a `directory`, que es justo el caso
// que `topeDeProyecto` trata como "sin git": no sube a las carpetas madre).
function testLayer(directory: string, globalDirectory: string) {
  const locationLayer = Layer.succeed(
    Location.Service,
    Location.Service.of(
      location({ directory: AbsolutePath.make(directory) }, { projectDirectory: AbsolutePath.make(directory) }),
    ),
  )
  return AppNodeBuilder.build(LayerNode.group([Config.node, Npm.node, FSUtil.node, Location.node, Global.node]), [
    [Location.node, locationLayer],
    [Global.node, Global.layerWith({ config: globalDirectory })],
    [Npm.node, npmStub],
  ])
}

function run(f: string, global: string, added: string[]) {
  const ctx = host({
    plugin: { add: (p) => Effect.sync(() => void added.push(p.id)), remove: () => Effect.die("unused") },
  })
  // El entorno hay que fijarlo ANTES de construir la capa de Config (que lee `Flag.LAZUNOX_TRUST_REQUIRED` al abrir
  // la ubicación): por eso `Effect.provide` va DENTRO de `withEnv`, no fuera.
  return withEnv({ LAZUNOX_TRUST_REQUIRED: "1" }, () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* ConfigExternalPlugin.load(ctx)
      }).pipe(Effect.provide(testLayer(f, global))),
    ),
  )
}

describe("ConfigExternalPlugin.Plugin (vía v2, E8)", () => {
  it.live("no carga un plugin de .opencode/plugin/ enlazado fuera de la carpeta confiada", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const f = path.join(tmp.path, "F")
          const ext = path.join(tmp.path, "EXT")
          const global = path.join(tmp.path, "global")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(f, ".opencode", "plugin"), { recursive: true })
            await fs.mkdir(ext, { recursive: true })
            await fs.writeFile(
              path.join(ext, "ext.js"),
              `export default { id: "ext-confianza-b2-22", setup: async () => ({}) }\n`,
            )
            await fs.symlink(path.join(ext, "ext.js"), path.join(f, ".opencode", "plugin", "ext.js"))
          })

          const added: string[] = []
          yield* run(f, global, added)

          expect(added).toEqual([])
        }),
      ),
    ),
  )

  it.live("sí carga un plugin de .opencode/plugin/ cuando NO es un enlace fuera de la carpeta", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const f = path.join(tmp.path, "F")
          const global = path.join(tmp.path, "global")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(f, ".opencode", "plugin"), { recursive: true })
            await fs.writeFile(
              path.join(f, ".opencode", "plugin", "ext.js"),
              `export default { id: "ext-confianza-b2-22", setup: async () => ({}) }\n`,
            )
          })

          const added: string[] = []
          yield* run(f, global, added)

          expect(added).toEqual(["ext-confianza-b2-22"])
        }),
      ),
    ),
  )
})
