import { InstanceStore } from "@/project/instance-store"
import { FolderTrust } from "@opencode-ai/core/folder-trust"
import { isAllowedRequestOrigin } from "@opencode-ai/server/cors"
import { Effect, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"
import { ForbiddenError, InvalidRequestError } from "../errors"
import { FolderNotFoundError, TrustInput } from "../groups/trust"

export const trustHandlers = HttpApiBuilder.group(RootHttpApi, "trust", (handlers) =>
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service

    // Anti-CSRF: un origen ajeno (p. ej. una página web) no puede mover la confianza ni con credenciales válidas.
    const checkOrigin = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (!isAllowedRequestOrigin(request.headers["origin"], request.headers["host"]))
        return yield* new ForbiddenError({ message: "origin not allowed" })
    })

    const list = Effect.fn("TrustHttpApi.list")(function* () {
      return { required: FolderTrust.required(), directories: FolderTrust.list().map((entry) => entry.canonical) }
    })

    // El cuerpo se lee a mano: un JSON roto o un tipo equivocado responde 400 con motivo (el decodificador genérico daría 500).
    const leerDirectorio = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const type = (request.headers["content-type"] ?? "").toLowerCase()
      // Anti-CSRF «simple»: `text/plain` y formularios no son JSON; un navegador puede enviarlos sin preflight.
      if (!type.startsWith("application/json"))
        return yield* new InvalidRequestError({ message: "content-type must be application/json", kind: "Payload" })
      const text = yield* request.text.pipe(
        Effect.mapError(() => new InvalidRequestError({ message: "could not read the body", kind: "Payload" })),
      )
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        return yield* new InvalidRequestError({ message: "body is not valid JSON", kind: "Payload" })
      }
      const decoded = Schema.decodeUnknownOption(TrustInput)(body)
      if (decoded._tag === "None")
        return yield* new InvalidRequestError({ message: 'expected {"directory": "<absolute path>"}', kind: "Payload", field: "directory" })
      return decoded.value.directory
    })

    const answer = <A>(value: A) => HttpServerResponse.jsonUnsafe(value)

    const add = Effect.fn("TrustHttpApi.add")(function* () {
      yield* checkOrigin
      const directory = yield* leerDirectorio
      if (!FolderTrust.esAbsolutaValida(directory))
        return yield* new InvalidRequestError({ message: "directory must be an absolute path", field: "directory" })
      const result = FolderTrust.trust(directory)
      if (!result) return yield* new FolderNotFoundError({ message: "directory does not exist or is not a folder" })
      // Con la confianza encendida, al confiar se descarta toda instancia previa (la fría); la plena se carga en la siguiente petición.
      if (FolderTrust.required() && result.added) {
        yield* store.evict(result.entry.display)
        if (result.entry.canonical !== result.entry.display) yield* store.evict(result.entry.canonical)
      }
      return answer({ directory: result.entry.canonical, trusted: true, changed: result.added, required: FolderTrust.required() })
    })

    const remove = Effect.fn("TrustHttpApi.remove")(function* () {
      yield* checkOrigin
      const directory = yield* leerDirectorio
      if (!FolderTrust.esAbsolutaValida(directory))
        return yield* new InvalidRequestError({ message: "directory must be an absolute path", field: "directory" })
      // Primero se quita (lo que sigue ya no sirve nada de la caché) y luego se descarga.
      const removed = FolderTrust.untrust(directory)
      if (FolderTrust.required()) {
        for (const entry of removed) {
          yield* store.evict(entry.display)
          if (entry.canonical !== entry.display) yield* store.evict(entry.canonical)
        }
      }
      return answer({
        directory: removed[0]?.canonical ?? FolderTrust.canonical(directory) ?? directory,
        trusted: false,
        changed: removed.length > 0,
        required: FolderTrust.required(),
      })
    })

    return handlers.handle("list", list).handleRaw("add", add).handleRaw("remove", remove)
  }),
)
