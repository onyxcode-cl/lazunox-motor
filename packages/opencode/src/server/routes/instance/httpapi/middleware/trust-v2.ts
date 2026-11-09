import { Database } from "@opencode-ai/core/database/database"
import { FolderTrust } from "@opencode-ai/core/folder-trust"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/unstable/http"
import { folderNotTrusted } from "./instance-context"

// Lazunox (lazunox.16, B2): la API v2 (`/api/*`) también carga la carpeta (config, plugins, conectores) a través de `location`. Con
// LAZUNOX_TRUST_REQUIRED, toda ruta v2 (salvo `/api/health`) sobre una carpeta no confiada responde 403 `folder_not_trusted` sin
// llegar a cargar nada. Las rutas de sesión (`/api/session/{id}/…`) usan la carpeta de la sesión, como el resto del motor.
function decode(input: string) {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

export const trustV2Layer = HttpRouter.middleware<{ requires: Database.Service; handles: unknown }>()(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return (effect) =>
      Effect.gen(function* () {
        if (!FolderTrust.required()) return yield* effect
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        // `/experimental/project/{id}/copy…` también es v2 (usa `location`); `copy/generate-name` es v1 (lo cubre el enrutado de instancia).
        const esV2 =
          (url.pathname.startsWith("/api/") && url.pathname !== "/api/health") ||
          /^\/experimental\/project\/[^/]+\/copy(?:\/refresh)?$/.test(url.pathname)
        if (!esV2) return yield* effect

        const sessionID = url.pathname.match(/^\/api\/session\/([^/]+)/)?.[1]
        let directory: string | undefined
        if (sessionID && sessionID !== "active") {
          const row = yield* db
            .select({ directory: SessionTable.directory })
            .from(SessionTable)
            .where(eq(SessionTable.id, sessionID as typeof SessionTable.id._.data))
            .get()
            .pipe(Effect.orDie)
          // Sin fila: el motor responde 404 sin cargar nada.
          if (!row) return yield* effect
          directory = row.directory
        } else {
          const header = request.headers["x-opencode-directory"]
          directory = url.searchParams.get("location[directory]") || (header ? decode(header) : process.cwd())
        }
        if (!FolderTrust.isTrusted(directory)) return folderNotTrusted()
        return yield* effect
      })
  }),
).layer
