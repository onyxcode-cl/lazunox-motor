// Lazunox 2C (P08): modo plan para la app. Parte pura, permisos del agente `plan`, ayudantes y flujo completo con el proveedor falso.
import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Effect, Fiber, Layer } from "effect"
import path from "path"
import fsSync from "fs"
import osm from "os"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { deriveSubagentSessionPermission } from "../../src/agent/subagent-permissions"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import * as RutasProtegidas from "../../src/permission/rutas-protegidas"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "../../src/format"
import { InstanceState } from "@/effect/instance-state"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import {
  acotarTexto,
  aprobado,
  comandoDeSoloLectura,
  esAgenteDePlan,
  ENTRAR_OPCIONES,
  marcaModoPlan,
  MARCA_MODO_PLAN,
  PLAN_OPCIONES,
  planActivo,
  topeDeModoPlan,
} from "../../src/session/plan-modo"

// ---------------------------------------------------------------------------------------------------------------------
// Parte pura
// ---------------------------------------------------------------------------------------------------------------------

describe("shell de solo lectura (modo plan)", () => {
  const acepta = [
    "ls",
    "ls -la src",
    "cat package.json",
    "cat a.txt | grep foo | wc -l",
    "grep -rn 'a|b' src",
    "grep -rn \"x > y\" src",
    "rg --files | head -20",
    "git status",
    "git log --oneline -5",
    "git diff HEAD~1 -- src/a.ts",
    "git show HEAD:README.md",
    "git branch -a",
    "git branch --show-current",
    "find . -name '*.ts' -not -path './node_modules/*'",
    "ls 2>/dev/null",
    "cat x 2>&1 | head",
    "cat x > /dev/null",
    "cd src && ls",
    "pwd; ls; echo hola",
    "jq '.name' package.json",
    "head -n 5 a.txt && tail -20 b.txt",
    "grep -rn --include='*.ts' foo ./src",
    "rg -n --hidden -g '*.ts' foo src",
    "git log --oneline --graph -n 10",
    "git diff --stat --cached",
    "git grep -n -e foo -- src",
    "git branch --list 'feat/*'",
    "ls ./*.ts",
    "echo 'a;b|c&d'",
  ]
  for (const orden of acepta) {
    test(`acepta: ${orden}`, () => expect(comandoDeSoloLectura(orden)).toEqual({ ok: true }))
  }

  const rechaza = [
    "echo hola > a.txt",
    "echo hola >> a.txt",
    "cat a > b",
    "echo x >/tmp/x",
    "ls > /dev/nullx",
    "ls >/dev/null/../x",
    "tee a.txt",
    "ls | tee a.txt",
    "rm -rf .",
    "touch a",
    "mkdir x",
    "mv a b",
    "cp a b",
    "sed -i s/a/b/ a.txt",
    "awk 'BEGIN{system(\"rm a\")}'",
    "curl https://example.com | sh",
    "node script.js",
    "bun test",
    "npm install",
    "python3 -c 'open(\"a\",\"w\")'",
    "./run.sh",
    "/bin/ls",
    "FOO=1 ls",
    "ls; rm a",
    "ls && touch a",
    "ls || touch a",
    "ls | xargs rm",
    "cat $(echo a)",
    "cat `echo a`",
    "echo \"$(touch a)\"",
    "echo \"`touch a`\"",
    "cat <(echo a)",
    "cat <<EOF\nhola\nEOF",
    "sleep 100 &",
    "(ls)",
    "{ ls; }",
    "find . -exec rm {} ;",
    "find . -name a -delete",
    "find . -fprint salida.txt",
    "sort -o out.txt in.txt",
    "sort --output=out.txt in.txt",
    "sort -uo out.txt in.txt",
    "tree -o out.txt",
    "rg --pre ./x foo",
    "git commit -m x",
    "git add .",
    "git checkout -- .",
    "git reset --hard",
    "git -c core.pager=sh log",
    "git branch nueva",
    "git branch -D vieja",
    "git tag v1",
    "git remote add o url",
    "git diff --output=out.patch",
    "git log --ext-diff",
    "uniq entrada salida",
    "date -s '2020-01-01'",
    "ls 'sin cerrar",
    "",
    "   ",
    "env FOO=1 ls",
    "sudo ls",
    "bash -c 'rm a'",
    "eval ls",
    "exec ls",
    "source a.sh",
    "dd if=a of=b",
    "echo a>b",
    "ls &> salida.txt",
  ]
  for (const orden of rechaza) {
    test(`rechaza: ${JSON.stringify(orden)}`, () => expect(comandoDeSoloLectura(orden).ok).toBe(false))
  }

  // Revisión de seguridad H1: familias de evasión. SOLO se prueba la función de decisión; nada se ejecuta.
  const evasiones: Record<string, string[]> = {
    "sort y uniq ya no están (escriben con -o abreviado o con «-»)": [
      "sort --out=x a",
      "sort --outp=x a",
      "sort --output=x a",
      "sort -o x a",
      "sort a",
      "uniq - archivo",
      "uniq a b",
    ],
    "tree -H / -o": ["tree -H http://x .", "tree -o x", "tree"],
    "builtins que evalúan subíndices (printf -v, test -v, [ -v)": [
      "printf -v 'a[$(touch x)]' %s 1",
      "printf '%s' hola",
      "test -v 'a[$(touch x)]'",
      "[ -v 'a[$(touch x)]' ]",
      "test -f a",
    ],
    "git grep -O / --open-files-in-pager y abreviaturas": [
      "git grep -O foo",
      "git grep -Osh foo",
      "git grep --open-files-in-pager=sh foo",
      "git grep --open-files foo",
      "git grep --open foo",
    ],
    "rg que ejecuta programas": [
      "rg --hostname-bin=./x foo",
      "rg --hostname-bin ./x foo",
      "rg --hostname foo",
      "rg --pre=./x foo",
      "rg --pre ./x foo",
      "rg --pre-g=x foo",
      "rg -z foo",
      "rg --search-zip foo",
    ],
    "abreviaturas de opciones largas (GNU acepta prefijos)": [
      "grep --incl=x foo",
      "ls --al",
      "git log --out=x",
      "git diff --ext foo",
      "git log --no-ext foo",
      "cat --num a",
      "head --lin=3 a",
    ],
    "opciones de git globales y subcomandos": [
      "git -c core.pager=x log",
      "git -C . status",
      "git --exec-path=x status",
      "git log --output=x",
      "git diff --output x",
      "git show --ext-diff HEAD",
      "git diff --textconv",
      "git branch -m a b",
      "git branch nueva",
      "git branch -c a b",
      "git tag nuevo",
      "git config core.pager x",
    ],
    "opciones cortas desconocidas en un grupo": ["ls -lZ", "cat -nX a", "head -q -f a", "tail -f a", "wc -z a", "grep -rnO foo"],
    "otras formas de burlar el análisis": [
      "rg x $IFS--pre=cmd",
      "rg x a$IFS--pre=cmd",
      "ls $'\\x2do'",
      "ls $HOME",
      "rg x \\\n--pre=cmd",
      "rg x \"\\\n--pre=cmd\"",
      "rg foo *",
      "rg foo ?x",
      "cat <>archivo",
      "date 010100002030",
      "stat -f x",
    ],
  }
  for (const [familia, ordenes] of Object.entries(evasiones)) {
    for (const orden of ordenes) {
      test(`H1 rechaza (${familia}): ${JSON.stringify(orden)}`, () => expect(comandoDeSoloLectura(orden).ok).toBe(false))
    }
  }
  for (const shell of ["powershell", "pwsh", "cmd", "fish", "nu"]) {
    test(`H1 niega el shell ${shell} por completo (incluida una orden inocua y «\\»)`, () => {
      expect(comandoDeSoloLectura("ls", { shell }).ok).toBe(false)
      expect(comandoDeSoloLectura("Get-Content a.txt", { shell }).ok).toBe(false)
      expect(comandoDeSoloLectura("rg x a\\--pre=cmd", { shell }).ok).toBe(false)
    })
  }
  for (const shell of ["bash", "zsh", "sh"]) {
    test(`H1 el shell ${shell} sí se analiza`, () => {
      expect(comandoDeSoloLectura("ls -la", { shell })).toEqual({ ok: true })
      expect(comandoDeSoloLectura("ls --al", { shell }).ok).toBe(false)
    })
  }
  test("H1 en bash, «\\» sí escapa (el análisis coincide con el shell)", () => {
    expect(comandoDeSoloLectura("cat a\\ b", { shell: "bash" })).toEqual({ ok: true })
  })

  test("una orden enorme no se analiza", () => {
    expect(comandoDeSoloLectura("ls " + "a".repeat(5000)).ok).toBe(false)
  })
})

