import path from "node:path"
import fs from "node:fs/promises"
import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { CommandV2 } from "@opencode-ai/core/command"
import { AISDK } from "@opencode-ai/core/aisdk"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { pathToFileURL } from "node:url"
import { Catalog } from "@opencode-ai/core/catalog"
import { Config } from "@opencode-ai/core/config"
import { ConfigAgentPlugin } from "@opencode-ai/core/config/plugin/agent"
import { ConfigCommandPlugin } from "@opencode-ai/core/config/plugin/command"
import { ConfigExternalPlugin } from "@opencode-ai/core/config/plugin/external"
import { ConfigProviderPlugin } from "@opencode-ai/core/config/plugin/provider"
import { ConfigReferencePlugin } from "@opencode-ai/core/config/plugin/reference"
import { ConfigSkillPlugin } from "@opencode-ai/core/config/plugin/skill"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Policy } from "@opencode-ai/core/policy"
import { Reference } from "@opencode-ai/core/reference"
import { SkillV2 } from "@opencode-ai/core/skill"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { PluginHost } from "@opencode-ai/core/plugin/host"
import { PluginTestLayer } from "../plugin/fixture"
import { testEffect } from "../lib/effect"
import { DynamicProviderPlugin } from "@opencode-ai/core/plugin/provider/dynamic"
import { SapAICorePlugin } from "@opencode-ai/core/plugin/provider/sap-ai-core"

const it = testEffect(PluginTestLayer)

function withEnv<A, E, R>(vars: Record<string, string | undefined>, effect: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
      Object.entries(vars).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      })
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        Object.entries(previous).forEach(([key, value]) => {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        })
      }),
  )
}

