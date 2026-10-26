// Lazunox (Ola 6, paquete 6.7; H9 + H10): avisos de cambios. APAGADO por defecto: solo con LAZUNOX_AVISOS_CAMBIOS=1.
//  - H9: al empezar un paso, si un archivo que la sesión leyó cambió en disco y la sesión no lo editó, se persiste UNA parte sintética en
//    el mensaje de la persona con SOLO rutas (nunca contenido).
//  - H10: tras `shell` (no en segundo plano) se añade a su resultado «Archivos que cambió el comando: <ruta> (+a −b)» (máx. 20, sin diff).
// Restricciones: las rutas protegidas (`permission/rutas-protegidas.ts`) y los archivos que `read` pediría permiso para ver (`.env*`)
// NO se nombran (salen como «N archivo(s) protegido(s) cambió/cambiaron»); un enlace simbólico que sale del proyecto no se sigue; y las
// rutas se neutralizan (sin saltos de línea ni controles, sin `<`/`>`, entre comillas) porque un nombre de archivo puede ser una inyección.
import fs from "fs"
import path from "path"
import { Effect, Option } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { esProtegida } from "@/permission/rutas-protegidas"
import { Snapshot } from "@/snapshot"
import { neutralizar } from "@/tool/neutralizar"
import { PartID } from "./schema"
import { Session } from "./session"
import { LecturasSesion } from "./lecturas"

export const activo = (env: NodeJS.ProcessEnv = process.env) => env.LAZUNOX_AVISOS_CAMBIOS === "1"

export const RUTAS_AVISO_MAX = 50
export const RUTAS_SHELL_MAX = 20
const RUTA_LARGO_MAX = 200

/** Mismas reglas que pide `read` por defecto (`agent/agent.ts`): `*.env` y `*.env.*` preguntan, `*.env.example` no. */
export function esArchivoEnv(nombre: string) {
  const n = nombre.toLowerCase()
  if (n.endsWith(".env.example")) return false
  return n.endsWith(".env") || n.includes(".env.")
}

type Raices = { directory: string; worktree: string }

const real = (p: string) => {
  try {
    return fs.realpathSync(p)
  } catch {
    return undefined
  }
}

/** realpath del archivo, o (si ya no existe) realpath de su carpeta + el nombre. `undefined` si no se puede garantizar. */
function realDe(abs: string): string | undefined {
  const r = real(abs)
  if (r) return r
  const dir = real(path.dirname(abs))
  return dir ? path.join(dir, path.basename(abs)) : undefined
}

