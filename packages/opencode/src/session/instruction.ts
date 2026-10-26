import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Layer, Context } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Flag } from "@opencode-ai/core/flag/flag"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { Global } from "@opencode-ai/core/global"
import type { MessageV2 } from "./message-v2"
import type { MessageID } from "./schema"
import fsp from "fs/promises"
import * as ReglasRuta from "./reglas-ruta"
import * as Imports from "./imports"

// Herramientas cuyo resultado puede llevar instrucciones adjuntas (`metadata.loaded`). `edit`/`write`/`apply_patch`
// solo adjuntan reglas por ruta (Lazunox 4D); `read` también AGENTS.md de subcarpetas.
const ADJUNTAN = new Set(["read", "edit", "write", "apply_patch"])

function extract(messages: SessionV1.WithParts[], root?: string) {
  const paths = new Set<string>()
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "tool" && ADJUNTAN.has(part.tool) && part.state.status === "completed") {
        if (part.state.time.compacted) continue
        const loaded = part.state.metadata?.loaded
        if (!loaded || !Array.isArray(loaded)) continue
        for (const p of loaded) {
          if (typeof p === "string") paths.add(p)
        }
      }
      // Lazunox: lo que el bloque `<contexto-vigente>` de una compactación ya reinyectó (nombres relativos al proyecto).
      if (root && part.type === "text" && msg.info.role === "user") {
        const meta = part.metadata?.["lazunoxContextoVigente"] as { instrucciones?: unknown } | undefined
        if (Array.isArray(meta?.instrucciones)) {
          for (const n of meta.instrucciones) if (typeof n === "string" && n) paths.add(path.resolve(root, n))
        }
      }
    }
  }
  return paths
}

/** Reglas por ruta ya entregadas en el turno actual de la persona (después de su último mensaje): bytes y cantidad. */
function reglasDelTurno(messages: SessionV1.WithParts[]) {
  let bytes = 0
  let cuantas = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.info.role === "user") break
    for (const part of msg.parts) {
      if (part.type !== "tool" || !ADJUNTAN.has(part.tool) || part.state.status !== "completed") continue
      const b = part.state.metadata?.reglasBytes
      const n = part.state.metadata?.reglasN
      if (typeof b === "number") bytes += b
      if (typeof n === "number") cuantas += n
    }
  }
  return { bytes, cuantas }
}

/** realpath que tolera un destino que aún no existe (un `write` crea el archivo): resuelve el padre más cercano. */
async function realpathTolerante(p: string): Promise<string | undefined> {
  const resto: string[] = []
  let actual = path.resolve(p)
  for (let i = 0; i < 64; i++) {
    try {
      const real = await fsp.realpath(actual)
      return resto.length ? path.join(real, ...resto.reverse()) : real
    } catch {
      const padre = path.dirname(actual)
      if (padre === actual) return undefined
      resto.push(path.basename(actual))
      actual = padre
    }
  }
  return undefined
}

const dentro = (raiz: string, p: string) => p === raiz || p.startsWith(raiz.endsWith(path.sep) ? raiz : raiz + path.sep)

interface ReglaEnDisco {
  /** Ruta real del archivo de regla (dentro del proyecto). */
  real: string
  patrones: string[]
  cuerpo: string
}

/** Lee un archivo de regla si es un archivo normal dentro del proyecto (tras realpath); `undefined` si no. */
async function leerRegla(raiz: string, archivo: string): Promise<ReglaEnDisco | undefined> {
  const real = await fsp.realpath(archivo).catch(() => undefined)
  if (!real || !dentro(raiz, real) || !real.toLowerCase().endsWith(".md")) return undefined
  const st = await fsp.stat(real).catch(() => undefined)
  if (!st?.isFile()) return undefined
  const fh = await fsp.open(real, "r").catch(() => undefined)
  if (!fh) return undefined
  try {
    const buf = Buffer.alloc(Math.min(Number(st.size), ReglasRuta.REGLA_LECTURA_MAX_BYTES))
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    const leida = ReglasRuta.parsearRegla(buf.subarray(0, bytesRead).toString("utf-8"))
    return leida ? { real, ...leida } : undefined
  } catch {
    return undefined
  } finally {
    await fh.close().catch(() => {})
  }
}

