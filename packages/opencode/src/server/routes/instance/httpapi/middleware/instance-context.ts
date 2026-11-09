import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { FolderTrust } from "@opencode-ai/core/folder-trust"
import { Effect, Layer } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { WorkspaceRouteContext } from "./workspace-routing"

export class InstanceContextMiddleware extends HttpApiMiddleware.Service<
  InstanceContextMiddleware,
  {
    requires: WorkspaceRouteContext
  }
>()("@opencode/ExperimentalHttpApiInstanceContext") {}

function decode(input: string): string {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

/**
 * Lazunox (lazunox.16, B2). Clase F («fría»): lecturas de historial que responden con lo guardado en disco y no necesitan que se
 * cargue la carpeta. Con LAZUNOX_TRUST_REQUIRED y una carpeta NO confiada solo estas rutas se atienden (con una instancia fría).
 * Todo lo demás que acepta `directory`, `x-opencode-directory` o `workspace` es clase C («cerrada»): 403 `folder_not_trusted`.
 * Una ruta nueva que no esté aquí es C por defecto (falla cerrado).
 */
const RUTAS_FRIAS: ReadonlyArray<RegExp> = [
  /^\/session$/,
  /^\/session\/status$/,
  /^\/session\/[^/]+$/,
  /^\/session\/[^/]+\/(?:children|message|todo|uso)$/,
  /^\/session\/[^/]+\/message\/[^/]+$/,
  /^\/permission$/,
  /^\/question$/,
]

export const esRutaFria = (method: string, pathname: string) =>
  method === "GET" && RUTAS_FRIAS.some((re) => re.test(pathname))

export const folderNotTrusted = () =>
  HttpServerResponse.jsonUnsafe({ error: "folder_not_trusted" }, { status: 403 })

function provideInstanceContext<E>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E>,
  store: InstanceStore.Interface,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, WorkspaceRouteContext | HttpServerRequest.HttpServerRequest> {
  return Effect.gen(function* () {
    const route = yield* WorkspaceRouteContext
    const directory = decode(route.directory)
    let load: { directory: string; cold?: boolean } = { directory }
    if (FolderTrust.required()) {
      const request = yield* HttpServerRequest.HttpServerRequest
      const verdict = FolderTrust.check(directory)
      // La carpeta registrada ya apunta a otra parte (p. ej. la reemplazaron por un enlace): deja de ser de confianza y se descarga.
      if (!verdict.trusted && verdict.stale) {
        FolderTrust.untrust(verdict.stale.canonical)
        yield* store.evict(verdict.stale.display)
      }
      const frio = esRutaFria(request.method, new URL(request.url, "http://localhost").pathname)
      // Una sesión de otra carpeta «prestada» con `directory=T` no evita la confianza: la carpeta de la sesión también cuenta.
      const sesionOk = route.sessionDirectory === undefined || FolderTrust.isTrusted(route.sessionDirectory)
      if (verdict.trusted && (sesionOk || frio)) load = { directory: verdict.display }
      // Una carpeta mal formada (NUL, relativa, más larga que cualquier ruta real) no llega ni a la instancia fría.
      else if (frio && FolderTrust.esAbsolutaValida(directory) && directory.length < 4096) load = { directory, cold: true }
      else return folderNotTrusted()
    }
    const ctx = yield* store.load(load)
    return yield* effect.pipe(
      Effect.provideService(InstanceRef, ctx),
      Effect.provideService(WorkspaceRef, route.workspaceID),
    )
  })
}

export const instanceContextLayer = Layer.effect(
  InstanceContextMiddleware,
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    return InstanceContextMiddleware.of((effect) => provideInstanceContext(effect, store))
  }),
)