describe("decisión estricta y texto acotado", () => {
  test("solo la respuesta única y exacta aprueba", () => {
    expect(aprobado([[PLAN_OPCIONES.aprobar]], PLAN_OPCIONES.aprobar)).toBe(true)
    expect(aprobado([[PLAN_OPCIONES.seguir]], PLAN_OPCIONES.aprobar)).toBe(false)
    expect(aprobado([], PLAN_OPCIONES.aprobar)).toBe(false)
    expect(aprobado([[]], PLAN_OPCIONES.aprobar)).toBe(false)
    expect(aprobado(undefined, PLAN_OPCIONES.aprobar)).toBe(false)
    expect(aprobado([["Yes"]], PLAN_OPCIONES.aprobar)).toBe(false)
    expect(aprobado([[PLAN_OPCIONES.aprobar, PLAN_OPCIONES.seguir]], PLAN_OPCIONES.aprobar)).toBe(false)
    expect(aprobado([[PLAN_OPCIONES.aprobar], [PLAN_OPCIONES.aprobar]], PLAN_OPCIONES.aprobar)).toBe(false)
    expect(aprobado([[PLAN_OPCIONES.aprobar.toLowerCase()]], PLAN_OPCIONES.aprobar)).toBe(false)
    expect(aprobado([[ENTRAR_OPCIONES.entrar]], ENTRAR_OPCIONES.entrar)).toBe(true)
  })
  test("acotarTexto no parte caracteres", () => {
    const t = "ñ".repeat(100)
    const r = acotarTexto(t, 51)
    expect(r.truncado).toBe(true)
    expect(r.bytes).toBe(200)
    expect(Buffer.from(r.texto).length).toBeLessThanOrEqual(51)
    expect(r.texto).not.toContain("�")
    expect(acotarTexto("hola", 100)).toEqual({ texto: "hola", truncado: false, bytes: 4 })
  })
  test("la bandera se lee de LAZUNOX_PLAN", () => {
    expect(planActivo({})).toBe(false)
    expect(planActivo({ LAZUNOX_PLAN: "1" })).toBe(true)
    expect(planActivo({ LAZUNOX_PLAN: "0" })).toBe(false)
  })
})