const dentroDe = (base: string, p: string) => {
  const rel = path.relative(base, p)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

/** ¿La ruta real queda dentro del proyecto (carpeta o árbol de trabajo, sin contar «/» de los proyectos sin git)? */
export function dentroDelProyecto(realRuta: string, r: Raices) {
  const dir = real(r.directory) ?? r.directory
  if (dentroDe(dir, realRuta)) return true
  if (r.worktree === "/") return false
  return dentroDe(real(r.worktree) ?? r.worktree, realRuta)
}

export type Clase = { tipo: "ok"; rel: string } | { tipo: "protegida" } | { tipo: "fuera" }

/**
 * Decide si una ruta se puede nombrar. `abs` y, si existe, `pedida` (el nombre con que se pidió, antes de resolver enlaces) se miran los dos:
 * si CUALQUIERA es protegida o `.env`, no se nombra.
 */
export function clasificar(abs: string, r: Raices, pedida?: string): Clase {
  const resuelta = realDe(abs)
  if (!resuelta || !dentroDelProyecto(resuelta, r)) return { tipo: "fuera" }
  const base = real(r.directory) ?? r.directory
  const rel = (dentroDe(base, resuelta) ? path.relative(base, resuelta) : path.relative(real(r.worktree) ?? r.worktree, resuelta)).replaceAll("\\", "/")
  const candidatas = [rel, path.relative(r.directory, abs).replaceAll("\\", "/")]
  if (pedida) candidatas.push(path.relative(r.directory, path.resolve(r.directory, pedida)).replaceAll("\\", "/"))
  for (const c of candidatas) {
    // `env: {}` descarta la excepción del plan: aquí la lista se aplica siempre, y no depende de LAZUNOX_PROTECTED_PATHS.
    if (esProtegida(c, {}) || esArchivoEnv(path.posix.basename(c))) return { tipo: "protegida" }
  }
  return { tipo: "ok", rel }
}

/** Ruta lista para ir dentro de un texto del modelo: sin controles ni saltos de línea, sin `<` `>`, acotada y entre comillas JSON. */
export function rutaNeutral(rel: string) {
  let t = neutralizar(rel).replace(/[\p{C}\p{Zl}\p{Zp}]/gu, "?")
  if (t.length > RUTA_LARGO_MAX) t = t.slice(0, RUTA_LARGO_MAX) + "…"
  return JSON.stringify(t).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")
}

const protegidas = (n: number) => (n === 1 ? "1 archivo protegido cambió" : `${n} archivos protegidos cambiaron`)

export function textoAviso(input: { rutas: string[]; protegidas: number; mas: number }) {
  const partes: string[] = []
  if (input.rutas.length) {
    partes.push(
      `Estos archivos cambiaron fuera de esta sesión desde que los leíste: ${input.rutas.map(rutaNeutral).join(", ")}` +
        (input.mas > 0 ? ` y ${input.mas} más` : "") +
        ".",
    )
  }
  if (input.protegidas > 0) partes.push(`${protegidas(input.protegidas)}.`)
  partes.push("Vuelve a leerlos antes de editarlos. Solo se listan las rutas, no el contenido.")
  return partes.join(" ")
}

export type FilaShell = { file: string; additions: number; deletions: number; binary: boolean; status: string }

export function textoShell(input: { filas: string[]; mas: number; protegidas: number }) {
  const lista = input.filas.length
    ? `Archivos que cambió el comando: ${input.filas.join(", ")}${input.mas > 0 ? ` y ${input.mas} más` : ""}.`
    : ""
  const prot = input.protegidas > 0 ? `${protegidas(input.protegidas)}.` : ""
  return [lista, prot].filter(Boolean).join(" ")
}

/** Archivos que la sesión editó con herramientas (edit/write/apply_patch o partes `patch`) en mensajes con id >= `desde`. */
function ediciones(messages: SessionV1.WithParts[], r: Raices) {
  const lista: { msgID: string; abs: string }[] = []
  const agregar = (msgID: string, f: string) => {
    const abs = path.resolve(r.directory, f)
    lista.push({ msgID, abs: realDe(abs) ?? abs })
  }
  for (const m of messages) {
    if (m.info.role !== "assistant") continue
    for (const p of m.parts) {
      if (p.type === "patch") for (const f of p.files) agregar(m.info.id, f)
      if (p.type !== "tool") continue
      const input = (p.state.input ?? {}) as Record<string, unknown>
      if ((p.tool === "edit" || p.tool === "write") && typeof input.filePath === "string") agregar(m.info.id, input.filePath)
      if (p.tool === "apply_patch" && typeof input.patchText === "string") {
        for (const x of input.patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) agregar(m.info.id, x[1]!.trim())
        for (const x of input.patchText.matchAll(/^\*\*\* Move to: (.+)$/gm)) agregar(m.info.id, x[1]!.trim())
      }
    }
  }
  return lista
}

/** H9, parte pura: calcula el texto del aviso (y actualiza las bases). `undefined` si no hay nada que avisar. */
export function revisarCambios(sessionID: string, messages: SessionV1.WithParts[], r: Raices): string | undefined {
  if (!activo() || messages.length === 0) return undefined
  let propias: { msgID: string; abs: string }[] | undefined
  const cambiadas = LecturasSesion.cambiadas(sessionID, {
    visible: (callID) => LecturasSesion.visible(messages, callID),
    dentro: (ruta) => dentroDelProyecto(ruta, r),
    propia: (ruta, desde) => (propias ??= ediciones(messages, r)).some((e) => e.abs === ruta && e.msgID >= desde),
    hasta: messages.at(-1)!.info.id,
    max: RUTAS_AVISO_MAX,
  })
  if (cambiadas.length === 0) return undefined
  const rutas: string[] = []
  let ocultas = 0
  for (const c of cambiadas) {
    const k = clasificar(c.ruta, r, c.pedida)
    if (k.tipo === "ok") rutas.push(k.rel)
    else if (k.tipo === "protegida") ocultas++
  }
  if (rutas.length === 0 && ocultas === 0) return undefined
  return textoAviso({ rutas, protegidas: ocultas, mas: 0 })
}

/** H9: añade al mensaje de la persona en curso UNA parte sintética persistida con el aviso. Sin la bandera no hace nada. */
export const aplicar = Effect.fn("AvisosCambios.aplicar")(function* (input: {
  messages: SessionV1.WithParts[]
  sessionID: string
  directory: string
  worktree: string
}) {
  if (!activo()) return input.messages
  const user = input.messages.findLast((m) => m.info.role === "user")
  if (!user) return input.messages
  const texto = revisarCambios(input.sessionID, input.messages, input)
  if (!texto) return input.messages
  const sessions = yield* Session.Service
  const part = yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: user.info.id,
    sessionID: user.info.sessionID,
    type: "text",
    text: texto,
    synthetic: true,
    metadata: { lazunox_avisos_cambios: true },
  } as SessionV1.TextPart)
  user.parts.push(part)
  return input.messages
})

