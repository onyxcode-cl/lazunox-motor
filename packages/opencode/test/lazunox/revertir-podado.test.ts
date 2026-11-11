// Lazunox (motor-18, F3): comprobación del defecto de OpenCode #54578 («Revertir» borra archivos cuando el árbol del punto de
// restauración ya no existe). En nuestro derivado `apply` comprueba primero que el árbol exista: si se podó, falla con
// ExpiredError y NO toca ningún archivo; y «no existía» solo se decide con un árbol legible.
import { afterEach, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Exit, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"
import { Snapshot } from "../../src/snapshot"
import { disposeAllInstances, testInstanceStoreLayer, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(LayerNode.compile(LayerNode.group([Snapshot.node, FSUtil.node])), testInstanceStoreLayer))
afterEach(async () => {
  await disposeAllInstances()
})

/** Lo que hace la limpieza con un punto viejo: los árboles no tienen refs, así que `gc --prune=now` los borra. */
function podar(worktree: string) {
  const root = path.join(Global.Path.data, "snapshot")
  const gitdir = fs
    .readdirSync(root)
    .flatMap((p) => [worktree, fs.realpathSync(worktree)].map((w) => path.join(root, p, Hash.fast(w))))
    .find((d) => fs.existsSync(d))
  if (!gitdir) throw new Error("no hay repositorio de fotos")
  const r = Bun.spawnSync({
    cmd: ["git", "--git-dir", gitdir, "gc", "--quiet", "--prune=now"],
    env: { PATH: process.env.PATH!, HOME: os.homedir(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
}

it.instance(
  "revertir con el punto podado: falla como caducado y no borra ni cambia archivos",
  () =>
    Effect.gen(function* () {
      const t = yield* TestInstance
      fs.writeFileSync(path.join(t.directory, "a.txt"), "a0")
      const snapshot = yield* Snapshot.Service
      const before = yield* snapshot.track()
      expect(before).toBeTruthy()
      fs.writeFileSync(path.join(t.directory, "a.txt"), "editado después")
      fs.writeFileSync(path.join(t.directory, "nuevo.txt"), "NUEVO")
      const patch = yield* snapshot.patch(before!)
      expect(patch.files.length).toBe(2)
      podar(t.directory)
      const exit = yield* Effect.exit(snapshot.revert([patch]))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(JSON.stringify(exit)).toContain("SnapshotExpiredError")
      expect(fs.readFileSync(path.join(t.directory, "a.txt"), "utf8")).toBe("editado después")
      expect(fs.readFileSync(path.join(t.directory, "nuevo.txt"), "utf8")).toBe("NUEVO")
    }),
  { git: true },
)

it.instance(
  "con el punto legible, sí borra lo que no existía y restaura lo demás",
  () =>
    Effect.gen(function* () {
      const t = yield* TestInstance
      fs.writeFileSync(path.join(t.directory, "a.txt"), "a0")
      const snapshot = yield* Snapshot.Service
      const before = yield* snapshot.track()
      fs.writeFileSync(path.join(t.directory, "a.txt"), "editado")
      fs.writeFileSync(path.join(t.directory, "nuevo.txt"), "NUEVO")
      yield* snapshot.revert([yield* snapshot.patch(before!)])
      expect(fs.existsSync(path.join(t.directory, "nuevo.txt"))).toBe(false)
      expect(fs.readFileSync(path.join(t.directory, "a.txt"), "utf8")).toBe("a0")
    }),
  { git: true },
)