describe("tope del modo plan para ayudantes", () => {
  const planReglas = [
    { permission: "*", pattern: "*", action: "allow" },
    { permission: "plan_exit", pattern: "*", action: "allow" },
    { permission: "edit", pattern: "*", action: "deny" },
    { permission: "edit", pattern: ".opencode/plans/*.md", action: "allow" },
  ]
  const buildReglas = [
    { permission: "*", pattern: "*", action: "allow" },
    { permission: "plan_enter", pattern: "*", action: "allow" },
  ]
  test("reconoce el agente de plan y no el de edición", () => {
    expect(esAgenteDePlan(planReglas)).toBe(true)
    expect(esAgenteDePlan(buildReglas)).toBe(false)
    expect(esAgenteDePlan(undefined)).toBe(false)
    // plan_exit permitido pero edición abierta: no es modo plan
    expect(esAgenteDePlan([{ permission: "plan_exit", pattern: "*", action: "allow" }])).toBe(false)
  })
  test("un padre en plan deja marca y sus reglas de edición; uno de edición no deja nada", () => {
    const t = topeDeModoPlan(planReglas, [])
    expect(t[0]).toEqual({ permission: MARCA_MODO_PLAN, pattern: "*", action: "allow" })
    expect(t.slice(1)).toEqual(planReglas.filter((r) => r.permission === "edit"))
    expect(topeDeModoPlan(buildReglas, [])).toEqual([])
    expect(topeDeModoPlan(undefined, [])).toEqual([])
  })
  test("la marca se propaga a los nietos", () => {
    const hija = topeDeModoPlan(planReglas, [])
    expect(marcaModoPlan(hija)).toBe(true)
    expect(topeDeModoPlan(buildReglas, hija).length).toBeGreaterThan(0)
    expect(marcaModoPlan([])).toBe(false)
  })
})

