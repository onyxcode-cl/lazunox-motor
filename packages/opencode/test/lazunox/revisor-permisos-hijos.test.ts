// Lazunox (fix revisor 2): (1) con la sesión del padre acumulada en otro modo y luego «Todo sin preguntar», el revisor conservaba
// `bash *: deny` AL FINAL (tras los `ask` de git) y se quedaba sin shell; (2) el `external_directory: allow` heredado del padre dejaba
// leer fuera del proyecto a los agentes de solo lectura. Rulesets copiados de `rulesetForMode` de la app (`src/shared/permission-rules.ts`).
import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { Truncate } from "../../src/tool/truncate"
import { Global } from "@opencode-ai/core/global"
import { deriveSubagentSessionPermission } from "../../src/agent/subagent-permissions"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Agent.node, Plugin.node, Provider.node, Auth.node, Config.node, Skill.node, RuntimeFlags.node]),
    [[RuntimeFlags.node, RuntimeFlags.layer({})]],
  ),
)
afterEach(async () => {
  await disposeAllInstances()
})

type R = { permission: string; pattern: string; action: "allow" | "ask" | "deny" }
const r = (permission: string, pattern: string, action: R["action"]): R => ({ permission, pattern, action })
const readRules = [r("read", "*", "allow"), r("read", "*.env", "ask"), r("read", "*.env.*", "ask"), r("read", "*.env.example", "allow"), r("read", "mcp:*", "ask")]
const MARCAS = ["git branch", "git show", "git rev-parse", "git status", "git diff", "git log", "ls", "dir", "pwd", "Get-ChildItem", "Get-Location"]
const GIT_CFG = [".git/*", "*/.git/*", ".gitattributes", "*/.gitattributes", ".gitmodules", "*/.gitmodules"].flatMap((p) => [r("edit", p, "ask"), r("write", p, "ask")])
const BG = (deny: boolean) => [r("bgshell_start", "*", deny ? "deny" : "allow")]
const MODOS: Record<string, R[]> = {
  "Preguntar siempre": [...BG(true), r("edit", "*", "ask"), r("write", "*", "ask"), ...readRules, r("bash", "*", "ask"), r("webfetch", "*", "ask"), r("websearch", "*", "ask"), r("external_directory", "*", "ask"), r("task", "*", "ask")],
  "Editar sin preguntar": [...BG(true), r("edit", "*", "allow"), r("write", "*", "allow"), ...GIT_CFG, ...readRules, r("bash", "*", "ask"), r("webfetch", "*", "ask"), r("websearch", "*", "ask"), r("external_directory", "*", "ask"), r("task", "*", "allow")],
  "Solo explorar": [...BG(true), r("edit", "*", "deny"), r("edit", ".opencode/plans/*.md", "allow"), r("write", "*", "deny"), r("write", ".opencode/plans/*.md", "allow"), ...readRules, r("bash", "*", "ask"), ...MARCAS.map((c) => r("bash", `${c} *`, "ask")), r("webfetch", "*", "allow"), r("websearch", "*", "allow"), r("external_directory", "*", "ask"), r("task", "*", "ask"), r("task", "general", "deny")],
  "Automático": [...BG(true), r("edit", "*", "allow"), r("write", "*", "allow"), ...GIT_CFG, ...readRules, r("bash", "*", "ask"), ...[...MARCAS, "npm run", "npm test"].map((c) => r("bash", `${c} *`, "ask")), r("webfetch", "*", "ask"), r("websearch", "*", "ask"), r("external_directory", "*", "ask"), r("task", "*", "allow")],
  "Todo sin preguntar": [...BG(false), r("edit", "*", "allow"), r("write", "*", "allow"), r("read", "*", "allow"), r("bash", "*", "allow"), r("webfetch", "*", "allow"), r("websearch", "*", "allow"), r("external_directory", "*", "allow"), r("task", "*", "allow")],
}
// Sesiones: cada modo solo, y «Todo sin preguntar» tras cada otro modo (el motor acumula los bloques: caso real de la app).
const SESIONES: Record<string, R[]> = {
  ...MODOS,
  ...Object.fromEntries(Object.entries(MODOS).filter(([m]) => m !== "Todo sin preguntar").map(([m, b]) => [`${m} -> Todo sin preguntar`, [...b, ...MODOS["Todo sin preguntar"]!]])),
  "Todo sin preguntar -> Preguntar siempre -> Todo sin preguntar": [...MODOS["Todo sin preguntar"]!, ...MODOS["Preguntar siempre"]!, ...MODOS["Todo sin preguntar"]!],
}