describe("configuración de proyecto en el segundo lector", () => {
  for (const mode of ["control", "1", "true", "0", "cold", "text", "text-cold"] as const) {
    it.live(`complementos, agente y comando: ${mode}`, () =>
      withEnv(
        {
          OPENCODE_DISABLE_PROJECT_CONFIG: ["cold", "control", "text", "text-cold"].includes(mode) ? undefined : mode,
          LAZUNOX_PROYECTO_SIN_CODIGO: mode.startsWith("text") ? "1" : undefined,
        },
        Effect.gen(function* () {
          const location = yield* Location.Service
          const plugins = yield* PluginV2.Service
          const agents = yield* AgentV2.Service
          const commands = yield* CommandV2.Service
          const host = yield* PluginHost.make(plugins)
          const fsUtil = yield* FSUtil.Service
          const reads: string[] = []
          const scans: string[] = []
          const upward: string[] = []
          const traced = FSUtil.Service.of({
            ...fsUtil,
            readFileStringSafe: (file) => {
              reads.push(file)
              return fsUtil.readFileStringSafe(file)
            },
            glob: (pattern, options) => {
              scans.push(String(options?.cwd))
              return fsUtil.glob(pattern, options)
            },
            up: (input) => {
              upward.push(input.start)
              return fsUtil.up(input)
            },
          })
          const sentinel = path.join(location.directory, "centinela.txt")
          const blocked = mode === "1" || mode === "true" || mode === "cold" || mode === "text-cold"
          const textOnly = mode === "text"
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(location.directory, ".opencode/plugin"), { recursive: true })
            await fs.mkdir(path.join(location.directory, ".opencode/agent"), { recursive: true })
            await fs.mkdir(path.join(location.directory, ".opencode/command"), { recursive: true })
            await Bun.write(
              path.join(location.directory, "opencode.json"),
              JSON.stringify({
                plugin: ["./p2.js"],
                agent: { desdeJSON: { prompt: "Texto JSON", permission: "allow", model: "prueba/modelo" } },
                command: { desdeJSON: { template: "Comando JSON !`echo texto`", model: "prueba/modelo" } },
              }),
            )
            await Bun.write(
              path.join(location.directory, ".opencode/opencode.jsonc"),
              JSON.stringify(
                Schema.decodeUnknownSync(Config.Info)({
                  shell: "carpeta-shell",
                  model: "carpeta/modelo",
                  default_agent: "lector",
                  username: "carpeta",
                  autoupdate: false,
                  share: "disabled",
                  enterprise: { url: "https://example.test" },
                  snapshots: false,
                  permissions: [{ action: "bash", resource: "*", effect: "allow" }],
                  watcher: { ignore: ["carpeta/**"] },
                  formatter: false,
                  lsp: false,
                  attachments: { image: { auto_resize: false } },
                  tool_output: { max_lines: 7 },
                  compaction: { auto: false },
                  skills: ["./texto-skills"],
                  instructions: ["REGLAS.md"],
                  references: { apoyo: { path: "./apoyo" } },
                  providers: {
                    carpeta: {
                      env: ["MARCADOR_PRUEBA"],
                      api: { type: "native", settings: {} },
                      request: { headers: {}, body: {} },
                      models: {},
                    },
                  },
                  mcp: { servers: { carpeta: { type: "local", command: ["no-ejecutar"] } } },
                  experimental: { policies: [{ action: "provider.use", resource: "otro", effect: "deny" }] },
                }),
              ),
            )
            await Bun.write(
              path.join(location.directory, ".opencode/skills/local/SKILL.md"),
              "---\nname: local\ndescription: Texto\n---\nTexto de skill",
            )
            await Bun.write(
              path.join(location.directory, ".opencode/agent/lector.md"),
              "---\npermission: allow\nmodel: prueba/modelo\n---\nTexto del agente",
            )
            await Bun.write(
              path.join(location.directory, ".opencode/command/revisar.md"),
              "---\nmodel: prueba/modelo\n---\nTexto del comando !`echo texto`",
            )
            await Bun.write(
              path.join(location.directory, ".opencode/tools/no-cargar.js"),
              `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(sentinel)}, "herramienta\\n");`,
            )
            await Bun.write(
              path.join(location.directory, ".opencode/agent/encabezado.md"),
              `---js\n(require("node:fs").appendFileSync(${JSON.stringify(sentinel)}, "encabezado"), {})\n---\nTexto`,
            )
            await Promise.all(
              [".opencode/plugin/x.js", "p2.js"].map((file) =>
                Bun.write(
                  path.join(location.directory, file),
                  `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(sentinel)}, ${JSON.stringify(file + "\n")});\nexport default { id: ${JSON.stringify(file)}, setup() {} };`,
                ),
              ),
            )
          })

          yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const entries = yield* config.entries()
            expect(entries.some((entry) => entry.type === "directory" && entry.path.endsWith(".opencode"))).toBe(
              !blocked,
            )
            yield* ConfigExternalPlugin.load(host)
            yield* ConfigAgentPlugin.Plugin.effect(host)
            yield* ConfigCommandPlugin.Plugin.effect(host)
            yield* ConfigSkillPlugin.Plugin.effect(host)
            yield* ConfigProviderPlugin.Plugin.effect(host)
            yield* ConfigReferencePlugin.Plugin.effect(host)
            const catalog = yield* Catalog.Service
            const skills = yield* SkillV2.Service
            const references = yield* Reference.Service
            const policy = yield* Policy.Service
            expect((yield* catalog.provider.all()).some((item) => item.id === "carpeta")).toBe(!blocked && !textOnly)
            expect((yield* skills.list()).some((item) => item.name === "local")).toBe(!blocked)
            expect((yield* references.list()).some((item) => item.name === "apoyo")).toBe(!blocked && !textOnly)
            expect(policy.hasStatements()).toBe(!blocked && !textOnly)
            expect(Config.latest(entries, "mcp")?.servers?.carpeta !== undefined).toBe(!blocked && !textOnly)
            expect(upward.length).toBe(blocked ? 0 : 1)
            if (blocked) {
              expect(reads.every((file) => file.startsWith(path.join(location.directory, "global") + path.sep))).toBe(
                true,
              )
              expect(scans.every((dir) => dir === path.join(location.directory, "global"))).toBe(true)
              expect(entries.filter((entry) => entry.type === "document")).toEqual([])
            }
            expect(yield* Effect.promise(() => Bun.file(sentinel).exists())).toBe(!blocked && !textOnly)
            if (!blocked && !textOnly) {
              expect((yield* Effect.promise(() => Bun.file(sentinel).text())).trim().split("\n").sort()).toEqual([
                ".opencode/plugin/x.js",
                "p2.js",
              ])
            }
            for (const name of ["lector", "desdeJSON"]) {
              const agent = yield* agents.get(AgentV2.ID.make(name))
              expect(agent !== undefined).toBe(!blocked)
              if (!blocked && !textOnly) expect(agent?.permissions.some((rule) => rule.effect === "allow")).toBe(true)
              if (textOnly) {
                expect(agent?.permissions).toEqual([])
                expect(agent?.model).toBeUndefined()
                expect(agent?.system).toBe(name === "lector" ? "Texto del agente" : "Texto JSON")
              }
            }
            expect((yield* commands.list()).some((command) => command.name === "revisar")).toBe(!blocked)
            expect((yield* commands.list()).some((command) => command.name === "desdeJSON")).toBe(!blocked)
            if (textOnly) {
              const list = yield* commands.list()
              expect(list.find((command) => command.name === "desdeJSON")).toEqual({
                name: "desdeJSON",
                template: "Comando JSON `echo texto`",
              })
              expect(list.find((command) => command.name === "revisar")).toEqual({
                name: "revisar",
                template: "Texto del comando `echo texto`",
              })
              expect(Config.latest(entries, "instructions")).toEqual(["REGLAS.md"])
              expect(Config.latest(entries, "skills")).toEqual(["./texto-skills"])
            }
          }).pipe(
            Effect.provide(Config.locationLayer),
            Effect.provideService(FSUtil.Service, traced),
            Effect.provideService(Location.Service, { ...location, cold: mode === "cold" || mode === "text-cold" }),
            Effect.provideService(Global.Service, Global.make({ config: path.join(location.directory, "global") })),
          )
        }),
      ),
    )
  }
})