describe("rutas protegidas y archivo del plan", () => {
  const on = { LAZUNOX_PLAN: "1" } as NodeJS.ProcessEnv
  const pathm = path
  const crear = () => {
    const raiz = fsSync.mkdtempSync(pathm.join(osm.tmpdir(), "lzx-h4-"))
    fsSync.mkdirSync(pathm.join(raiz, ".opencode", "plans"), { recursive: true })
    return raiz
  }
  const limpiar = (r: string) => fsSync.rmSync(r, { recursive: true, force: true })
  test("con LAZUNOX_PLAN=1 y el agente plan, el plan no es ruta protegida, pero el resto de .opencode sí", () => {
    const raiz = crear()
    try {
      const o = { agente: "plan", raiz }
      expect(RutasProtegidas.esProtegida(".opencode/plans/1-abc.md", on, o)).toBe(false)
      // con «\\» solo es separador en Windows; en POSIX es un nombre raro y se pregunta
      expect(RutasProtegidas.esProtegida(".opencode\\plans\\1-abc.md", on, o)).toBe(path.sep === "/")
      expect(RutasProtegidas.esProtegida(".opencode/agents/x.md", on, o)).toBe(true)
      expect(RutasProtegidas.esProtegida(".opencode/plans/x.ts", on, o)).toBe(true)
      expect(RutasProtegidas.esProtegida(".opencode/plans/sub/x.md", on, o)).toBe(true)
      expect(RutasProtegidas.esProtegida(".opencode/plans/.md", on, o)).toBe(true)
      expect(RutasProtegidas.esProtegida(".opencode/opencode.json", on, o)).toBe(true)
      expect(RutasProtegidas.esProtegida("/otro/.opencode/plans/x.md", on, o)).toBe(true)
    } finally {
      limpiar(raiz)
    }
  })
  test("sin la bandera todo sigue protegido", () => {
    const raiz = crear()
    try {
      expect(RutasProtegidas.esProtegida(".opencode/plans/1-abc.md", {} as NodeJS.ProcessEnv, { agente: "plan", raiz })).toBe(true)
    } finally {
      limpiar(raiz)
    }
  })
  test("H4: otro agente (build, un ayudante) o sin contexto NO obtiene la excepción", () => {
    const raiz = crear()
    try {
      for (const agente of ["build", "explore", "general", "chat", "Plan", undefined])
        expect(RutasProtegidas.esProtegida(".opencode/plans/1-abc.md", on, { agente, raiz })).toBe(true)
      expect(RutasProtegidas.esProtegida(".opencode/plans/1-abc.md", on)).toBe(true)
      expect(RutasProtegidas.esProtegida(".opencode/plans/1-abc.md", on, { agente: "plan" })).toBe(true)
    } finally {
      limpiar(raiz)
    }
  })
  test("H4: .opencode/plans que es un enlace simbólico a otra carpeta pregunta como antes", () => {
    const raiz = fsSync.mkdtempSync(pathm.join(osm.tmpdir(), "lzx-h4-"))
    const fuera = fsSync.mkdtempSync(pathm.join(osm.tmpdir(), "lzx-h4-fuera-"))
    try {
      fsSync.mkdirSync(pathm.join(raiz, ".opencode"))
      fsSync.symlinkSync(fuera, pathm.join(raiz, ".opencode", "plans"), "dir")
      expect(RutasProtegidas.esProtegida(".opencode/plans/x.md", on, { agente: "plan", raiz })).toBe(true)
    } finally {
      limpiar(raiz)
      limpiar(fuera)
    }
  })
  test("H4: .opencode enlazado, plans enlazado a otra carpeta del proyecto o el .md enlazado hacia fuera: protegidos", () => {
    const raiz = crear()
    const fuera = fsSync.mkdtempSync(pathm.join(osm.tmpdir(), "lzx-h4-fuera-"))
    try {
      // el propio archivo del plan es un enlace a un archivo fuera
      fsSync.writeFileSync(pathm.join(fuera, "secreto.md"), "x")
      fsSync.symlinkSync(pathm.join(fuera, "secreto.md"), pathm.join(raiz, ".opencode", "plans", "enlace.md"))
      expect(RutasProtegidas.esProtegida(".opencode/plans/enlace.md", on, { agente: "plan", raiz })).toBe(true)
      // enlace roto
      fsSync.symlinkSync(pathm.join(fuera, "no-existe.md"), pathm.join(raiz, ".opencode", "plans", "roto.md"))
      expect(RutasProtegidas.esProtegida(".opencode/plans/roto.md", on, { agente: "plan", raiz })).toBe(true)
      // un archivo normal (aunque aún no exista) sigue exento
      expect(RutasProtegidas.esProtegida(".opencode/plans/nuevo.md", on, { agente: "plan", raiz })).toBe(false)
    } finally {
      limpiar(raiz)
      limpiar(fuera)
    }
    const raiz2 = fsSync.mkdtempSync(pathm.join(osm.tmpdir(), "lzx-h4-"))
    try {
      fsSync.mkdirSync(pathm.join(raiz2, "src"))
      fsSync.mkdirSync(pathm.join(raiz2, ".opencode"))
      fsSync.symlinkSync(pathm.join(raiz2, "src"), pathm.join(raiz2, ".opencode", "plans"), "dir")
      expect(RutasProtegidas.esProtegida(".opencode/plans/x.md", on, { agente: "plan", raiz: raiz2 })).toBe(true)
    } finally {
      limpiar(raiz2)
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Permisos reales del agente `plan` y de los ayudantes
// ---------------------------------------------------------------------------------------------------------------------

const itAgent = testEffect(LayerNode.compile(AgentSvc.node))

itAgent.instance("el agente plan solo edita .opencode/plans/*.md (también con rutas con ..)", () =>
  Effect.gen(function* () {
    const plan = yield* AgentSvc.use.get("plan")
    const ev = (p: string) => Permission.evaluate("edit", p, plan!.permission).action
    expect(ev(".opencode/plans/1-abc.md")).toBe("allow")
    expect(ev("src/index.ts")).toBe("deny")
    expect(ev("README.md")).toBe("deny")
    expect(ev(".opencode/agents/x.md")).toBe("deny")
    expect(ev(".opencode/plans/x.ts")).toBe("deny")
    expect(ev(".git/hooks/pre-commit")).toBe("deny")
    expect(ev("../fuera/x.md")).toBe("deny")
    // Las herramientas llaman a path.relative(), que ya normaliza los «..»: lo que llega nunca los trae.
    expect(path.relative("/p", path.resolve("/p", ".opencode/plans/../../src/a.md"))).toBe("src/a.md")
    expect(ev(path.relative("/p", path.resolve("/p", ".opencode/plans/../../src/a.md")))).toBe("deny")
    // plan_exit solo para plan; plan_enter solo para build
    const build = yield* AgentSvc.use.get("build")
    expect(Permission.evaluate("plan_exit", "*", plan!.permission).action).toBe("allow")
    expect(Permission.evaluate("plan_exit", "*", build!.permission).action).toBe("deny")
    expect(Permission.evaluate("plan_enter", "*", build!.permission).action).toBe("allow")
    expect(Permission.evaluate("plan_enter", "*", plan!.permission).action).toBe("deny")
    const explore = yield* AgentSvc.use.get("explore")
    expect(Permission.evaluate("plan_exit", "*", explore!.permission).action).toBe("deny")
    expect(Permission.evaluate("plan_enter", "*", explore!.permission).action).toBe("deny")
  }),
)

itAgent.instance("un ayudante lanzado desde plan hereda marca y tope de edición", () =>
  Effect.gen(function* () {
    const plan = yield* AgentSvc.use.get("plan")
    const explore = yield* AgentSvc.use.get("explore")
    const derivado = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      parentAgentPermission: plan!.permission,
      subagent: explore!,
    })
    expect(marcaModoPlan(derivado)).toBe(true)
    const efectivo = Permission.merge(explore!.permission, derivado)
    expect(Permission.evaluate("edit", "src/a.ts", efectivo).action).toBe("deny")
    expect(Permission.evaluate("edit", ".opencode/plans/x.md", efectivo).action).toBe("allow")

    // desde build no hay marca
    const build = yield* AgentSvc.use.get("build")
    const normal = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      parentAgentPermission: build!.permission,
      subagent: explore!,
    })
    expect(marcaModoPlan(normal)).toBe(false)
  }),
  {
    config: {
      agent: {
        escritor: { description: "agente de usuario", mode: "subagent", permission: { edit: "allow", bash: "allow" } },
      },
    },
  },
)

itAgent.instance("un agente de usuario con edit: allow lanzado desde plan sigue sin editar", () =>
  Effect.gen(function* () {
    const plan = yield* AgentSvc.use.get("plan")
    const escritor = yield* AgentSvc.use.get("escritor")
    const derivado = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      parentAgentPermission: plan!.permission,
      subagent: escritor!,
    })
    const efectivo = Permission.merge(escritor!.permission, derivado)
    expect(marcaModoPlan(derivado)).toBe(true)
    expect(Permission.evaluate("edit", "src/a.ts", efectivo).action).toBe("deny")
    expect(Permission.evaluate("edit", ".opencode/plans/x.md", efectivo).action).toBe("allow")
  }),
  {
    config: {
      agent: {
        escritor: { description: "agente de usuario", mode: "subagent", permission: { edit: "allow", bash: "allow" } },
      },
    },
  },
)

