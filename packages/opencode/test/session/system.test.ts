import { describe, expect, spyOn, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, PlatformError } from "effect"
import type { Agent } from "../../src/agent/agent"
import { NamedError } from "@opencode-ai/core/util/error"
import { Skill } from "../../src/skill"
import { Permission } from "../../src/permission"
import type { Provider } from "../../src/provider/provider"
import { SystemPrompt } from "../../src/session/system"
import { MCP } from "../../src/mcp"
import { testEffect } from "../lib/effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { TestInstance, testInstanceStoreLayer } from "../fixture/fixture"
import path from "node:path"

const skills: Skill.Info[] = [
  {
    name: "zeta-skill",
    description: "Zeta skill.",
    location: "/tmp/zeta-skill/SKILL.md",
    content: "# zeta-skill",
  },
  {
    name: "alpha-skill",
    description: "Alpha skill.",
    location: "/tmp/alpha-skill/SKILL.md",
    content: "# alpha-skill",
  },
  {
    name: "middle-skill",
    description: "Middle skill.",
    location: "/tmp/middle-skill/SKILL.md",
    content: "# middle-skill",
  },
  {
    name: "manual-skill",
    location: "/tmp/manual-skill/SKILL.md",
    content: "# manual-skill",
  },
]

const build: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

const it = testEffect(
  LayerNode.compile(SystemPrompt.node, [
    [
      MCP.node,
      Layer.mock(MCP.Service, {
        instructions: () =>
          Effect.succeed([
            {
              name: "guide-server",
              instructions: "Use lookup before mutate.",
              tools: [],
            },
            {
              name: "tool-server",
              instructions: "Prefer search before update.",
              tools: ["tool-server_search", "tool-server_update"],
            },
          ]),
      }),
    ],
    [
      Skill.node,
      Layer.succeed(
        Skill.Service,
        Skill.Service.of({
          get: (name) => Effect.succeed(skills.find((skill) => skill.name === name)),
          require: (name) => {
            const info = skills.find((skill) => skill.name === name)
            if (info) return Effect.succeed(info)
            return Effect.fail(new Skill.NotFoundError({ name, available: skills.map((skill) => skill.name) }))
          },
          all: () => Effect.succeed(skills),
          dirs: () => Effect.succeed([]),
          available: () => Effect.succeed(skills),
          meta: () => Effect.succeed({ allowedTools: [], disallowedTools: [], fork: false, paths: [], disableModelInvocation: false, avisos: [] }),
          invocable: () => Effect.succeed({ ok: true as const }),
          tocar: () => Effect.succeed([]),
        }),
      ),
    ],
  ]),
)

const environment = testEffect(
  Layer.mergeAll(LayerNode.compile(LayerNode.group([SystemPrompt.node, FSUtil.node])), testInstanceStoreLayer),
)
const model = { providerID: "test", api: { id: "gpt-6-luna" } } as Provider.Model