/** Archivos `.md` de una carpeta de reglas (recursivo, con tope); la carpeta debe quedar dentro del proyecto tras realpath. */
async function listarArchivosRegla(raiz: string, carpeta: string) {
  const base = await fsp.realpath(carpeta).catch(() => undefined)
  if (!base || !dentro(raiz, base)) return []
  const out: string[] = []
  const visitar = async (dir: string, nivel: number): Promise<void> => {
    if (out.length >= ReglasRuta.REGLAS_ARCHIVOS_MAX || nivel > ReglasRuta.PROFUNDIDAD_MAX) return
    const items = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
    items.sort((a, b) => a.name.localeCompare(b.name))
    for (const item of items) {
      if (out.length >= ReglasRuta.REGLAS_ARCHIVOS_MAX) return
      const completa = path.join(dir, item.name)
      if (item.isDirectory()) await visitar(completa, nivel + 1)
      else if (item.name.toLowerCase().endsWith(".md")) out.push(completa)
    }
  }
  await visitar(base, 0)
  return out
}

export interface Interface {
  readonly clear: (messageID: MessageID) => Effect.Effect<void>
  readonly systemPaths: () => Effect.Effect<Set<string>, FSUtil.Error>
  readonly system: () => Effect.Effect<string[], FSUtil.Error>
  readonly find: (dir: string) => Effect.Effect<string | undefined, FSUtil.Error>
  readonly resolve: (
    messages: SessionV1.WithParts[],
    filepath: string,
    messageID: MessageID,
  ) => Effect.Effect<{ filepath: string; content: string; regla?: boolean }[], FSUtil.Error>
  /** Lazunox (4D): solo las reglas por ruta que coinciden con el archivo (para `edit`, `write` y `apply_patch`). */
  readonly reglas: (
    messages: SessionV1.WithParts[],
    filepath: string,
    messageID: MessageID,
  ) => Effect.Effect<{ filepath: string; content: string; regla: true }[]>
  /** Lazunox (4D): comprueba que `filepath` sea hoy una regla por ruta válida del proyecto y devuelve su cuerpo acotado. */
  readonly regla: (filepath: string) => Effect.Effect<{ nombre: string; contenido: string } | undefined>
  /** Lazunox (4D): cuántas reglas por ruta válidas tiene el proyecto (dato informativo del contexto fijo). */
  readonly contarReglas: () => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Instruction") {}

const layer: Layer.Layer<
  Service,
  never,
  FSUtil.Service | Config.Service | Global.Service | HttpClient.HttpClient | RuntimeFlags.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const flags = yield* RuntimeFlags.Service
    const http = HttpClient.filterStatusOk(withTransientReadRetry(yield* HttpClient.HttpClient))
    const globalFiles = [
      path.join(global.config, "AGENTS.md"),
      ...(!flags.disableClaudeCodePrompt ? [path.join(global.home, ".claude", "CLAUDE.md")] : []),
    ]
    const instructionFiles = [
      "AGENTS.md",
      ...(!flags.disableClaudeCodePrompt ? ["CLAUDE.md"] : []),
      "CONTEXT.md", // deprecated
    ]

    const state = yield* InstanceState.make(
      Effect.fn("Instruction.state")(() =>
        Effect.succeed({
          // Track which instruction files have already been attached for a given assistant message.
          claims: new Map<MessageID, Set<string>>(),
          // Lazunox (4D): bytes y cantidad de reglas por ruta entregadas en cada mensaje del asistente.
          reglas: new Map<MessageID, { bytes: number; n: number }>(),
        }),
      ),
    )