// ---------------------------------------------------------------------------------------------------------------------
// Herramientas registradas según la bandera
// ---------------------------------------------------------------------------------------------------------------------

const registryRoot = LayerNode.group([ToolRegistry.node, AgentSvc.node])
const regOn = testEffect(LayerNode.compile(registryRoot, [[RuntimeFlags.node, RuntimeFlags.layer({ lazunoxPlan: true })]]))
const regOnAcp = testEffect(
  LayerNode.compile(registryRoot, [[RuntimeFlags.node, RuntimeFlags.layer({ lazunoxPlan: true, client: "acp" })]]),
)
const regOff = testEffect(LayerNode.compile(registryRoot, [[RuntimeFlags.node, RuntimeFlags.layer()]]))
const regExperimental = testEffect(
  LayerNode.compile(registryRoot, [[RuntimeFlags.node, RuntimeFlags.layer({ experimentalPlanMode: true, lazunoxPlan: true })]]),
)

regOn.instance("con LAZUNOX_PLAN=1 el cliente de la app recibe plan_exit y plan_enter", () =>
  Effect.gen(function* () {
    const ids = yield* (yield* ToolRegistry.Service).ids()
    expect(ids).toContain("plan_exit")
    expect(ids).toContain("plan_enter")
  }),
)
regOnAcp.instance("otros clientes (acp) no los reciben", () =>
  Effect.gen(function* () {
    const ids = yield* (yield* ToolRegistry.Service).ids()
    expect(ids).not.toContain("plan_exit")
    expect(ids).not.toContain("plan_enter")
  }),
)
regOff.instance("sin la bandera no hay herramientas de plan (comportamiento de siempre)", () =>
  Effect.gen(function* () {
    const ids = yield* (yield* ToolRegistry.Service).ids()
    expect(ids).not.toContain("plan_exit")
    expect(ids).not.toContain("plan_enter")
  }),
)
regExperimental.instance("con la bandera experimental y la de Lazunox plan_exit no se duplica", () =>
  Effect.gen(function* () {
    const ids = yield* (yield* ToolRegistry.Service).ids()
    expect(ids.filter((id) => id === "plan_exit").length).toBe(1)
    expect(ids).toContain("plan_enter")
  }),
)

