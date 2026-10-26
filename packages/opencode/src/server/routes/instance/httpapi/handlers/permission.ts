import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Permission } from "@/permission"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { PermissionNotFoundError } from "../errors"

export const permissionHandlers = HttpApiBuilder.group(InstanceHttpApi, "permission", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Permission.Service

    const list = Effect.fn("PermissionHttpApi.list")(function* () {
      return yield* svc.list()
    })

    const reply = Effect.fn("PermissionHttpApi.reply")(function* (ctx: {
      params: { requestID: PermissionV1.ID }
      payload: PermissionV1.ReplyBody
    }) {
      yield* svc
        .reply({
          requestID: ctx.params.requestID,
          reply: ctx.payload.reply,
          message: ctx.payload.message,
        })
        .pipe(
          Effect.catchTag("Permission.NotFoundError", (error) =>
            Effect.fail(
              new PermissionNotFoundError({
                requestID: String(error.requestID),
                message: `Permission request not found: ${error.requestID}`,
              }),
            ),
          ),
        )
      return true
    })

    // Lazunox (Ola 7, 7.22): los «siempre» guardados.
    const siempreList = Effect.fn("PermissionHttpApi.siempreList")(function* () {
      return svc.siempre ? yield* svc.siempre.listar() : { activo: false, reglas: [] }
    })
    const siempreRemoveAll = Effect.fn("PermissionHttpApi.siempreRemoveAll")(function* () {
      return { borradas: svc.siempre ? yield* svc.siempre.borrarTodos() : 0 }
    })
    const siempreRemove = Effect.fn("PermissionHttpApi.siempreRemove")(function* (ctx: { params: { id: string } }) {
      const ok = svc.siempre ? yield* svc.siempre.borrar(ctx.params.id) : false
      if (!ok)
        return yield* new PermissionNotFoundError({
          requestID: ctx.params.id,
          message: `Saved permission not found: ${ctx.params.id}`,
        })
      return true
    })

    return handlers
      .handle("list", list)
      .handle("reply", reply)
      .handle("siempreList", siempreList)
      .handle("siempreRemoveAll", siempreRemoveAll)
      .handle("siempreRemove", siempreRemove)
  }),
)
