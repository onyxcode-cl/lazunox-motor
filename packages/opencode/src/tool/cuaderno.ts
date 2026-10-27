import * as path from "path"
import { Effect, Schema, Semaphore } from "effect"
import { createTwoFilesPatch } from "diff"
import * as Tool from "./tool"
import DESCRIPTION from "./cuaderno.txt"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { trimDiff } from "./edit"
import * as Bom from "@/util/bom"
import { editarCuaderno, ErrorCuaderno, MAX_BYTES_CUADERNO, TIPOS } from "./cuaderno-nb"

// Lazunox (Ola 7 — 7.15): herramienta `cuaderno_editar`. Permiso `edit` (rutas protegidas, plan-gate y reglas de carpeta
// aplican igual que en `edit`/`write`). El núcleo puro está en `cuaderno-nb.ts`.

export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "Absolute path of the .ipynb notebook" }),
  operacion: Schema.Literals(["reemplazar", "insertar", "borrar"]).annotate({ description: "reemplazar | insertar | borrar" }),
  celdaId: Schema.optional(Schema.String).annotate({ description: "Cell id (nbformat 4.5+). Alternative to indice" }),
  indice: Schema.optional(Schema.Number).annotate({ description: "Cell position, 0 = first cell" }),
  tipo: Schema.optional(Schema.Literals(TIPOS)).annotate({ description: "code | markdown | raw" }),
  contenido: Schema.optional(Schema.String).annotate({ description: "Full source of the cell (reemplazar, insertar)" }),
})

const locks = new Map<string, Semaphore.Semaphore>()
function lock(filePath: string) {
  const key = FSUtil.resolve(filePath)
  const hit = locks.get(key)
  if (hit) return hit
  const next = Semaphore.makeUnsafe(1)
  locks.set(key, next)
  return next
}

export const CuadernoTool = Tool.define(
  "cuaderno_editar",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const events = yield* EventV2Bridge.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!params.filePath) throw new Error("filePath is required")
          const instance = yield* InstanceState.context
          const filepath = path.isAbsolute(params.filePath) ? params.filePath : path.join(instance.directory, params.filePath)
          if (!filepath.toLowerCase().endsWith(".ipynb"))
            throw new Error(`cuaderno_editar solo edita archivos .ipynb. Para ${filepath} usa edit o write.`)
          yield* assertExternalDirectoryEffect(ctx, filepath)
          if (!(yield* fs.existsSafe(filepath))) throw new Error(`No existe el cuaderno ${filepath}. Esta herramienta no crea cuadernos nuevos.`)

          return yield* lock(filepath).withPermits(1)(
            Effect.gen(function* () {
              const info = yield* fs.stat(filepath)
              if (Number(info.size) > MAX_BYTES_CUADERNO)
                throw new Error(`El cuaderno pesa más de ${MAX_BYTES_CUADERNO / 1024 / 1024} MB; no se edita con esta herramienta.`)
              const source = yield* Bom.readFile(fs, filepath)
              if (source.utf16) throw new Error(`${filepath} está en UTF-16; un cuaderno válido es UTF-8.`)
              const r = yield* Effect.try({
                try: () => editarCuaderno(source.text, params),
                catch: (e) => (e instanceof ErrorCuaderno ? e : new Error(String(e))),
              })
              const diff = trimDiff(createTwoFilesPatch(filepath, filepath, r.antes ? r.antes + "\n" : "", r.despues ? r.despues + "\n" : ""))
              yield* ctx.ask({
                permission: "edit",
                patterns: [path.relative(instance.worktree, filepath)],
                always: ["*"],
                metadata: { filepath, diff },
              })
              yield* fs.writeWithDirs(filepath, Bom.salida(r.texto, source.bom))
              yield* events.publish(FileSystem.Event.Edited, { file: filepath })
              yield* events.publish(Watcher.Event.Updated, { file: filepath, event: "change" })
              return {
                title: path.relative(instance.worktree, filepath),
                metadata: { filepath, operacion: params.operacion, normalizado: r.normalizado },
                output:
                  r.resumen +
                  (r.normalizado
                    ? "\nAviso: el archivo no estaba escrito con el formato que usa esta herramienta (sangría, escapes o números como 1.0); se normalizó al guardar. Revisa el diff de git."
                    : ""),
              }
            }),
          )
        }).pipe(Effect.orDie),
    }
  }),
)