// ---------------------------------------------------------------------------------------------------------------------
// Flujo completo con el proveedor falso
// ---------------------------------------------------------------------------------------------------------------------

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const flujoRoot = LayerNode.group([
  LayerNode.group([
    SessionPrompt.node,
    Session.node,
    SessionProjector.node,
    MessageV2.node,
    Snapshot.node,
    LLM.node,
    Env.node,
    AgentSvc.node,
    Command.node,
    Permission.node,
    Plugin.node,
    Config.node,
    ProviderSvc.node,
    LSP.node,
    MCP.node,
    FSUtil.node,
    BackgroundJob.node,
    SessionStatus.node,
    SessionRunState.node,
    Database.node,
    EventV2Bridge.node,
    Question.node,
    Todo.node,
    ToolRegistry.node,
    Skill.node,
    Git.node,
    Ripgrep.node,
    Format.node,
    Truncate.node,
    SessionProcessor.node,
    Image.node,
    SessionCompaction.node,
    SessionRevert.node,
    Instruction.node,
    SystemPrompt.node,
    CrossSpawnSpawner.node,
    RuntimeFlags.node,
  ]),
  LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
])

const flujo = testEffect(
  LayerNode.compile(flujoRoot, [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, mcp],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true, lazunoxPlan: true })],
  ]),
)
// La excepción de rutas protegidas lee process.env (igual que en producción, donde bandera y variable son la misma).
const conEnvPlan = <A, E, R>(fx: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previo = process.env.LAZUNOX_PLAN
      process.env.LAZUNOX_PLAN = "1"
      return previo
    }),
    () => fx,
    (previo) =>
      Effect.sync(() => {
        if (previo === undefined) delete process.env.LAZUNOX_PLAN
        else process.env.LAZUNOX_PLAN = previo
      }),
  )
const unix = (name: string, fx: () => Effect.Effect<any, any, any>, ...rest: any[]) =>
  process.platform !== "win32" ? flujo.instance(name, () => conEnvPlan(fx()), ...rest) : flujo.instance.skip(name, fx, ...rest)

const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

const cfg = (url: string) => ({
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: url },
    },
  },
})

const userMsg = Effect.fn("modo-plan.user")(function* (sessionID: SessionID, agent: string, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent,
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({ id: PartID.ascending(), messageID: msg.id, sessionID, type: "text", text })
  return msg
})

const herramientas = Effect.fn("modo-plan.herramientas")(function* (sessionID: SessionID) {
  const msgs = yield* MessageV2.filterCompactedEffect(sessionID)
  return msgs.flatMap((m) =>
    m.parts.filter((p): p is SessionV1.ToolPart => p.type === "tool").map((p) => ({ agent: m.info.role === "assistant" ? m.info.agent : "", part: p })),
  )
})

const pendiente = Effect.gen(function* () {
  const q = yield* Question.Service
  const lista = yield* q.list()
  return lista.length > 0 ? lista[0] : undefined
})