// ------------------------------------------------------------------------------------------ H10: diff del shell

export interface ShellPrevio {
  snap: Snapshot.Interface
  tree: string
}

const TIEMPO = "5 seconds"

/** Instantánea ANTES del comando. Sin bandera, sin servicio de instantáneas o con cualquier fallo: `undefined` y el shell sigue igual. */
export const antesDelShell = Effect.fn("AvisosCambios.antesDelShell")(function* () {
  if (!activo()) return undefined
  const snap = yield* Effect.serviceOption(Snapshot.Service)
  if (Option.isNone(snap)) return undefined
  const tree = yield* snap.value.track().pipe(
    Effect.timeoutOption(TIEMPO),
    Effect.map(Option.getOrUndefined),
    Effect.catchCause(() => Effect.succeed(undefined)),
  )
  return tree ? ({ snap: snap.value, tree } satisfies ShellPrevio) : undefined
})

/** Línea para añadir al resultado del shell (sin contenido del diff). `undefined` si nada cambió o algo falló. */
export const despuesDelShell = Effect.fn("AvisosCambios.despuesDelShell")(function* (
  previo: ShellPrevio | undefined,
  sessionID: string,
  r: Raices,
  hasta: string,
) {
  if (!previo) return undefined
  return yield* Effect.gen(function* () {
    const tree = yield* previo.snap.track().pipe(Effect.timeoutOption(TIEMPO), Effect.map(Option.getOrUndefined))
    if (!tree || tree === previo.tree) return undefined
    const filas = yield* previo.snap.numstat(previo.tree, tree).pipe(Effect.timeoutOption(TIEMPO), Effect.map(Option.getOrUndefined))
    if (!filas?.length) return undefined
    return resumenShell(sessionID, filas, r, hasta)
  }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
})

/** Parte pura de H10: filtra protegidas/fuera, neutraliza y da formato. Pone al día las bases de lecturas de lo que cambió el comando. */
export function resumenShell(sessionID: string, filas: readonly Snapshot.FilaNumstat[], r: Raices, hasta: string) {
  const visibles: string[] = []
  let ocultas = 0
  let total = 0
  const reales: string[] = []
  for (const f of filas) {
    const abs = path.resolve(r.directory, f.file)
    const k = clasificar(abs, r)
    if (k.tipo === "fuera") continue
    const resuelta = realDe(abs)
    if (resuelta) reales.push(resuelta)
    if (k.tipo === "protegida") {
      ocultas++
      continue
    }
    total++
    if (visibles.length < RUTAS_SHELL_MAX) {
      visibles.push(`${rutaNeutral(k.rel)} ${f.binary ? "(binario)" : `(+${f.additions} −${f.deletions})`}`)
    }
  }
  LecturasSesion.marcarPropias(sessionID, reales, hasta)
  if (visibles.length === 0 && ocultas === 0) return undefined
  return textoShell({ filas: visibles, mas: total - visibles.length, protegidas: ocultas })
}

export * as AvisosCambios from "./avisos-cambios"
