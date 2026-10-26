// Lazunox (6.8): `PostToolUseFailure`. Si una herramienta FALLA, avisa a los plugins (`tool.execute.failure`) y deja que añadan contexto al
// mensaje de error. Solo informa: el fallo sigue siendo fallo (no se convierte en éxito ni se traga). No aplica a permisos negados ni
// rechazados (eso es `permission.denied`) ni a interrupciones.
import { Cause, Effect } from "effect"
import type { Plugin } from "@/plugin"

const MAX_CONTEXTO = 2000

const errorDePermiso = (e: unknown) => {
  const tag = (e as { _tag?: unknown } | null)?._tag
  return typeof tag === "string" && tag.startsWith("Permission")
}

export const conGanchoDeFallo =
  (plugin: Pick<Plugin.Interface, "trigger">, info: { tool: string; sessionID: string; callID: string; args: unknown }) =>
  <A, E, R>(eff: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    eff.pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          if (Cause.hasInterruptsOnly(cause)) return yield* Effect.failCause(cause)
          const error = Cause.squash(cause)
          if (errorDePermiso(error)) return yield* Effect.failCause(cause)
          const mensaje = error instanceof Error ? error.message : String(error)
          const out = yield* plugin
            .trigger(
              "tool.execute.failure",
              { tool: info.tool, sessionID: info.sessionID, callID: info.callID, args: info.args, error: mensaje.slice(0, 4000) },
              {} as { contexto?: string },
            )
            .pipe(Effect.catchCause(() => Effect.succeed({} as { contexto?: string })))
          const extra = typeof out.contexto === "string" ? out.contexto.trim().slice(0, MAX_CONTEXTO) : ""
          // Solo se reescribe el mensaje de errores simples (Error plano): los tipados (con `_tag`) conservan su forma, el contexto no se pierde en el registro.
          if (extra && error instanceof Error && !(error as { _tag?: unknown })._tag) {
            const nuevo = new Error(`${error.message}\n\n[Gancho de usuario]: ${extra}`, { cause: error })
            nuevo.name = error.name
            nuevo.stack = error.stack
            return yield* Effect.fail(nuevo as unknown as E)
          }
          return yield* Effect.failCause(cause)
        }),
      ),
    )