const esperarPregunta = (sessionID: SessionID) =>
  pollWithTimeout(pendiente, "no apareció la pregunta del plan", "20 seconds").pipe(
    Effect.tapError(() =>
      herramientas(sessionID).pipe(
        Effect.tap((hs) =>
          Effect.sync(() =>
            console.error(
              "HERRAMIENTAS:",
              JSON.stringify(hs.map((h) => ({ a: h.agent, t: h.part.tool, s: h.part.state.status, e: (h.part.state as any).error, o: (h.part.state as any).output?.slice?.(0, 200) }))),
            ),
          ),
        ),
      ),
    ),
  )

unix(
  "modo plan: sin editar fuera del plan, shell de solo lectura, salir solo con aprobación explícita",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const llm = yield* TestLLMServer
      yield* (yield* FSUtil.Service).writeWithDirs(path.join(dir, "opencode.json"), JSON.stringify(cfg(llm.url)))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const events = yield* EventV2Bridge.Service
      const question = yield* Question.Service
      // Peor caso: la sesión tiene «todo permitido» (modo sin preguntar); el plan no debe abrirse por eso.
      const chat = yield* sessions.create({ title: "plan", permission: [{ permission: "*", pattern: "*", action: "allow" }] })
      const instance = yield* InstanceState.context
      const planFile = Session.plan(chat, instance)
      const evil = path.join(dir, "src", "evil.ts")
      const visto: Array<{ type: string; properties: any }> = []
      yield* events.listen((event) => {
        if (event.type.startsWith("session.plan.")) visto.push({ type: event.type, properties: (event as any).properties ?? (event as any).data })
        return Effect.void
      })

      yield* userMsg(chat.id, "plan", "planifica el cambio")

      // 1) plan_exit sin plan escrito -> error, no hay pregunta
      yield* llm.tool("plan_exit", {})
      // 2) escribir fuera del plan -> denegado, aunque la sesión permita todo
      yield* llm.tool("write", { filePath: evil, content: "export const x = 1\n" })
      // 3) shell que escribe -> rechazado; shell que lee -> ok
      yield* llm.tool("bash", { command: `echo hola > ${evil}`, description: "escribe" })
      yield* llm.tool("bash", { command: "ls", description: "lista" })
      // 4) escribir el plan -> ok
      yield* llm.tool("write", { filePath: planFile, content: "# Plan\n\n1. Hacer la cosa\n2. Probarla\n" })
      // 5) pedir salir: se queda esperando a la persona
      yield* llm.tool("plan_exit", {})
      yield* llm.text("sigo planificando")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      const q1 = yield* esperarPregunta(chat.id)
      const antes = yield* herramientas(chat.id)
      // Mientras la persona no decide: nada se editó y sigue siendo el agente plan
      expect(yield* (yield* FSUtil.Service).existsSafe(evil)).toBe(false)
      expect(visto.map((v) => v.type)).toContain("session.plan.listo")
      const listo = visto.find((v) => v.type === "session.plan.listo")!
      expect(listo.properties.contenido).toContain("Hacer la cosa")
      expect(listo.properties.ruta).toBe(path.relative(instance.worktree, planFile))
      expect(q1.questions[0]?.options.map((o) => o.label)).toEqual([PLAN_OPCIONES.aprobar, PLAN_OPCIONES.seguir])
      expect(q1.questions[0]?.custom).toBe(false)

      // Una respuesta que no es EXACTAMENTE «aprobar» no aprueba (aquí: seguir planificando)
      yield* question.reply({ requestID: q1.id, answers: [[PLAN_OPCIONES.seguir]] })
      yield* Fiber.await(fiber)

      const despues = yield* herramientas(chat.id)
      const por = (nombre: string) => despues.filter((h) => h.part.tool === nombre)
      const writes = por("write")
      expect(writes[0]?.part.state.status).toBe("error") // fuera del plan
      expect(writes[1]?.part.state.status).toBe("completed") // el plan
      const shells = por("bash")
      expect(shells[0]?.part.state.status).toBe("error")
      expect((shells[0]?.part.state as any).error).toContain("Modo plan")
      expect(shells[1]?.part.state.status).toBe("completed")
      expect(por("plan_exit")[0]?.part.state.status).toBe("error") // sin plan escrito todavía
      expect(yield* (yield* FSUtil.Service).existsSafe(evil)).toBe(false)
      expect(yield* (yield* FSUtil.Service).existsSafe(planFile)).toBe(true)
      expect(antes.length).toBeGreaterThan(0)

      // Sigue en modo plan: ningún mensaje del usuario con agente build
      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      expect(msgs.some((m) => m.info.role === "user" && m.info.agent === "build")).toBe(false)
      expect(visto.filter((v) => v.type === "session.plan.decidido").map((v) => v.properties.decision)).toEqual(["seguir"])
    }),
  { git: true },
  60_000,
)