// Audita también los otros dos imports dinámicos v2 que pueden apuntar a código de la carpeta.
for (const kind of ["dynamic", "sap-ai-core"] as const) {
  for (const mode of ["control", "disabled", "cold", "text"] as const) {
    it.live(`SDK local ${kind}: ${mode}`, () =>
      withEnv(
        {
          OPENCODE_DISABLE_PROJECT_CONFIG: mode === "disabled" ? "1" : undefined,
          LAZUNOX_PROYECTO_SIN_CODIGO: mode === "text" ? "1" : undefined,
        },
        Effect.gen(function* () {
          const location = yield* Location.Service
          const plugins = yield* PluginV2.Service
          const catalog = yield* Catalog.Service
          const aisdk = yield* AISDK.Service
          const host = yield* PluginHost.make(plugins)
          const sentinel = path.join(location.directory, "centinela.txt")
          const entry = pathToFileURL(path.join(location.directory, "sdk.mjs")).href
          yield* Effect.promise(async () => {
            await Bun.write(
              path.join(location.directory, "sdk.mjs"),
              `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(sentinel)}, "sdk"); export function createLocal() { return { marker: "local" } }`,
            )
            await Bun.write(
              path.join(location.directory, "opencode.json"),
              JSON.stringify({
                providers: { [kind]: { api: { type: "aisdk", package: entry }, models: { prueba: {} } } },
              }),
            )
          })
          yield* Effect.gen(function* () {
            yield* ConfigProviderPlugin.Plugin.effect(host)
            yield* (kind === "dynamic" ? DynamicProviderPlugin : SapAICorePlugin).effect(host)
            const model = yield* catalog.model.get(ProviderV2.ID.make(kind), ModelV2.ID.make("prueba"))
            expect(model !== undefined).toBe(mode === "control")
            if (model && model.api.type === "aisdk") {
              expect((yield* aisdk.runSDK({ model, package: model.api.package, options: {} })).sdk).toEqual({
                marker: "local",
              })
            }
            expect(yield* Effect.promise(() => Bun.file(sentinel).exists())).toBe(mode === "control")
          }).pipe(
            Effect.provide(Config.locationLayer),
            Effect.provideService(Location.Service, { ...location, cold: mode === "cold" }),
            Effect.provideService(Global.Service, Global.make({ config: path.join(location.directory, "global") })),
          )
        }),
      ),
    )
  }
}

for (const source of ["global", "explicit", "home"] as const) {
  it.live(`solo texto respeta el origen de la configuración: ${source}`, () =>
    Effect.gen(function* () {
      const location = yield* Location.Service
      const plugins = yield* PluginV2.Service
      const agents = yield* AgentV2.Service
      const host = yield* PluginHost.make(plugins)
      const directory = path.join(location.directory, source === "home" ? ".opencode" : "global")
      const sentinel = path.join(location.directory, "centinela.txt")
      yield* Effect.promise(async () => {
        await Bun.write(
          path.join(directory, "opencode.json"),
          JSON.stringify({
            plugin: ["./g.js"],
            agent: { origen: { prompt: "Texto", permission: "allow", model: "prueba/modelo" } },
          }),
        )
        await Bun.write(
          path.join(directory, "g.js"),
          `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(sentinel)}, "global"); export default { id: "origen", setup() {} };`,
        )
      })
      yield* withEnv(
        {
          OPENCODE_DISABLE_PROJECT_CONFIG: "1",
          LAZUNOX_PROYECTO_SIN_CODIGO: "1",
          OPENCODE_CONFIG_DIR: source === "explicit" ? directory : undefined,
        },
        Effect.gen(function* () {
          yield* ConfigExternalPlugin.load(host)
          yield* ConfigAgentPlugin.Plugin.effect(host)
          const agent = yield* agents.get(AgentV2.ID.make("origen"))
          expect(agent?.system).toBe("Texto")
          expect(agent?.permissions.some((rule) => rule.effect === "allow")).toBe(source !== "global")
          expect(agent?.model !== undefined).toBe(source !== "global")
          expect(yield* Effect.promise(() => Bun.file(sentinel).exists())).toBe(source !== "global")
        }).pipe(
          Effect.provide(Config.locationLayer),
          Effect.provideService(Global.Service, Global.make({ home: location.directory, config: directory })),
        ),
      )
    }),
  )
}
