// Lazunox R0: las instantáneas nunca deben borrar ni escribir lo que no les toca.
// Repositorio git temporal REAL (sin simular git): se poda de verdad con `git gc --prune=now`.
import { afterEach, describe, expect } from "bun:test"
import { $ } from "bun"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect, Exit, Layer } from "effect"
import { InstanceState } from "../../src/effect/instance-state"
import { Snapshot } from "../../src/snapshot"
import { Session } from "../../src/session/session"
import { SessionRevert } from "../../src/session/revert"
import { MessageID, PartID } from "../../src/session/schema"
import { disposeAllInstances, provideTmpdirInstance, testInstanceStoreLayer, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        Snapshot.node,
        FSUtil.node,
        Session.node,
        SessionRevert.node,
        SessionProjector.node,
        CrossSpawnSpawner.node,
      ]),
    ),
    testInstanceStoreLayer,
  ),
)

afterEach(async () => {
  await disposeAllInstances()
})

const write = (file: string, content: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, content)
  })
const readText = (file: string) => Effect.promise(() => fs.readFile(file, "utf8"))
const exists = (file: string) =>
  Effect.promise(() =>
    fs.lstat(file).then(
      () => true,
      () => false,
    ),
  )

/** Carpeta ajena al proyecto, con un archivo que NUNCA debe tocarse. */
const fuera = Effect.fn("fuera")(function* () {
  const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "lzx-fuera-")))
  yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })))
  const victim = path.join(dir, "victima.txt")
  yield* write(victim, "NO TOCAR")
  return { dir, victim }
})

const gitdirDeSnapshots = Effect.gen(function* () {
  const ctx = yield* InstanceState.context
  return path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(ctx.worktree))
})

describe("snapshot seguro (R0)", () => {
  it.instance(
    "un árbol podado por gc NO borra archivos: da error y deja todo como está",
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const snap = yield* Snapshot.Service
      yield* write(`${tmp.directory}/a.txt`, "A original")
      yield* write(`${tmp.directory}/b.txt`, "B original")
      const antes = yield* snap.track()
      expect(antes).toBeTruthy()
      // Lo que hizo el «turno»: cambiar uno y crear otro.
      yield* write(`${tmp.directory}/a.txt`, "A editado")
      yield* write(`${tmp.directory}/nuevo.txt`, "NUEVO")
      const patch = yield* snap.patch(antes!)
      expect(patch.files.length).toBe(2)

      // Pasan los 7 días: gc se lleva el árbol sin ref.
      const gitdir = yield* gitdirDeSnapshots
      yield* Effect.promise(() => $`git --git-dir ${gitdir} gc --prune=now`.quiet())
      const sigue = yield* Effect.promise(
        async () => (await $`git --git-dir ${gitdir} cat-file -e ${antes}`.quiet().nothrow()).exitCode === 0,
      )
      expect(sigue).toBe(false) // la prueba es válida solo si el objeto de verdad desapareció

      const exit = yield* snap.revert([patch]).pipe(Effect.exit)
      // Nada se borró ni se reescribió.
      expect(yield* exists(`${tmp.directory}/nuevo.txt`)).toBe(true)
      expect(yield* readText(`${tmp.directory}/a.txt`)).toBe("A editado")
      expect(yield* readText(`${tmp.directory}/nuevo.txt`)).toBe("NUEVO")
      expect(yield* readText(`${tmp.directory}/b.txt`)).toBe("B original")
      // Y el error es claro (no un éxito silencioso).
      expect(Exit.isFailure(exit)).toBe(true)
    }),
    { git: true },
  )

  it.instance(
    "un enlace simbólico intermedio no permite borrar fuera del proyecto",
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const snap = yield* Snapshot.Service
      const ext = yield* fuera()
      yield* write(`${tmp.directory}/a.txt`, "A")
      const antes = yield* snap.track()
      // El proyecto (o un comando) dejó `enlace` apuntando fuera.
      yield* Effect.promise(() => fs.symlink(ext.dir, `${tmp.directory}/enlace`))
      // Una lista de archivos manipulada (o un parche viejo) nombra un archivo «a través» del enlace.
      yield* snap.revert([{ hash: antes!, files: [`${tmp.directory}/enlace/victima.txt`] }])
      expect(yield* readText(ext.victim)).toBe("NO TOCAR")
    }),
    { git: true },
  )

  it.instance(
    "una ruta con .. o absoluta fuera del proyecto no borra nada",
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const snap = yield* Snapshot.Service
      const ext = yield* fuera()
      yield* write(`${tmp.directory}/a.txt`, "A")
      const antes = yield* snap.track()
      yield* snap.revert([
        { hash: antes!, files: [`${tmp.directory}/../${path.basename(ext.dir)}/victima.txt`, ext.victim] },
      ])
      expect(yield* readText(ext.victim)).toBe("NO TOCAR")
      expect(yield* exists(`${tmp.directory}/a.txt`)).toBe(true)
    }),
    { git: true },
  )

  it.instance(
    "nunca toca el .git del proyecto aunque venga en la lista",
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const snap = yield* Snapshot.Service
      yield* write(`${tmp.directory}/a.txt`, "A")
      const antes = yield* snap.track()
      yield* snap.revert([{ hash: antes!, files: [`${tmp.directory}/.git/HEAD`] }])
      expect(yield* exists(`${tmp.directory}/.git/HEAD`)).toBe(true)
    }),
    { git: true },
  )
})

// --- unrevert: solo los archivos del revert ---

const user = (sessionID: Session.Info["id"]) =>
  Session.Service.use((s) =>
    s.updateMessage({
      id: MessageID.ascending(),
      role: "user" as const,
      sessionID,
      agent: "default",
      model: { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-4") },
      time: { created: Date.now() },
    }),
  )

describe("unrevert (R0)", () => {
  it.live(
    "unrevert no pisa un archivo que la persona cambió y que el revert no tocó",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const snap = yield* Snapshot.Service
          const info = yield* session.create({})
          const sessionID = info.id

          yield* write(`${dir}/a.txt`, "A0")
          yield* write(`${dir}/x.txt`, "X0")
          const u = yield* user(sessionID)
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: u.id,
            sessionID,
            type: "text",
            text: "cambia a",
          })

          const antes = yield* snap.track()
          // El turno edita a.txt.
          yield* write(`${dir}/a.txt`, "A1")
          const patch = yield* snap.patch(antes!)
          const a = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "assistant" as const,
            sessionID,
            mode: "default",
            agent: "default",
            path: { cwd: dir, root: dir },
            cost: 0,
            tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ModelV2.ID.make("gpt-4"),
            providerID: ProviderV2.ID.make("openai"),
            parentID: u.id,
            time: { created: Date.now() },
            finish: "end_turn",
          })
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: a.id,
            sessionID,
            type: "patch",
            hash: patch.hash,
            files: patch.files,
          })

          yield* revert.revert({ sessionID, messageID: u.id })
          expect(yield* readText(`${dir}/a.txt`)).toBe("A0")

          // La persona toca OTRO archivo mientras el revert está pendiente.
          yield* write(`${dir}/x.txt`, "X-persona")
          yield* revert.unrevert({ sessionID })

          expect(yield* readText(`${dir}/a.txt`)).toBe("A1") // se rehizo lo del turno
          expect(yield* readText(`${dir}/x.txt`)).toBe("X-persona") // lo de la persona se respeta
        }),
      { git: true },
    ),
  )
})
