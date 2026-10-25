// Ayudantes de las pruebas de rebobinar: construyen turnos REALES (mensajes + instantáneas + parches) sobre un repo git temporal.
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { Snapshot } from "../../src/snapshot"
import { Session } from "../../src/session/session"
import { SessionSummary } from "../../src/session/summary"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"

export const escribir = (file: string, content: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, content)
  })
export const leer = (file: string) => Effect.promise(() => fs.readFile(file, "utf8"))
export const existe = (file: string) =>
  Effect.promise(() =>
    fs.lstat(file).then(
      () => true,
      () => false,
    ),
  )

export interface HerramientaFalsa {
  tool: string
  input: Record<string, unknown>
}

/**
 * Un turno completo: mensaje de la persona, `mutar` (lo que hace el «asistente» en disco), y un mensaje del
 * asistente con step-start / herramientas / patch / step-finish, como los deja el procesador. Luego `summarize`
 * (que crea los puntos de control).
 */
export const turno = Effect.fn("test.turno")(function* (input: {
  sessionID: SessionID
  dir: string
  texto?: string
  creado?: number
  herramientas?: HerramientaFalsa[]
  mutar: Effect.Effect<void, any, any>
  resumir?: boolean
}) {
  const sessions = yield* Session.Service
  const snap = yield* Snapshot.Service
  const summary = yield* SessionSummary.Service
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user" as const,
    sessionID: input.sessionID,
    agent: "default",
    model: { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-4") },
    time: { created: input.creado ?? Date.now() },
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: user.id,
    sessionID: input.sessionID,
    type: "text",
    text: input.texto ?? "haz algo",
  })
  const from = yield* snap.track()
  yield* input.mutar
  const patch = yield* snap.patch(from!)
  const to = yield* snap.track()
  const assistant = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "assistant" as const,
    sessionID: input.sessionID,
    mode: "default",
    agent: "default",
    path: { cwd: input.dir, root: input.dir },
    cost: 0,
    tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ModelV2.ID.make("gpt-4"),
    providerID: ProviderV2.ID.make("openai"),
    parentID: user.id,
    time: { created: input.creado ?? Date.now() },
    finish: "end_turn",
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID: input.sessionID,
    type: "step-start",
    snapshot: from,
  })
  for (const [index, item] of (input.herramientas ?? []).entries()) {
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: assistant.id,
      sessionID: input.sessionID,
      type: "tool",
      tool: item.tool,
      callID: `call-${index}`,
      state: { status: "completed", input: item.input, output: "", title: "", metadata: {}, time: { start: 0, end: 1 } },
    })
  }
  if (patch.files.length) {
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: assistant.id,
      sessionID: input.sessionID,
      type: "patch",
      hash: patch.hash,
      files: patch.files,
    })
  }
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID: input.sessionID,
    type: "step-finish",
    reason: "stop",
    snapshot: to,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  if (input.resumir !== false) yield* summary.summarize({ sessionID: input.sessionID, messageID: user.id })
  return { user, assistant, from: from!, to: to!, patch }
})

import { $ } from "bun"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"
import { InstanceState } from "../../src/effect/instance-state"

export const gitdirSnap = Effect.gen(function* () {
  const ctx = yield* InstanceState.context
  return path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(ctx.worktree))
})

/** git sobre el repositorio de instantáneas, tal cual (para comprobar de verdad qué sobrevive). */
export const gitSnap = (...args: string[]) =>
  Effect.gen(function* () {
    const gitdir = yield* gitdirSnap
    return yield* Effect.promise(async () => {
      const r = await $`git --git-dir ${gitdir} ${args}`.quiet().nothrow()
      return { code: r.exitCode, out: r.stdout.toString().trim() }
    })
  })

export const arbolExiste = (tree: string) => gitSnap("cat-file", "-e", `${tree}^{tree}`).pipe(Effect.map((r) => r.code === 0))

/** Variable de entorno solo durante `self`. */
export const conEntorno = <A, E, R>(vars: Record<string, string | undefined>, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previo: Record<string, string | undefined> = {}
      for (const [key, value] of Object.entries(vars)) {
        previo[key] = process.env[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      return previo
    }),
    () => self,
    (previo) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(previo)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }),
  )
