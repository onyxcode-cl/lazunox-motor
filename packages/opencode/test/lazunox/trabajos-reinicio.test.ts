import { afterEach, describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Layer } from "effect"
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { ShellTool, ShellWaitTool } from "../../src/tool/shell"
import { ShellBackground } from "../../src/tool/shell/background"
import { TrabajosDisco } from "../../src/tool/shell/trabajos-disco"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Plugin } from "../../src/plugin"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"

// Lazunox: marcadores en disco, huérfanos y lápidas de los trabajos en segundo plano.
const layer = Layer.mergeAll(
  LayerNode.compile(
    LayerNode.group([CrossSpawnSpawner.node, FSUtil.node, Plugin.node, Truncate.node, Config.node, Agent.node, RuntimeFlags.node]),
  ),
  testInstanceStoreLayer,
)
const it = testEffect(layer)
const posix = process.platform !== "win32"

const session = (id: string) => ({
  sessionID: SessionID.make(id),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})
const A = session("ses_a")
const B = session("ses_b")
const tools = Effect.gen(function* () {
  const shell = yield* (yield* ShellTool).init()
  const wait = yield* (yield* ShellWaitTool).init()
  return { shell, wait }
})
const inRoot = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    return yield* self.pipe(provideInstance(dir))
  })
const failure = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.exit,
    Effect.map((exit) => {
      if (Exit.isSuccess(exit)) throw new Error("se esperaba un fallo")
      const err = Cause.squash(exit.cause)
      return err instanceof Error ? err : new Error(String(err))
    }),
  )
const idOf = (output: string) => /shell_id=(sh_\w+)/.exec(output)?.[1]
const markerFile = (id: string) => path.join(TrabajosDisco.dir(), `${id}.json`)
const tombFile = (id: string) => path.join(TrabajosDisco.dir(), `${id}.perdido.json`)

const base = (over: Partial<TrabajosDisco.Marcador>): TrabajosDisco.Marcador => ({
  id: "sh_x",
  tipo: "shell",
  sessionID: "ses_a",
  directory: "/tmp/dir-a",
  pid: 0,
  enginePid: 0,
  cmdline: "",
  titulo: "t",
  inicio: 1,
  ...over,
})
const deadPid = () => {
  // Un pid que no existe: se lanza y espera un proceso corto.
  const r = Bun.spawnSync(["true"])
  return r.pid ?? 999_999
}

afterEach(() => TrabajosDisco.forgetSwept())

