// Lazunox (motor-18, B): el git INTERNO del motor no ejecuta ganchos, filtros clean/smudge, fsmonitor, diff externo ni textconv que
// declare un repositorio o la config global. Repositorios de prueba en carpetas temporales propias; cada «trampa» solo agrega una línea a
// un archivo centinela neutro de la carpeta de prueba. Control: con LAZUNOX_GIT_SEGURO=0 la trampa SÍ salta (la prueba es real).
import { afterEach, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"
import * as GitSeguro from "@opencode-ai/core/git-seguro"
import { Snapshot } from "../../src/snapshot"
import { Git } from "../../src/git"
import { disposeAllInstances, testInstanceStoreLayer, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const posix = process.platform !== "win32"
const itSnap = testEffect(Layer.mergeAll(LayerNode.compile(LayerNode.group([Snapshot.node, FSUtil.node])), testInstanceStoreLayer))
const itGit = testEffect(LayerNode.compile(LayerNode.group([Git.node])))

const antes = { ...process.env }
afterEach(async () => {
  for (const k of Object.keys(process.env)) if (!(k in antes)) delete process.env[k]
  Object.assign(process.env, antes)
  GitSeguro._reiniciarCache()
  await disposeAllInstances()
})

/** Carpeta propia con el guion trampa (`marca.sh <qué>`: agrega una línea al centinela y deja pasar stdin). */
function trampa() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lzx-m18-trampa-"))
  const centinela = path.join(dir, "centinela.txt")
  const marca = path.join(dir, "marca.sh")
  fs.writeFileSync(marca, `#!/bin/sh\necho "$1" >> "${centinela}"\ncase "$1" in filtro-*) cat ;; esac\nexit 0\n`, { mode: 0o755 })
  const hooks = path.join(dir, "hooks")
  fs.mkdirSync(hooks)
  for (const h of ["post-index-change", "pre-commit", "post-checkout", "reference-transaction"])
    fs.writeFileSync(path.join(hooks, h), `#!/bin/sh\n"${marca}" gancho-${h} </dev/null >/dev/null\n`, { mode: 0o755 })
  const config = [
    `[filter "lzx"]`,
    `\tclean = '${marca}' filtro-clean`,
    `\tsmudge = '${marca}' filtro-smudge`,
    `[diff "lzx"]`,
    `\ttextconv = '${marca}' textconv`,
    `[diff]`,
    `\texternal = '${marca}' diff-externo`,
    `[core]`,
    `\thooksPath = ${hooks}`,
    `\tfsmonitor = '${marca}' fsmonitor`,
    "",
  ].join("\n")
  const marcas = () => (fs.existsSync(centinela) ? fs.readFileSync(centinela, "utf8").split("\n").filter(Boolean) : [])
  return { dir, centinela, marca, hooks, config, marcas }
}

/** git de la PRUEBA (no el del motor): sin config de sistema ni global, sin ganchos. */
function gitPrueba(cwd: string, args: string[]) {
  const r = Bun.spawnSync({
    cmd: ["git", "-c", "core.hooksPath=/dev/null", ...args],
    cwd,
    env: { PATH: process.env.PATH!, HOME: os.homedir(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`)
}

/** Carpeta del repositorio de fotos del motor para `worktree` (se crea con el primer `track`). */
function gitdirDeFotos(worktree: string) {
  const base = path.join(Global.Path.data, "snapshot")
  for (const w of new Set([worktree, fs.realpathSync(worktree)]))
    for (const p of fs.readdirSync(base)) {
      const d = path.join(base, p, Hash.fast(w))
      if (fs.existsSync(path.join(d, "HEAD"))) return d
    }
  throw new Error("no se encontró el repositorio de fotos")
}

const fotos = (apagado: boolean) =>
  Effect.gen(function* () {
    const t = trampa()
    if (apagado) process.env.LAZUNOX_GIT_SEGURO = "0"
    // Config global de la tarea (en la jaula es un archivo privado escribible) con la misma trampa.
    const global = path.join(t.dir, "gitconfig")
    fs.writeFileSync(global, t.config)
    process.env.GIT_CONFIG_GLOBAL = global
    GitSeguro._reiniciarCache()
    const tmp = yield* TestInstance
    fs.writeFileSync(path.join(tmp.directory, "a.txt"), "uno\n")
    fs.writeFileSync(path.join(tmp.directory, ".gitattributes"), "* filter=lzx diff=lzx\n")
    const snapshot = yield* Snapshot.Service
    const primera = yield* snapshot.track()
    expect(primera).toBeTruthy()
    // Ahora la tarea planta la trampa en el repositorio de fotos (config, info/attributes, ganchos).
    const gitdir = gitdirDeFotos(tmp.directory)
    fs.appendFileSync(path.join(gitdir, "config"), t.config)
    fs.mkdirSync(path.join(gitdir, "info"), { recursive: true })
    fs.writeFileSync(path.join(gitdir, "info", "attributes"), "* filter=lzx diff=lzx\n")
    for (const h of fs.readdirSync(t.hooks)) fs.copyFileSync(path.join(t.hooks, h), path.join(gitdir, "hooks", h))
    for (const h of fs.readdirSync(t.hooks)) fs.chmodSync(path.join(gitdir, "hooks", h), 0o755)
    fs.writeFileSync(path.join(tmp.directory, "a.txt"), "dos\n")
    fs.writeFileSync(path.join(tmp.directory, "b.txt"), "nuevo\n")
    const segunda = yield* snapshot.track()
    expect(segunda).toBeTruthy()
    const patch = yield* snapshot.patch(primera!)
    if (!apagado) expect(patch.files.length).toBeGreaterThan(0)
    yield* snapshot.diff(primera!)
    yield* snapshot.restore(primera!)
    if (!apagado) expect(fs.readFileSync(path.join(tmp.directory, "a.txt"), "utf8")).toBe("uno\n")
    return { marcas: t.marcas(), gitdir }
  })

if (posix) {
  itSnap.instance(
    "fotos (snapshot): con la trampa en la config global, la del repositorio de fotos, info/attributes, .gitattributes y ganchos, no salta nada",
    () =>
      Effect.gen(function* () {
        const r = yield* fotos(false)
        expect(r.marcas).toEqual([])
        // El motor volvió a dejar su config canónica y quitó info/attributes.
        expect(fs.readFileSync(path.join(r.gitdir, "config"), "utf8")).not.toContain("lzx")
        expect(fs.existsSync(path.join(r.gitdir, "info", "attributes"))).toBe(false)
      }),
    { git: true },
    30_000,
  )
  itSnap.instance(
    "control: con LAZUNOX_GIT_SEGURO=0 la misma trampa SÍ salta (filtro)",
    () =>
      Effect.gen(function* () {
        const r = yield* fotos(true)
        expect(r.marcas.some((m) => m.startsWith("filtro-"))).toBe(true)
      }),
    { git: true },
    30_000,
  )
}

const repoPersona = (apagado: boolean) =>
  Effect.gen(function* () {
    const t = trampa()
    if (apagado) process.env.LAZUNOX_GIT_SEGURO = "0"
    const repo = path.join(t.dir, "repo")
    fs.mkdirSync(repo)
    gitPrueba(repo, ["init", "-q"])
    fs.writeFileSync(path.join(repo, "a.txt"), "uno\n")
    fs.writeFileSync(path.join(repo, ".gitattributes"), "* filter=lzx diff=lzx\n")
    gitPrueba(repo, ["add", "."])
    gitPrueba(repo, ["-c", "user.name=p", "-c", "user.email=p@x.invalid", "commit", "-q", "-m", "x"])
    // La tarea planta la trampa en la config del repositorio y en sus ganchos; y en la config global.
    fs.appendFileSync(path.join(repo, ".git", "config"), t.config)
    for (const h of fs.readdirSync(t.hooks)) fs.copyFileSync(path.join(t.hooks, h), path.join(repo, ".git", "hooks", h))
    for (const h of fs.readdirSync(t.hooks)) fs.chmodSync(path.join(repo, ".git", "hooks", h), 0o755)
    const global = path.join(t.dir, "gitconfig")
    fs.writeFileSync(global, t.config)
    process.env.GIT_CONFIG_GLOBAL = global
    GitSeguro._reiniciarCache()
    fs.writeFileSync(path.join(repo, "a.txt"), "dos dos\n")
    const git = yield* Git.Service
    const estado = yield* git.status(repo)
    if (!apagado) expect(estado.length).toBeGreaterThan(0)
    yield* git.diff(repo, "HEAD")
    const p = yield* git.patchAll(repo, "HEAD")
    if (!apagado) expect(JSON.stringify(p)).toContain("a.txt")
    yield* git.show(repo, "HEAD", "a.txt")
    return t.marcas()
  })

if (posix) {
  itGit.live("estado y diff del repositorio de la persona: sin filtros, ganchos, fsmonitor, diff externo ni textconv", () =>
    Effect.gen(function* () {
      expect(yield* repoPersona(false)).toEqual([])
    }),
  )
  itGit.live("control: con LAZUNOX_GIT_SEGURO=0 la trampa SÍ salta", () =>
    Effect.gen(function* () {
      expect((yield* repoPersona(true)).length).toBeGreaterThan(0)
    }),
  )
}
