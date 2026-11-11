// Lazunox (motor-18, A): ningún proceso hijo del motor ve las variables del motor. Hijos REALES que vuelcan los NOMBRES de su entorno
// (nunca los valores). Centinela inventada: LAZUNOX_CENTINELA (y otras con forma de secreto). Con LAZUNOX_ENTORNO_LIMPIO=0, lo de antes.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppProcess } from "@opencode-ai/core/process"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Layer } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { NodeFileSystem } from "@effect/platform-node"
import {
  OCULTAS_DEL_MOTOR,
  entornoLimpio,
  entornoLimpioActivo,
  entornoParaHijo,
  nombreOculto,
} from "@opencode-ai/core/entorno-limpio"
import { ejecutar } from "../../src/plugin/lazunox-ganchos"
import { arrancar } from "../../src/lsp/estable"
import { spawn as lspspawn } from "../../src/lsp/launch"
import { Process } from "../../src/util/process"
import { Format } from "../../src/format"
import { MCP } from "../../src/mcp"
import { Config } from "@/config/config"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { Plugin } from "../../src/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ShellTool } from "../../src/tool/shell"
import { SessionID, MessageID } from "../../src/session/schema"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const volcado = path.join(import.meta.dir, "../fixture/entorno-volcado.js")
const node = process.execPath

// Huella de HIDDEN_SHELL_ENV de la app (src/main/tasks/hidden-env.ts). Si la app cambia su lista, esta prueba avisa.
const HUELLA_APP = "17e22ffdd0284dd3b7ce57ed87a86479a043f372d0be910e511fd92a41f39b19"
const huella = (l: readonly string[]) => createHash("sha256").update([...l].sort().join("\n")).digest("hex")

// Valores inventados: nunca claves reales.
const SECRETOS: Record<string, string> = {
  LAZUNOX_CENTINELA: "centinela-inventada",
  OPENCODE_SERVER_PASSWORD: "no-se-imprime",
  OPENCODE_SERVER_USERNAME: "u",
  OPENCODE_CONFIG_CONTENT: "{}",
  OPENCODE_AUTH_CONTENT: "{}",
  OPENCODE_CUALQUIERA: "1",
  LAZUNOX_GUARD_TOKEN: "t",
  LAZUNOX_GUARD_URL: "http://127.0.0.1:1/x",
  LAZUNOX_PLAN_GATE_URL: "http://127.0.0.1:1/y",
  LAZUNOX_PERMISSION_DIR: "/tmp/x",
  SERVICIO_PRUEBA_API_KEY: "k",
  OTRO_SERVICIO_TOKEN: "t",
}
// Lo que la app pasa A PROPÓSITO para los comandos de la persona: DEBE llegar.
const A_PROPOSITO: Record<string, string> = {
  LAZUNOX_PYTHON: "/p",
  LAZUNOX_BIN_DIR: "/b",
  MI_VAR: "propia",
}
const OCULTOS = Object.keys(SECRETOS)

const antes = { ...process.env }
beforeEach(() => {
  Object.assign(process.env, SECRETOS, A_PROPOSITO)
  delete process.env.LAZUNOX_ENTORNO_LIMPIO
})
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in antes)) delete process.env[k]
  Object.assign(process.env, antes)
})

