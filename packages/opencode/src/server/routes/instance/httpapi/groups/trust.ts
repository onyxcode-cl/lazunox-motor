import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError, ForbiddenError } from "../errors"
import { described } from "./metadata"

// Lazunox (lazunox.16, B2): confianza de carpetas. Rutas GLOBALES (no pasan por el enrutado de instancia: `directory=` del query NO
// se confía ni se carga) y con la misma autenticación que el resto (`Authorization` de RootHttpApi).
export const TrustPaths = {
  trust: "/lazunox/trust",
} as const

export class FolderNotFoundError extends Schema.TaggedErrorClass<FolderNotFoundError>()(
  "FolderNotFoundError",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

export const TrustInput = Schema.Struct({
  directory: Schema.String.annotate({ description: "Absolute path of the folder (must exist and be a folder)" }),
})

export const TrustResult = Schema.Struct({
  directory: Schema.String.annotate({ description: "Canonical (physical) path that was trusted or untrusted" }),
  trusted: Schema.Boolean,
  changed: Schema.Boolean.annotate({ description: "false when the folder was already in that state" }),
  required: Schema.Boolean.annotate({ description: "Whether LAZUNOX_TRUST_REQUIRED is on for this engine" }),
}).annotate({ identifier: "FolderTrustResult" })

export const TrustList = Schema.Struct({
  required: Schema.Boolean,
  directories: Schema.Array(Schema.String),
}).annotate({ identifier: "FolderTrustList" })

export const TrustApi = HttpApi.make("trust").add(
  HttpApiGroup.make("trust")
    .add(
      HttpApiEndpoint.get("list", TrustPaths.trust, {
        success: described(TrustList, "Trusted folders (canonical paths) and whether trust is required"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "lazunox.trust.list",
          summary: "List trusted folders",
          description: "In-memory list of trusted folders. Lost when the engine restarts.",
        }),
      ),
      HttpApiEndpoint.post("add", TrustPaths.trust, {
        payload: TrustInput,
        success: described(TrustResult, "Folder trusted"),
        error: [InvalidRequestError, FolderNotFoundError, ForbiddenError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "lazunox.trust.add",
          summary: "Trust a folder",
          description:
            "Trusts the exact physical folder (symlinks resolved). Not inherited by child folders nor by parents. Idempotent. Takes effect on the next request; nothing is loaded by this call.",
        }),
      ),
      HttpApiEndpoint.delete("remove", TrustPaths.trust, {
        payload: TrustInput,
        success: described(TrustResult, "Folder untrusted and its instance unloaded"),
        error: [InvalidRequestError, ForbiddenError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "lazunox.trust.remove",
          summary: "Remove trust from a folder",
          description:
            "Removes the trust and unloads the folder instance (local connectors stop, plugin hooks stop, PTYs die, running turns abort).",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "trust", description: "Folder trust routes (Lazunox)." })),
)