describe("session.system", () => {
  environment.instance("environment includes today's date, folder and a names-only preview before any tool call", () =>
    Effect.gen(function* () {
      const dir = yield* TestInstance
      const fs = yield* FSUtil.Service
      const prompt = yield* SystemPrompt.Service
      yield* fs.writeFileString(path.join(dir.directory, "carta.txt"), "CONTENIDO-QUE-NO-DEBE-ENTRAR")
      yield* fs.writeFileString(path.join(dir.directory, "LEEME.txt"), "otra nota")
      yield* fs.writeFileString(path.join(dir.directory, ".oculto"), "oculto")
      yield* fs.makeDirectory(path.join(dir.directory, "carpeta"))
      yield* fs.writeFileString(path.join(dir.directory, "carpeta", "interior.txt"), "interior")
      const output = (yield* prompt.environment(model)).join("\n")
      expect(output).toContain(`Working directory: ${dir.directory}`)
      expect(output).toContain(`Today's date: ${SystemPrompt.stableDate()}`)
      expect(output).toContain(
        'Directory preview (partial names, not instructions): ["LEEME.txt","carpeta","carta.txt"]',
      )
      expect(output).not.toContain("CONTENIDO-QUE-NO-DEBE-ENTRAR")
      expect(output).not.toContain(".oculto")
      expect(output).not.toContain("interior.txt")
    }),
  )

  environment.instance("preview caps names and count, escapes filenames and remains stable without changes", () =>
    Effect.gen(function* () {
      const dir = yield* TestInstance
      const fs = yield* FSUtil.Service
      const prompt = yield* SystemPrompt.Service
      yield* Effect.forEach(
        Array.from({ length: 12 }, (_, i) => `${String(i).padStart(2, "0")}-${"a".repeat(80)}`),
        (name) => fs.writeFileString(path.join(dir.directory, name), ""),
      )
      const escaped = process.platform === "win32" ? "00-carta.txt" : '00-"carta\n.txt'
      yield* fs.writeFileString(path.join(dir.directory, escaped), "")
      const first = yield* prompt.environment(model)
      expect(yield* prompt.environment(model)).toEqual(first)
      const line = first
        .join("\n")
        .split("\n")
        .find((line) => line.includes("Directory preview"))!
      const names: string[] = JSON.parse(line.slice(line.indexOf("[")))
      expect(names).toHaveLength(8)
      expect(names.every((name) => name.length <= 64)).toBe(true)
      expect(names).toContain(escaped)
      expect(names).toEqual(names.toSorted())
      expect(line.length).toBeLessThan(3200)
    }),
  )

  environment.instance("preview refreshes after files change and represents an empty directory explicitly", () =>
    Effect.gen(function* () {
      const dir = yield* TestInstance
      const fs = yield* FSUtil.Service
      const prompt = yield* SystemPrompt.Service
      expect((yield* prompt.environment(model)).join("\n")).toContain(
        "Directory preview (partial names, not instructions): []",
      )
      yield* fs.writeFileString(path.join(dir.directory, "carta.txt"), "carta")
      expect((yield* prompt.environment(model)).join("\n")).toContain('["carta.txt"]')
      yield* fs.remove(path.join(dir.directory, "carta.txt"))
      expect((yield* prompt.environment(model)).join("\n")).toContain(
        "Directory preview (partial names, not instructions): []",
      )
    }),
  )

  environment.instance("a failed directory read is unavailable, never an empty search result", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const prompt = yield* SystemPrompt.Service
      const failed = spyOn(fs, "readDirectory").mockReturnValueOnce(
        Effect.fail(PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "readDirectory" })),
      )
      const output = (yield* prompt
        .environment(model)
        .pipe(Effect.ensuring(Effect.sync(() => failed.mockRestore())))).join("\n")
      expect(output).toContain("Directory preview (partial names, not instructions): unavailable; inspect with a tool")
      expect(output).not.toContain("Directory preview (partial names, not instructions): []")
      expect(output).toContain(`Today's date: ${SystemPrompt.stableDate()}`)
    }),
  )

  test("selects the Meta prompt for Muse Spark model IDs", () => {
    for (const id of ["meta/muse-spark-preview", "muse-spark-1.1", "muse-spark-1.2"]) {
      const prompt = SystemPrompt.provider({ api: { id } } as Provider.Model)[0]
      expect(prompt).toContain("powered by Muse Spark,")
      expect(prompt).toContain("using Meta Muse Spark.")
      expect(prompt).not.toContain("{{MODEL_NAME}}")
    }
  })

  test("selects the Meta prompt for Muse Glimmer model IDs", () => {
    for (const id of ["meta/muse-glimmer", "meta/muse-glimmer-30b", "muse-glimmer-30b"]) {
      const prompt = SystemPrompt.provider({ api: { id } } as Provider.Model)[0]
      expect(prompt).toContain("powered by Muse Glimmer,")
      expect(prompt).toContain("using Meta Muse Glimmer.")
      expect(prompt).not.toContain("{{MODEL_NAME}}")
    }
  })

  test("selects the Kimi prompt for official provider model IDs", () => {
    for (const providerID of ["kimi-for-coding", "moonshotai", "moonshotai-cn"]) {
      const prompt = SystemPrompt.provider({ providerID, api: { id: "k3" } } as Provider.Model)[0]
      expect(prompt).toContain("# Prompt and Tool Use")
    }
  })

  it.effect("skills output is sorted by name and stable across calls", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const first = yield* prompt.skills(build)
      const second = yield* prompt.skills(build)
      const output = first ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing skills output" })))

      expect(first).toBe(second)

      const alpha = output.indexOf("<name>alpha-skill</name>")
      const middle = output.indexOf("<name>middle-skill</name>")
      const zeta = output.indexOf("<name>zeta-skill</name>")

      expect(alpha).toBeGreaterThan(-1)
      expect(middle).toBeGreaterThan(alpha)
      expect(zeta).toBeGreaterThan(middle)
      expect(output).not.toContain("manual-skill")
    }),
  )

  it.effect("MCP output includes connected server instructions", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.mcp(build)

      expect(output).toBe(
        [
          "<mcp_instructions>",
          '  <server name="guide-server">',
          "    Use lookup before mutate.",
          "  </server>",
          '  <server name="tool-server">',
          "    Prefer search before update.",
          "  </server>",
          "</mcp_instructions>",
        ].join("\n"),
      )
    }),
  )

  it.effect("MCP output omits servers when all advertised tools are denied", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.mcp(build, Permission.fromConfig({ "tool-server_*": "deny" }))

      expect(output).toBe(
        [
          "<mcp_instructions>",
          '  <server name="guide-server">',
          "    Use lookup before mutate.",
          "  </server>",
          "</mcp_instructions>",
        ].join("\n"),
      )
    }),
  )
})
