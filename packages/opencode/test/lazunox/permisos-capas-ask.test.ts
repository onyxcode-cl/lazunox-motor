// Lazunox (lazunox.16, B1): `Permission.ask` con capas (LAZUNOX_PERMISOS_CAPAS=1): un `deny` del piso gana a las reglas de la llamada y a un «siempre».
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Permission } from "../../src/permission"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { testEffect } from "../lib/effect"
import { SessionID } from "../../src/session/schema"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = AppNodeBuilder.build(
  LayerNode.group([Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
  [[InstanceStore.bootstrapNode, noopBootstrap]],
)
const it = testEffect(env)

const r = (permission: string, pattern: string, action: "allow" | "ask" | "deny") => ({ permission, pattern, action })
const pedir = (efectivo: Permission.Efectivo, permission = "bash", patterns = ["echo hola"]) =>
  Effect.gen(function* () {
    const p = yield* Permission.Service
    return yield* p.ask({ sessionID: SessionID.make("session_capas"), permission, patterns, metadata: {}, always: ["echo *"], ruleset: efectivo.ruleset, efectivo })
  })

it.instance(
  "capas: un deny del piso niega aunque la sesión diga allow (bypass); sin piso el allow manda",
  () =>
    Effect.gen(function* () {
      const previo = process.env.LAZUNOX_PERMISOS_CAPAS
      process.env.LAZUNOX_PERMISOS_CAPAS = "1"
      try {
        const bypass = [r("*", "*", "allow")]
        const conPiso: Permission.Efectivo = { ruleset: bypass, piso: [[r("bash", "*", "deny")]] }
        const exit = yield* pedir(conPiso).pipe(Effect.exit)
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof PermissionV1.DeniedError).toBe(true)
        // sin piso: el allow de la sesión deja pasar (lazunox.15)
        expect(yield* pedir({ ruleset: bypass, piso: [] })).toBeUndefined()
        // el deny de un patrón no afecta a otro comando
        expect(yield* pedir({ ruleset: bypass, piso: [[r("bash", "rm *", "deny")]] })).toBeUndefined()
      } finally {
        previo === undefined ? delete process.env.LAZUNOX_PERMISOS_CAPAS : (process.env.LAZUNOX_PERMISOS_CAPAS = previo)
      }
    }),
  { git: true },
)

it.instance(
  "capas: la foto del padre solo aprieta (ask sobre allow) y nunca abre",
  () =>
    Effect.gen(function* () {
      const previo = process.env.LAZUNOX_PERMISOS_CAPAS
      process.env.LAZUNOX_PERMISOS_CAPAS = "1"
      try {
        const hija = [r("*", "*", "allow")]
        const p = yield* Permission.Service
        const fiber = yield* pedir({ ruleset: hija, piso: [], padre: [r("bash", "*", "ask")] }).pipe(Effect.forkScoped)
        yield* Effect.sleep("50 millis")
        expect((yield* p.list()).length).toBe(1)
        yield* Effect.forEach(yield* p.list(), (x) => p.reply({ requestID: x.id, reply: "reject" }))
        yield* Fiber.join(fiber).pipe(Effect.exit)
        // el padre permite y la hija pregunta: manda la hija
        const fiber2 = yield* pedir({ ruleset: [r("*", "*", "ask")], piso: [], padre: [r("bash", "*", "allow")] }).pipe(Effect.forkScoped)
        yield* Effect.sleep("50 millis")
        expect((yield* p.list()).length).toBe(1)
        yield* Effect.forEach(yield* p.list(), (x) => p.reply({ requestID: x.id, reply: "reject" }))
        yield* Fiber.join(fiber2).pipe(Effect.exit)
      } finally {
        previo === undefined ? delete process.env.LAZUNOX_PERMISOS_CAPAS : (process.env.LAZUNOX_PERMISOS_CAPAS = previo)
      }
    }),
  { git: true },
)

it.instance(
  "capas: varios recursos en una sola llamada: cualquiera negado por el piso bloquea la llamada entera (B1-09)",
  () =>
    Effect.gen(function* () {
      const previo = process.env.LAZUNOX_PERMISOS_CAPAS
      process.env.LAZUNOX_PERMISOS_CAPAS = "1"
      try {
        const e: Permission.Efectivo = { ruleset: [r("*", "*", "allow")], piso: [[r("edit", "*", "allow"), r("edit", "secreto/*", "deny")]] }
        const exit = yield* pedir(e, "edit", ["ok.txt", "secreto/k.txt"]).pipe(Effect.exit)
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof PermissionV1.DeniedError).toBe(true)
        expect(yield* pedir(e, "edit", ["ok.txt", "otro/k.txt"])).toBeUndefined()
      } finally {
        previo === undefined ? delete process.env.LAZUNOX_PERMISOS_CAPAS : (process.env.LAZUNOX_PERMISOS_CAPAS = previo)
      }
    }),
  { git: true },
)