    const relative = Effect.fnUntraced(function* (instruction: string) {
      const ctx = yield* InstanceState.context
      if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
        return yield* fs
          .globUp(instruction, ctx.directory, ctx.worktree)
          .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      }
      return yield* fs
        .globUp(instruction, global.config, global.config)
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
    })

    const read = Effect.fnUntraced(function* (filepath: string) {
      const texto = yield* fs.readFileString(filepath).pipe(Effect.catch(() => Effect.succeed("")))
      // Lazunox (Ola 7, 7.9): `@ruta.md` incluye otros archivos del proyecto (LAZUNOX_IMPORTS=0 lo apaga).
      if (!texto || !Imports.activo()) return texto
      const ctx = yield* InstanceState.context
      const raiz = ctx.worktree && ctx.worktree !== "/" ? ctx.worktree : ctx.directory
      return (yield* Effect.promise(() => Imports.expandir(texto, filepath, raiz))).texto
    })

    const fetch = Effect.fnUntraced(function* (url: string) {
      const res = yield* http.execute(HttpClientRequest.get(url)).pipe(
        Effect.timeout(5000),
        Effect.catch(() => Effect.succeed(null)),
      )
      if (!res) return ""
      const body = yield* res.arrayBuffer.pipe(Effect.catch(() => Effect.succeed(new ArrayBuffer(0))))
      return new TextDecoder().decode(body)
    })

    const clear = Effect.fn("Instruction.clear")(function* (messageID: MessageID) {
      const s = yield* InstanceState.get(state)
      s.claims.delete(messageID)
      s.reglas.delete(messageID)
    })

    const systemPaths = Effect.fn("Instruction.systemPaths")(function* () {
      const config = yield* cfg.get()
      const ctx = yield* InstanceState.context
      const paths = new Set<string>()

      for (const file of globalFiles) {
        if (yield* fs.existsSafe(file)) {
          paths.add(path.resolve(file))
          break
        }
      }

      // The first project-level match wins so we don't stack AGENTS.md/CLAUDE.md from every ancestor.
      if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
        for (const file of instructionFiles) {
          const matches = yield* fs
            .findUp(file, ctx.directory, ctx.worktree)
            .pipe(Effect.catch(() => Effect.succeed([])))
          if (matches.length > 0) {
            matches.forEach((item) => paths.add(path.resolve(item)))
            break
          }
        }
      }

      if (config.instructions) {
        for (const raw of config.instructions) {
          if (raw.startsWith("https://") || raw.startsWith("http://")) continue
          const instruction = raw.startsWith("~/") ? path.join(global.home, raw.slice(2)) : raw
          const matches = yield* (
            path.isAbsolute(instruction)
              ? fs.glob(path.basename(instruction), {
                  cwd: path.dirname(instruction),
                  absolute: true,
                  include: "file",
                })
              : relative(instruction)
          ).pipe(Effect.catch(() => Effect.succeed([] as string[])))
          matches.forEach((item) => paths.add(path.resolve(item)))
        }
      }

      return paths
    })

    const system = Effect.fn("Instruction.system")(function* () {
      const config = yield* cfg.get()
      const paths = yield* systemPaths()
      const urls = (config.instructions ?? []).filter(
        (item) => item.startsWith("https://") || item.startsWith("http://"),
      )

      const files = yield* Effect.forEach(Array.from(paths), read, { concurrency: 8 })
      const remote = yield* Effect.forEach(urls, fetch, { concurrency: 4 })

      return [
        ...Array.from(paths).flatMap((item, i) => (files[i] ? [`Instructions from: ${item}\n${files[i]}`] : [])),
        ...urls.flatMap((item, i) => (remote[i] ? [`Instructions from: ${item}\n${remote[i]}`] : [])),
      ]
    })

    const find = Effect.fn("Instruction.find")(function* (dir: string) {
      for (const file of instructionFiles) {
        const filepath = path.resolve(path.join(dir, file))
        if (yield* fs.existsSafe(filepath)) return filepath
      }
      return undefined
    })

    // --- Lazunox (4D): reglas por ruta ---
    const carpetasDeReglas = () => {
      if (Flag.OPENCODE_DISABLE_PROJECT_CONFIG) return [] as string[]
      return [".opencode/rules", ...(!flags.disableClaudeCodePrompt ? [".claude/rules"] : [])]
    }

    const raizReal = Effect.fnUntraced(function* () {
      const directorio = yield* InstanceState.directory
      return yield* Effect.promise(() => fsp.realpath(directorio).catch(() => path.resolve(directorio)))
    })

    const reglas = Effect.fn("Instruction.reglas")(function* (
      messages: SessionV1.WithParts[],
      filepath: string,
      messageID: MessageID,
    ) {
      const vacio = [] as { filepath: string; content: string; regla: true }[]
      if (!ReglasRuta.activo()) return vacio
      const carpetas = carpetasDeReglas()
      if (carpetas.length === 0) return vacio
      const raiz = yield* raizReal()
      const destino = yield* Effect.promise(() => realpathTolerante(filepath))
      // Sin seguir enlaces hacia afuera: si el destino real queda fuera del proyecto no se carga nada.
      if (!destino || !dentro(raiz, destino) || destino === raiz) return vacio
      const rel = path.relative(raiz, destino).split(path.sep).join("/")

      const candidatas = yield* Effect.promise(async () => {
        const out: ReglaEnDisco[] = []
        const vistas = new Set<string>()
        for (const carpeta of carpetas) {
          for (const archivo of await listarArchivosRegla(raiz, path.join(raiz, carpeta))) {
            const regla = await leerRegla(raiz, archivo)
            if (!regla || vistas.has(regla.real) || regla.real === destino) continue
            vistas.add(regla.real)
            if (ReglasRuta.coincide(rel, regla.patrones)) out.push(regla)
          }
        }
        return out
      })
      if (candidatas.length === 0) return vacio

      const sys = yield* systemPaths().pipe(Effect.orElseSucceed(() => new Set<string>()))
      const already = extract(messages, raiz)
      const s = yield* InstanceState.get(state)
      const previo = reglasDelTurno(messages)
      const tope = ReglasRuta.turnoMaxBytes()
      const resultados: { filepath: string; content: string; regla: true }[] = []
      // Sección sin esperas: la reserva del tope y las reclamaciones no se pisan entre llamadas en paralelo.
      let set = s.claims.get(messageID)
      if (!set) {
        set = new Set()
        s.claims.set(messageID, set)
      }
      const uso = s.reglas.get(messageID) ?? { bytes: 0, n: 0 }
      for (const regla of candidatas) {
        if (sys.has(regla.real) || already.has(regla.real) || set.has(regla.real)) continue
        const contenido = ReglasRuta.formatear(regla.real, regla.cuerpo)
        const tamano = Buffer.byteLength(contenido, "utf-8")
        if (
          uso.n + previo.cuantas >= ReglasRuta.REGLAS_TURNO_MAX ||
          uso.bytes + previo.bytes + tamano > tope
        )
          break
        set.add(regla.real)
        uso.bytes += tamano
        uso.n += 1
        resultados.push({ filepath: regla.real, content: contenido, regla: true })
      }
      s.reglas.set(messageID, uso)
      return resultados
    })

    const regla = Effect.fn("Instruction.regla")(function* (filepath: string) {
      if (!ReglasRuta.activo()) return undefined
      const carpetas = carpetasDeReglas()
      if (carpetas.length === 0) return undefined
      const raiz = yield* raizReal()
      return yield* Effect.promise(async () => {
        const abs = path.resolve(filepath)
        const real = await fsp.realpath(abs).catch(() => undefined)
        if (!real) return undefined
        // Debe estar de verdad dentro de una carpeta de reglas del proyecto (no cualquier .md con encabezado).
        let valida = false
        for (const carpeta of carpetas) {
          const base = await fsp.realpath(path.join(raiz, carpeta)).catch(() => undefined)
          if (base && dentro(raiz, base) && real.startsWith(base + path.sep)) valida = true
        }
        if (!valida) return undefined
        const leida = await leerRegla(raiz, real)
        if (!leida) return undefined
        return {
          nombre: path.relative(raiz, leida.real) || leida.real,
          contenido: ReglasRuta.recortar(ReglasRuta.neutralizar(leida.cuerpo.trim()), ReglasRuta.REGLA_MAX_BYTES).texto,
        }
      })
    })

    const contarReglas = Effect.fn("Instruction.contarReglas")(function* () {
      if (!ReglasRuta.activo()) return 0
      const raiz = yield* raizReal()
      return yield* Effect.promise(async () => {
        let n = 0
        const vistas = new Set<string>()
        for (const carpeta of carpetasDeReglas()) {
          for (const archivo of await listarArchivosRegla(raiz, path.join(raiz, carpeta))) {
            const leida = await leerRegla(raiz, archivo)
            if (leida && !vistas.has(leida.real)) {
              vistas.add(leida.real)
              n++
            }
          }
        }
        return n
      })
    })

    const resolve = Effect.fn("Instruction.resolve")(function* (
      messages: SessionV1.WithParts[],
      filepath: string,
      messageID: MessageID,
    ) {
      const sys = yield* systemPaths()
      const already = extract(messages, path.resolve(yield* InstanceState.directory))
      const results: { filepath: string; content: string; regla?: boolean }[] = []
      const s = yield* InstanceState.get(state)
      const root = path.resolve(yield* InstanceState.directory)

      const target = path.resolve(filepath)
      let current = path.dirname(target)

      // Walk upward from the file being read and attach nearby instruction files once per message.
      while (current.startsWith(root) && current !== root) {
        const found = yield* find(current)
        if (!found || found === target || sys.has(found) || already.has(found)) {
          current = path.dirname(current)
          continue
        }

        let set = s.claims.get(messageID)
        if (!set) {
          set = new Set()
          s.claims.set(messageID, set)
        }
        if (set.has(found)) {
          current = path.dirname(current)
          continue
        }

        set.add(found)
        const content = yield* read(found)
        if (content) {
          results.push({ filepath: found, content: `Instructions from: ${found}\n${content}` })
        }

        current = path.dirname(current)
      }

      // Lazunox (4D): además, las reglas por ruta que coinciden con el archivo.
      results.push(...(yield* reglas(messages, filepath, messageID)))
      return results
    })

    return Service.of({ clear, systemPaths, system, find, resolve, reglas, regla, contarReglas })
  }),
)

export function loaded(messages: SessionV1.WithParts[]) {
  return extract(messages)
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, FSUtil.node, Global.node, RuntimeFlags.node, httpClient],
})

export * as Instruction from "./instruction"
