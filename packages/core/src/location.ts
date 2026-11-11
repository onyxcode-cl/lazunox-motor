import { Context, Effect, Layer, Schema } from "effect"
import { Info, Ref, response } from "@opencode-ai/schema/location"
import { Project } from "./project"
import { AbsolutePath } from "./schema"
import { LayerNode } from "./effect/layer-node"
import { makeLocationNode, tags } from "./effect/app-node"

export * as Location from "./location"

export { Info, Ref, response }

export interface Interface extends Info {
  readonly cold?: boolean
  readonly vcs?: Project.Vcs
}

// Contexto interno: no cambia el contrato público de Location.Ref.
export const ContextRef = Schema.Struct({ ...Ref.fields, cold: Schema.optionalKey(Schema.Boolean) })
export type ContextRef = typeof ContextRef.Type

export function fromInstance(ctx: { directory: string; cold?: boolean }): ContextRef {
  return ContextRef.make({
    directory: AbsolutePath.make(ctx.directory),
    ...(ctx.cold === true ? { cold: true } : {}),
  })
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Location") {}

export const node = LayerNode.unbound(Service, tags.values.location)

const layer = (ref: ContextRef) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const project = yield* Project.Service
      const resolved = yield* project.resolve(ref.directory)
      return Service.of({
        directory: ref.directory,
        workspaceID: ref.workspaceID,
        project: { id: resolved.id, directory: resolved.directory },
        vcs: resolved.vcs,
        cold: ref.cold,
      })
    }),
  )

export const boundNode = (ref: ContextRef) =>
  makeLocationNode({
    service: Service,
    layer: layer(ref),
    deps: [Project.node],
  })