const nombresDe = (salida: string): string[] => {
  const l = salida.split("\n").find((x) => x.startsWith("NOMBRES:"))
  if (!l) throw new Error("el hijo no volcó su entorno: " + salida.slice(0, 200))
  return JSON.parse(l.slice("NOMBRES:".length))
}
/** «Encendido»: ni una oculta; sí PATH, HOME y lo que la app pasa a propósito. */
function limpio(n: string[]) {
  for (const k of OCULTOS) expect(n).not.toContain(k)
  expect(n.filter((x) => x.startsWith("OPENCODE_SERVER_") || x === "OPENCODE_CONFIG_CONTENT")).toEqual([])
  for (const k of ["PATH", "HOME", ...Object.keys(A_PROPOSITO)]) expect(n).toContain(k)
}
function sucio(n: string[]) {
  for (const k of OCULTOS) expect(n).toContain(k)
}
const archivoTmp = (nombre: string) => path.join(os.tmpdir(), `lzx-m18-${nombre}-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
const esperarArchivo = async (f: string) => {
  for (let i = 0; i < 100 && !fs.existsSync(f); i++) await new Promise((r) => setTimeout(r, 50))
  const n = JSON.parse(fs.readFileSync(f, "utf8")) as string[]
  fs.rmSync(f, { force: true })
  return n
}

describe("regla", () => {
  test("la lista de la app está incluida (huella) y la cubren las familias", () => {
    expect(huella(OCULTAS_DEL_MOTOR)).toBe(HUELLA_APP)
    for (const k of OCULTAS_DEL_MOTOR) expect(nombreOculto(k)).toBe(true)
  })
  test("familias OPENCODE_*/LAZUNOX_*, credenciales y excepciones a propósito", () => {
    for (const k of ["OPENCODE_X", "opencode_server_password", "LAZUNOX_CENTINELA", "LAZUNOX_SANDBOX", "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
      "GEMINI_API_KEY", "AWS_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "GITHUB_TOKEN", "HF_TOKEN",
      "GOOGLE_APPLICATION_CREDENTIALS", "MI_SECRET", "DB_PASSWORD", "X_APIKEY", "ALGO_PRIVATE_KEY"])
      expect([k, nombreOculto(k)]).toEqual([k, true])
    for (const k of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM", "HTTP_PROXY", "https_proxy", "NO_PROXY", "NODE_USE_ENV_PROXY",
      "XDG_CONFIG_HOME", "GIT_AUTHOR_NAME", "SSH_AUTH_SOCK", "LAZUNOX_PYTHON", "LAZUNOX_BIN_DIR", "LAZUNOX_NODE", "LAZUNOX_CHROMIUM",
      "LAZUNOX_DECKCRAFT", "LAZUNOX_WORDCRAFT", "LAZUNOX_GRIDCRAFT", "TOKENIZERS_PARALLELISM", "KEYTIMEOUT", "SystemRoot", "PATHEXT"])
      expect([k, nombreOculto(k)]).toEqual([k, false])
  })
  test("proxies y XDG del arranque llegan al hijo (Bun no enumera un HTTP_PROXY puesto en caliente: se prueba con un proceso nuevo)", () => {
    const r = Bun.spawnSync({
      cmd: [node, "-e", `import { entornoParaHijo } from "@opencode-ai/core/entorno-limpio"; console.log(Object.keys(entornoParaHijo(undefined, true)).sort().join(","))`],
      cwd: path.join(import.meta.dir, "../.."),
      env: { PATH: process.env.PATH!, HOME: os.homedir(), HTTP_PROXY: "http://127.0.0.1:9/", https_proxy: "http://127.0.0.1:9/", NO_PROXY: "localhost",
        NODE_USE_ENV_PROXY: "1", XDG_CONFIG_HOME: "/tmp/xdg", LANG: "es_CL.UTF-8", LC_ALL: "es_CL.UTF-8", LAZUNOX_CENTINELA: "x", OPENCODE_SERVER_PASSWORD: "x" },
    })
    const n = r.stdout.toString().trim().split(",")
    for (const k of ["HTTP_PROXY", "https_proxy", "NO_PROXY", "NODE_USE_ENV_PROXY", "XDG_CONFIG_HOME", "LANG", "LC_ALL", "PATH", "HOME"]) expect(n).toContain(k)
    expect(n).not.toContain("LAZUNOX_CENTINELA")
    expect(n).not.toContain("OPENCODE_SERVER_PASSWORD")
  })
  test("H: por nombre (forma de secreto) y por VALOR, con excepciones y variables del proyecto", () => {
    const base: Record<string, string> = {
      PATH: "/bin",
      INOCENTE_A: "ghp_" + "a".repeat(36),
      INOCENTE_B: "-----BEGIN OPENSSH PRIVATE KEY-----\nxx",
      INOCENTE_C: "AKIA" + "B".repeat(16),
      INOCENTE_D: "postgres://usuario:clave@db.invalid/x",
      INOCENTE_E: "xoxb-" + "1".repeat(12),
      INOCENTE_F: "sk-ant-" + "c".repeat(30),
      INOCENTE_G: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijklmn",
      NORMAL: "hola mundo",
      DB_PASSWORD: "x",
      MYPASSWORD: "x",
      NPM_AUTH: "x",
      GPG_KEY: "x",
      SSH_AUTH_SOCK: "/tmp/agent",
      GPG_TTY: "/dev/ttys001",
      HTTP_PROXY: "http://lzx:tok@127.0.0.1:9",
      https_proxy: "http://lzx:tok@127.0.0.1:9",
      SSL_CERT_FILE: "/c.pem",
      NODE_EXTRA_CA_CERTS: "/c.pem",
      XDG_CONFIG_HOME: "/x",
      MI_TOKEN_PROYECTO: "ghp_" + "z".repeat(36),
      LAZUNOX_VARIABLES_PROYECTO: "MI_TOKEN_PROYECTO",
    }
    const n = Object.keys(entornoLimpio(base, base)).sort()
    expect(n).toEqual(
      ["GPG_TTY", "HTTP_PROXY", "MI_TOKEN_PROYECTO", "NODE_EXTRA_CA_CERTS", "NORMAL", "PATH", "SSH_AUTH_SOCK", "SSL_CERT_FILE",
        "XDG_CONFIG_HOME", "https_proxy"].sort(),
    )
  })
  test("bandera: ausente = encendido; apagan 0, off, false", () => {
    expect(entornoLimpioActivo({})).toBe(true)
    expect(entornoLimpioActivo({ LAZUNOX_ENTORNO_LIMPIO: "1" })).toBe(true)
    for (const v of ["0", "off", "false", "OFF", " False "]) expect(entornoLimpioActivo({ LAZUNOX_ENTORNO_LIMPIO: v })).toBe(false)
  })
  test("entornoParaHijo: extras explícitos se respetan; copias secretas del motor no; apagado = lo de antes", () => {
    const base = { PATH: "/bin", LAZUNOX_GUARD_TOKEN: "t", OPENCODE_SERVER_PASSWORD: "p", LAZUNOX_PYTHON: "/p" }
    expect(entornoParaHijo({ LAZUNOX_HOOK: "1", OPENCODE_SERVER_PASSWORD: "" }, true, base)).toEqual({
      PATH: "/bin",
      LAZUNOX_PYTHON: "/p",
      LAZUNOX_HOOK: "1",
      OPENCODE_SERVER_PASSWORD: "",
    })
    // `{...process.env, X}` explícito: la copia secreta se quita igual.
    expect(entornoParaHijo({ ...base, X: "1" }, false, base)).toEqual({ PATH: "/bin", LAZUNOX_PYTHON: "/p", X: "1" })
    expect(entornoParaHijo({ X: "1" }, true, { ...base, LAZUNOX_ENTORNO_LIMPIO: "0" })).toEqual({
      ...base,
      LAZUNOX_ENTORNO_LIMPIO: "0",
      X: "1",
    })
    expect(entornoLimpio(base, { LAZUNOX_ENTORNO_LIMPIO: "0" })).toEqual(base)
  })
})

describe("spawner de core (git, ripgrep, formateadores, `!cmd` de la sesión, guion del worktree, instalación)", () => {
  const it = testEffect(LayerNode.compile(LayerNode.group([AppProcess.node, CrossSpawnSpawner.node])))
  const correr = (opts: { env?: Record<string, string>; extendEnv?: boolean }) =>
    Effect.gen(function* () {
      const p = yield* AppProcess.Service
      const r = yield* p.run(ChildProcess.make(node, [volcado], { ...opts, stdin: "ignore" }))
      return nombresDe(r.stdout.toString("utf8"))
    })
  it.live("extendEnv: true (forma de git/rg/formateador/worktree): sin ocultas, con PATH/HOME", () =>
    Effect.gen(function* () {
      limpio(yield* correr({ extendEnv: true }))
    }),
  )
  it.live("sin env ni extendEnv (Node heredaría todo): igual de limpio", () =>
    Effect.gen(function* () {
      limpio(yield* correr({}))
    }),
  )
  it.live("env explícito con {...process.env} (forma del shell): la copia secreta se quita", () =>
    Effect.gen(function* () {
      const n = yield* correr({ env: { ...(process.env as Record<string, string>), EXTRA: "1" }, extendEnv: false })
      expect(n).toContain("EXTRA")
      limpio(n)
    }),
  )
  it.live("apagado (LAZUNOX_ENTORNO_LIMPIO=0): vuelve la herencia completa", () =>
    Effect.gen(function* () {
      process.env.LAZUNOX_ENTORNO_LIMPIO = "0"
      sucio(yield* correr({ extendEnv: true }))
    }),
  )
})

describe("ganchos", () => {
  const cmd = `"${node}" "${volcado}"`
  test("el gancho no ve las ocultas; sí PATH/HOME y LAZUNOX_HOOK", async () => {
    const n = nombresDe((await ejecutar({ command: cmd }, {}, os.tmpdir())).stdout)
    expect(n).toContain("LAZUNOX_HOOK")
    limpio(n)
  })
  test("apagado: vuelven", async () => {
    process.env.LAZUNOX_ENTORNO_LIMPIO = "0"
    sucio(nombresDe((await ejecutar({ command: cmd }, {}, os.tmpdir())).stdout))
  })
})

describe("LSP", () => {
  const leer = (p: ReturnType<typeof lspspawn>) =>
    new Promise<string>((resolve) => {
      let out = ""
      p.stdout.on("data", (d) => (out += d))
      p.on("close", () => resolve(out))
    })
  test("modo estable (`arrancar`): sin ocultas; el extra explícito llega", async () => {
    const f = archivoTmp("lsp")
    const p = arrancar(node, [volcado], os.tmpdir(), [], { LZX_OUT: f, MI_EXTRA: "1" })
    await new Promise((r) => p.on("close", r))
    const n = await esperarArchivo(f)
    expect(n).toContain("MI_EXTRA")
    limpio(n)
  })
  test("LSP de la config (`env` propio, camino de lsp.ts): sin ocultas; lo de la config gana", async () => {
    const n = nombresDe(await leer(lspspawn(node, [volcado], { cwd: os.tmpdir(), env: { MI_CONFIG: "1" } })))
    expect(n).toContain("MI_CONFIG")
    limpio(n)
  })
  test("LSP de fábrica con {...entorno} (server.ts) y sin env: sin ocultas", async () => {
    limpio(nombresDe(await leer(lspspawn(node, [volcado], { cwd: os.tmpdir() }))))
    limpio(nombresDe(await leer(lspspawn(node, [volcado], { cwd: os.tmpdir(), env: { ...process.env, GOBIN: "/x" } }))))
  })
})

describe("`!cmd` de los comandos .md (Process.text con shell)", () => {
  test("sin ocultas; con PATH/HOME", async () => {
    const r = await Process.text([`"${node}" "${volcado}"`], { shell: true, nothrow: true })
    limpio(nombresDe(r.text))
  })
  test("apagado: vuelven", async () => {
    process.env.LAZUNOX_ENTORNO_LIMPIO = "0"
    sucio(nombresDe((await Process.text([node, volcado], { nothrow: true })).text))
  })
})

describe("formateadores", () => {
  const it = testEffect(
    Layer.mergeAll(LayerNode.compile(LayerNode.group([Format.node, CrossSpawnSpawner.node])), NodeFileSystem.layer),
  )
  const salida = archivoTmp("fmt")
  const cfg = {
    formatter: {
      volcar: {
        command: [node, volcado, "$FILE"],
        extensions: [".volcar"],
        environment: { LZX_OUT: salida, MI_FORMATEADOR: "1" },
      },
    },
  }
  it.instance(
    "no ve las ocultas; conserva PATH/HOME y su `environment`",
    () =>
      Effect.gen(function* () {
        const t = yield* TestInstance
        const file = `${t.directory}/a.volcar`
        fs.writeFileSync(file, "x")
        yield* Format.Service.use((fmt) =>
          Effect.gen(function* () {
            yield* fmt.init()
            yield* fmt.file(file)
          }),
        )
        const n = yield* Effect.promise(() => esperarArchivo(salida))
        expect(n).toContain("MI_FORMATEADOR")
        limpio(n)
      }),
    { config: cfg },
  )
})

describe("MCP local (stdio)", () => {
  const it = testEffect(Layer.mergeAll(LayerNode.compile(LayerNode.group([MCP.node])), testInstanceStoreLayer))
  const salida = archivoTmp("mcp")
  it.instance(
    "el servidor MCP no ve las ocultas; sí PATH/HOME y su `environment`",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        yield* mcp.connect("volcar").pipe(Effect.ignore)
        const n = yield* Effect.promise(() => esperarArchivo(salida))
        expect(n).toContain("MI_MCP")
        limpio(n)
      }),
    {
      config: {
        mcp: {
          volcar: {
            type: "local",
            command: [node, volcado],
            environment: { LZX_OUT: salida, MI_MCP: "1" },
            enabled: false,
            timeout: 2000,
          },
        },
      },
    },
  )
})

describe("shell del modelo (con el complemento de la app intacto)", () => {
  const it = testEffect(
    Layer.mergeAll(
      LayerNode.compile(
        LayerNode.group([CrossSpawnSpawner.node, FSUtil.node, Plugin.node, Truncate.node, Config.node, Agent.node, RuntimeFlags.node]),
      ),
      testInstanceStoreLayer,
    ),
  )
  const ctx = {
    sessionID: SessionID.make("ses_test"),
    messageID: MessageID.make("msg_test"),
    callID: "",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
  const volcar = (dir: string) =>
    Effect.gen(function* () {
      const info = yield* ShellTool
      const tool = yield* info.init()
      const r = yield* tool.execute(
        { command: `"${node.replaceAll("\\", "/")}" "${volcado.replaceAll("\\", "/")}"` },
        ctx,
      )
      return nombresDe(r.output)
    }).pipe(provideInstance(dir))
  it.live("el comando no ve las ocultas; sí PATH/HOME y LAZUNOX_PYTHON/BIN_DIR", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      limpio(yield* volcar(dir))
    }),
  )
  it.live("apagado: vuelven", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      process.env.LAZUNOX_ENTORNO_LIMPIO = "0"
      sucio(yield* volcar(dir))
    }),
  )
})

describe("`$` de Bun para complementos", () => {
  test("no ve las ocultas", async () => {
    const { shellLimpio } = await import("../../src/plugin")
    const sh = shellLimpio() as typeof Bun.$
    limpio(nombresDe(await sh`${node} ${volcado}`.text()))
  })
})