describe.skipIf(!posix)("marcadores de trabajos en disco", () => {
  it.live("el shell en segundo plano crea el marcador (0600) y lo borra al terminar", () =>
    inRoot(
      Effect.gen(function* () {
        const { shell, wait } = yield* tools
        const first = yield* shell.execute({ command: "sleep 3; echo fin", background: true, yield_ms: 1000 }, A)
        const id = idOf(first.output)!
        expect(fs.existsSync(markerFile(id))).toBe(true)
        expect((fs.statSync(markerFile(id)).mode & 0o777).toString(8)).toBe("600")
        const m = JSON.parse(fs.readFileSync(markerFile(id), "utf-8"))
        expect(m).toMatchObject({ id, tipo: "shell", sessionID: "ses_a", enginePid: process.pid })
        expect(m.pid).toBeGreaterThan(0)
        expect(m.cmdline.length).toBeGreaterThan(0)
        yield* wait.execute({ shell_id: id, yield_ms: 8000 }, A)
        expect(fs.existsSync(markerFile(id))).toBe(false)
      }),
    ),
  )

  it.live("terminate también borra el marcador", () =>
    inRoot(
      Effect.gen(function* () {
        const { shell, wait } = yield* tools
        const first = yield* shell.execute({ command: "sleep 300", background: true, yield_ms: 1000 }, A)
        const id = idOf(first.output)!
        expect(fs.existsSync(markerFile(id))).toBe(true)
        yield* wait.execute({ shell_id: id, terminate: true }, A)
        expect(fs.existsSync(markerFile(id))).toBe(false)
      }),
    ),
  )

  it.live("un huérfano vivo se mata solo si su línea de comandos coincide", () =>
    Effect.gen(function* () {
      const dir = "/tmp/lzx-huerfano-dir"
      const vivo = spawn("sleep", ["301"], { detached: true, stdio: "ignore" })
      const otro = spawn("sleep", ["302"], { detached: true, stdio: "ignore" })
      try {
        const cmd = TrabajosDisco.cmdlineOf(vivo.pid!)
        expect(cmd).toContain("sleep 301")
        // Coincide: se mata. No coincide (pid «reutilizado»): se deja vivo. Ambos dejan lápida.
        TrabajosDisco.writeMarker(base({ id: "sh_mata", directory: dir, pid: vivo.pid!, enginePid: deadPid(), cmdline: cmd }))
        TrabajosDisco.writeMarker(base({ id: "sh_nomata", directory: dir, pid: otro.pid!, enginePid: deadPid(), cmdline: "otro comando distinto" }))
        // Marcador de otro directorio: no se toca.
        TrabajosDisco.writeMarker(base({ id: "sh_otrodir", directory: "/tmp/otro", pid: deadPid(), enginePid: deadPid() }))
        const lost = TrabajosDisco.sweepOrphans(dir, new Set())
        expect(lost.map((l) => l.id).toSorted()).toEqual(["sh_mata", "sh_nomata"])
        yield* Effect.sleep("300 millis")
        expect(TrabajosDisco.alive(vivo.pid!) && vivo.exitCode === null && vivo.signalCode === null).toBe(false)
        expect(TrabajosDisco.alive(otro.pid!)).toBe(true)
        expect(fs.existsSync(tombFile("sh_mata"))).toBe(true)
        expect(fs.existsSync(tombFile("sh_nomata"))).toBe(true)
        expect(fs.existsSync(markerFile("sh_mata"))).toBe(false)
        expect(fs.existsSync(markerFile("sh_otrodir"))).toBe(true)
      } finally {
        for (const p of [vivo, otro]) {
          try {
            process.kill(-p.pid!, "SIGKILL")
          } catch {}
        }
        for (const id of ["sh_mata", "sh_nomata", "sh_otrodir"]) {
          fs.rmSync(markerFile(id), { force: true })
          fs.rmSync(tombFile(id), { force: true })
        }
      }
    }),
  )

  it.live("no toca los marcadores de un motor que sigue vivo ni los shells que este proceso tiene en marcha", () =>
    Effect.gen(function* () {
      const dir = "/tmp/lzx-vivo-dir"
      TrabajosDisco.writeMarker(base({ id: "sh_motorvivo", directory: dir, pid: deadPid(), enginePid: process.ppid }))
      TrabajosDisco.writeMarker(base({ id: "sh_enmarcha", directory: dir, pid: deadPid(), enginePid: process.pid }))
      TrabajosDisco.writeMarker(base({ id: "cm_miacelda", tipo: "celda", directory: dir, pid: process.pid, enginePid: process.pid }))
      const lost = TrabajosDisco.sweepOrphans(dir, new Set(["sh_enmarcha"]))
      expect(lost).toEqual([])
      for (const id of ["sh_motorvivo", "sh_enmarcha", "cm_miacelda"]) {
        expect(fs.existsSync(markerFile(id))).toBe(true)
        fs.rmSync(markerFile(id), { force: true })
      }
    }),
  )

  it.live("shell_wait con un id perdido: mensaje de reinicio solo para su sesión", () =>
    inRoot(
      Effect.gen(function* () {
        const { wait } = yield* tools
        TrabajosDisco.writeTombstone({ id: "sh_perdido1", tipo: "shell", sessionID: "ses_a", directory: "/x", titulo: "npm run dev", inicio: 1 })
        const mia = yield* failure(wait.execute({ shell_id: "sh_perdido1" }, A))
        expect(mia.message).toBe("El motor se reinició: el comando sh_perdido1 se perdió (lo que ya había hecho no se deshizo).")
        const ajena = yield* failure(wait.execute({ shell_id: "sh_perdido1" }, B))
        const nada = yield* failure(wait.execute({ shell_id: "sh_nunca" }, B))
        expect(ajena.message).toBe(nada.message.replace("sh_nunca", "sh_perdido1"))
        expect(ajena.message).not.toContain("reinició: el comando")
        // Un id con caracteres de ruta no sale del directorio de marcadores.
        const raro = yield* failure(wait.execute({ shell_id: "../sh_perdido1" }, A))
        expect(raro.message).not.toContain("reinició: el comando")
        fs.rmSync(tombFile("sh_perdido1"), { force: true })
      }),
    ),
  )

  it.live("el barrido al arrancar convierte un marcador huérfano en lápida que shell_wait explica", () =>
    inRoot(
      Effect.gen(function* () {
        const { wait } = yield* tools
        const directory = yield* InstanceState.directory
        TrabajosDisco.writeMarker(base({ id: "sh_huerfano9", sessionID: "ses_a", directory, pid: deadPid(), enginePid: deadPid(), titulo: "pnpm dev" }))
        // Sin lápida todavía: el primer shell_wait de la instancia hace el barrido y la encuentra.
        const err = yield* failure(wait.execute({ shell_id: "sh_huerfano9" }, A))
        expect(err.message).toContain("El motor se reinició: el comando sh_huerfano9 se perdió")
        expect(fs.existsSync(markerFile("sh_huerfano9"))).toBe(false)
        expect(fs.existsSync(tombFile("sh_huerfano9"))).toBe(true)
        const otra = yield* failure(wait.execute({ shell_id: "sh_huerfano9" }, B))
        expect(otra.message).not.toContain("reinició: el comando")
        fs.rmSync(tombFile("sh_huerfano9"), { force: true })
      }),
    ),
  )

  test("las lápidas caducan a la hora", () => {
    TrabajosDisco.writeTombstone({ id: "sh_vieja", tipo: "celda", sessionID: "ses_a", directory: "/x", titulo: "t", inicio: 1 }, Date.now() - TrabajosDisco.LAPIDA_TTL_MS - 1000)
    TrabajosDisco.writeTombstone({ id: "sh_nueva", tipo: "celda", sessionID: "ses_a", directory: "/x", titulo: "t", inicio: 1 })
    expect(TrabajosDisco.tombstoneFor("sh_vieja", "ses_a")).toBeUndefined()
    expect(fs.existsSync(tombFile("sh_vieja"))).toBe(false)
    expect(TrabajosDisco.tombstoneFor("sh_nueva", "ses_a")?.tipo).toBe("celda")
    expect(TrabajosDisco.tombstoneFor("sh_nueva", "ses_b")).toBeUndefined()
    TrabajosDisco.writeTombstone({ id: "sh_vieja2", tipo: "shell", sessionID: "ses_a", directory: "/x", titulo: "t", inicio: 1 }, 1)
    TrabajosDisco.pruneTombstones()
    expect(fs.existsSync(tombFile("sh_vieja2"))).toBe(false)
    fs.rmSync(tombFile("sh_nueva"), { force: true })
  })

  test("ids con caracteres de ruta se rechazan", () => {
    expect(TrabajosDisco.idValido("../etc")).toBe(false)
    expect(TrabajosDisco.idValido("sh_ok1")).toBe(true)
    expect(TrabajosDisco.writeMarker(base({ id: "../fuera" }))).toBe(false)
  })
})