unix(
  "modo plan: aprobar cambia a build con el plan y emite session.plan.decidido",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const llm = yield* TestLLMServer
      yield* (yield* FSUtil.Service).writeWithDirs(path.join(dir, "opencode.json"), JSON.stringify(cfg(llm.url)))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const events = yield* EventV2Bridge.Service
      const question = yield* Question.Service
      const chat = yield* sessions.create({ title: "plan" })
      const instance = yield* InstanceState.context
      const planFile = Session.plan(chat, instance)
      const decisiones: string[] = []
      yield* events.listen((event) => {
        if (event.type === "session.plan.decidido") decisiones.push(((event as any).properties ?? (event as any).data).decision)
        return Effect.void
      })
      yield* userMsg(chat.id, "plan", "planifica")
      yield* llm.tool("write", { filePath: planFile, content: "# Plan\n- paso 1\n" })
      yield* llm.tool("plan_exit", {})
      yield* llm.text("empiezo a editar")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      // El plan se escribe con la regla del agente (la sesión no abre nada): puede preguntar por permisos? no: está permitido
      const q = yield* esperarPregunta(chat.id)
      yield* question.reply({ requestID: q.id, answers: [[PLAN_OPCIONES.aprobar]] })
      yield* Fiber.await(fiber)

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const build = msgs.filter((m) => m.info.role === "user" && m.info.agent === "build")
      expect(build.length).toBe(1)
      expect(JSON.stringify(build[0]!.parts)).toContain(path.relative(instance.worktree, planFile))
      expect(decisiones).toEqual(["aprobado"])
      const ultimo = msgs.findLast((m) => m.info.role === "assistant")
      expect(ultimo?.info.role === "assistant" ? ultimo.info.agent : "").toBe("build")
    }),
  { git: true },
  60_000,
)

unix(
  "plan_enter: del agente de edición al plan solo si la persona acepta",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const llm = yield* TestLLMServer
      yield* (yield* FSUtil.Service).writeWithDirs(path.join(dir, "opencode.json"), JSON.stringify(cfg(llm.url)))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const question = yield* Question.Service
      const chat = yield* sessions.create({ title: "edicion" })
      yield* userMsg(chat.id, "build", "refactoriza todo")
      yield* llm.tool("plan_enter", {})
      yield* llm.text("planifico")
      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      const q = yield* esperarPregunta(chat.id)
      expect(q.questions[0]?.options.map((o) => o.label)).toEqual([ENTRAR_OPCIONES.entrar, ENTRAR_OPCIONES.seguir])
      yield* question.reply({ requestID: q.id, answers: [[ENTRAR_OPCIONES.entrar]] })
      yield* Fiber.await(fiber)
      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      expect(msgs.some((m) => m.info.role === "user" && m.info.agent === "plan")).toBe(true)
    }),
  { git: true },
  60_000,
)

unix(
  "un ayudante (explore) lanzado desde plan no escribe con el shell ni edita, aunque la sesión lo permita todo",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const llm = yield* TestLLMServer
      yield* (yield* FSUtil.Service).writeWithDirs(path.join(dir, "opencode.json"), JSON.stringify(cfg(llm.url)))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "plan", permission: [{ permission: "*", pattern: "*", action: "allow" }] })
      const evil = path.join(dir, "evil-hijo.txt")
      yield* userMsg(chat.id, "plan", "explora")
      yield* llm.tool("task", { description: "explorar", prompt: "mira el proyecto", subagent_type: "explore" })
      // turnos del ayudante: shell que escribe, shell que lee
      yield* llm.tool("bash", { command: `echo hola > ${evil}`, description: "escribe" })
      yield* llm.tool("bash", { command: "ls", description: "lista" })
      yield* llm.text("informe del ayudante")
      yield* llm.text("fin")
      yield* prompt.loop({ sessionID: chat.id })
      expect(yield* (yield* FSUtil.Service).existsSafe(evil)).toBe(false)
      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(marcaModoPlan(kids[0]!.permission ?? [])).toBe(true)
      const hs = yield* herramientas(kids[0]!.id)
      const shells = hs.filter((h) => h.part.tool === "bash")
      expect(shells[0]?.part.state.status).toBe("error")
      expect((shells[0]?.part.state as any).error).toContain("Modo plan")
      expect(shells[1]?.part.state.status).toBe("completed")
    }),
  { git: true },
  60_000,
)