const hija = (padre: Agent.Info, sub: Agent.Info, sesion: R[]) =>
  deriveSubagentSessionPermission({
    parentSessionPermission: sesion as any,
    parentAgentPermission: padre.permission,
    subagent: sub,
  })
const ev = (a: Agent.Info, hijaR: readonly any[], p: string, pat: string) => Permission.evaluate(p, pat, a.permission, hijaR).action

describe("revisor y verificador: permisos de la sesión hija con sesiones acumuladas", () => {
  for (const nombre of ["revisor", "verificador"]) {
    for (const [sesion, reglas] of Object.entries(SESIONES)) {
      it.instance(`${nombre} / ${sesion}: git diff ask, bash de lo demás deny, edit/write/task deny`, () =>
        Effect.gen(function* () {
          const agentes = yield* Agent.Service
          const a = (yield* agentes.get(nombre))!
          const build = (yield* agentes.get("build"))!
          const h = hija(build, a, reglas)
          expect(ev(a, h, "bash", "git diff")).toBe("ask")
          expect(ev(a, h, "bash", "git status --short")).toBe("ask")
          for (const o of ["rm -rf .", "git push", "curl http://x", "ls"]) expect(`${o} => ${ev(a, h, "bash", o)}`).toBe(`${o} => deny`)
          for (const p of ["edit", "write", "task", "webfetch", "websearch"]) expect(`${p} => ${ev(a, h, p, "x")}`).toBe(`${p} => deny`)
        }),
      )
    }
  }
})

describe("agentes de solo lectura: nunca external_directory en allow fuera del proyecto", () => {
  for (const nombre of ["revisor", "verificador", "explore"]) {
    for (const [sesion, reglas] of Object.entries(SESIONES)) {
      it.instance(`${nombre} / ${sesion}: fuera del proyecto ask/deny; Truncate.DIR sigue permitido`, () =>
        Effect.gen(function* () {
          const agentes = yield* Agent.Service
          const a = (yield* agentes.get(nombre))!
          const build = (yield* agentes.get("build"))!
          const h = hija(build, a, reglas)
          for (const p of ["/Users/x/.zsh_history", "/tmp/algo", "/private/tmp/x/y", "/Users/x/Library/Application Support/Lazunox/*"])
            expect(`${p} => ${["ask", "deny"].includes(ev(a, h, "external_directory", p)) ? "ok" : "ABIERTO"}`).toBe(`${p} => ok`)
          expect(ev(a, h, "external_directory", Truncate.GLOB)).toBe("allow")
          expect(ev(a, h, "external_directory", `${Truncate.DIR}/tool_abc`)).toBe("allow")
          expect(ev(a, h, "external_directory", `${Global.Path.tmp}/algo`)).toBe("allow")
        }),
      )
    }
  }

  it.instance("general y build NO cambian: siguen heredando external_directory allow del padre", () =>
    Effect.gen(function* () {
      const agentes = yield* Agent.Service
      const build = (yield* agentes.get("build"))!
      const general = (yield* agentes.get("general"))!
      const h = hija(build, general, SESIONES["Todo sin preguntar"]!)
      expect(ev(general, h, "external_directory", "/Users/x/.zsh_history")).toBe("allow")
      expect(h.at(-1)?.permission).not.toBe("external_directory")
    }),
  )
})
