// Lazunox (Ola 7, 7.18): observabilidad LOCAL de tokens y caché por sesión. Solo lectura y solo cifras: nada sale de la máquina.
//
// Fuente: las partes `step-finish` que el motor ya guarda en cada mensaje del asistente (tokens del `usage` del modelo). No hay estado
// nuevo que persistir; lo único en memoria es la huella (hash) de la lista de herramientas y del sistema de cada petición, para inferir
// POR QUÉ falló la caché. Si la huella no se conoce (reinicio del motor) o nada explica el fallo, la causa es «desconocida»: no se inventa.
// Ruta: `GET /session/{id}/uso`. Interruptor: `LAZUNOX_USO=0` (la ruta responde 404 y no se registran huellas).
import { createHash } from "node:crypto"
import { Effect } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Session } from "./session"
import type { SessionID } from "./schema"

export const activo = (env: Record<string, string | undefined> = process.env) => env.LAZUNOX_USO !== "0"

// ------------------------------------------------------------------ huellas (en memoria)
export type Huella = { tools: string; sistema: string }

const MAX_HUELLAS = 4000
const huellas = new Map<string, Huella>()

const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16)

/** Huella de lo que viaja al inicio de cada petición: los textos del sistema y los nombres+descripciones de las herramientas. */
export function huellaDe(input: { system: ReadonlyArray<string>; tools: Record<string, { description?: string } | undefined> }): Huella {
  return {
    sistema: hash(JSON.stringify(input.system)),
    tools: hash(
      JSON.stringify(
        Object.keys(input.tools)
          .sort()
          .map((n) => [n, input.tools[n]?.description ?? ""]),
      ),
    ),
  }
}

export function registrarHuella(messageID: string, h: Huella) {
  if (!activo()) return
  huellas.delete(messageID)
  huellas.set(messageID, h)
  if (huellas.size > MAX_HUELLAS) huellas.delete(huellas.keys().next().value as string)
}

export const huellaRegistrada = (messageID: string) => huellas.get(messageID)
export const olvidarHuellas = () => huellas.clear()

// ------------------------------------------------------------------ estadística
/** Mediana clásica (promedio de los dos centrales si hay cantidad par). Vacío → 0. */
export function mediana(xs: ReadonlyArray<number>): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Percentil por rango más cercano: el valor en la posición ceil(p·n) del orden ascendente. Vacío → 0. */
export function percentil(xs: ReadonlyArray<number>, p: number): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length, Math.max(1, Math.ceil(p * s.length))) - 1]
}

// ------------------------------------------------------------------ pasos
export type Paso = {
  mensajeID: string
  modelo: string
  /** Tokens que viajaron en la petición: no cacheados + lectura de caché + escritura de caché. */
  enviado: number
  sinCache: number
  leidos: number
  escritos: number
  /** Salida del modelo (incluye razonamiento). */
  salida: number
}

export type Causa = "herramientas" | "sistema" | "herramientas-y-sistema" | "modelo" | "desconocida"

/** Pasos (uno por `step-finish`) de una lista de mensajes, en orden. */
export function pasosDe(msgs: ReadonlyArray<SessionV1.WithParts>): Paso[] {
  const out: Paso[] = []
  for (const m of msgs) {
    if (m.info.role !== "assistant") continue
    for (const p of m.parts) {
      if (p.type !== "step-finish") continue
      const t = p.tokens
      const sinCache = t.input ?? 0
      const leidos = t.cache?.read ?? 0
      const escritos = t.cache?.write ?? 0
      out.push({
        mensajeID: String(m.info.id),
        modelo: `${m.info.providerID}/${m.info.modelID}`,
        enviado: sinCache + leidos + escritos,
        sinCache,
        leidos,
        escritos,
        salida: (t.output ?? 0) + (t.reasoning ?? 0),
      })
    }
  }
  return out
}

/**
 * ¿Falló la caché en el paso `b` respecto a `a`? Con prefijo estable, `b` debería leer al menos lo que `a` leyó y, si `a` escribió caché,
 * algo de eso. Solo se afirma fallo con evidencia: la lectura bajó, o `a` escribió caché y `b` no leyó nada.
 */
export function huboFallo(a: Paso, b: Paso): boolean {
  return b.leidos < a.leidos || (a.escritos > 0 && b.leidos === 0)
}

/** Causa probable del fallo entre `a` y `b`: solo lo que se puede comprobar (modelo distinto, huella de herramientas o de sistema distinta). */
export function causaDe(a: Paso, b: Paso): Causa {
  if (a.modelo !== b.modelo) return "modelo"
  const ha = huellas.get(a.mensajeID)
  const hb = huellas.get(b.mensajeID)
  if (!ha || !hb) return "desconocida"
  const t = ha.tools !== hb.tools
  const s = ha.sistema !== hb.sistema
  if (t && s) return "herramientas-y-sistema"
  if (t) return "herramientas"
  if (s) return "sistema"
  return "desconocida"
}

export type Fallo = { paso: number; mensajeID: string; causa: Causa }

export type Resumen = {
  pasos: number
  tokensEnviadosPorPaso: { mediana: number; p90: number; minimo: number; maximo: number; total: number }
  salida: number
  cache: {
    /** `false` si ningún paso reportó lectura ni escritura de caché (el proveedor no da el dato o no hubo caché). */
    datos: boolean
    leidos: number
    escritos: number
    sinCache: number
    /** leidos / enviado en %, un decimal; `null` si no hay datos de caché. */
    aciertoPct: number | null
    fallos: Fallo[]
  }
}

export function resumir(pasos: ReadonlyArray<Paso>): Resumen {
  const enviados = pasos.map((p) => p.enviado)
  const sum = (f: (p: Paso) => number) => pasos.reduce((n, p) => n + f(p), 0)
  const leidos = sum((p) => p.leidos)
  const escritos = sum((p) => p.escritos)
  const total = sum((p) => p.enviado)
  const datos = leidos > 0 || escritos > 0
  const fallos: Fallo[] = []
  if (datos)
    for (let i = 1; i < pasos.length; i++)
      if (huboFallo(pasos[i - 1], pasos[i])) fallos.push({ paso: i + 1, mensajeID: pasos[i].mensajeID, causa: causaDe(pasos[i - 1], pasos[i]) })
  return {
    pasos: pasos.length,
    tokensEnviadosPorPaso: {
      mediana: mediana(enviados),
      p90: percentil(enviados, 0.9),
      minimo: enviados.length ? Math.min(...enviados) : 0,
      maximo: enviados.length ? Math.max(...enviados) : 0,
      total,
    },
    salida: sum((p) => p.salida),
    cache: {
      datos,
      leidos,
      escritos,
      sinCache: sum((p) => p.sinCache),
      aciertoPct: datos && total > 0 ? Math.round((leidos / total) * 1000) / 10 : null,
      fallos: fallos.slice(-20),
    },
  }
}

export type Ayudante = {
  sessionID: string
  titulo: string
  pasos: number
  tokensEnviados: number
  salida: number
  cache: { leidos: number; escritos: number }
}

export type Uso = {
  sessionID: string
  sesion: Resumen
  porPaso: Array<Pick<Paso, "mensajeID" | "enviado" | "sinCache" | "leidos" | "escritos" | "salida">>
  ayudantes: Ayudante[]
  total: { tokensEnviados: number; salida: number }
}

const MAX_AYUDANTES = 200
const MAX_POR_PASO = 200

/** Calcula el uso de una sesión y de todas sus sesiones hijas (ayudantes), a cualquier profundidad. */
export const calcular = Effect.fn("SessionUso.calcular")(function* (sessions: Session.Interface, sessionID: SessionID) {
  const propia = pasosDe(yield* sessions.messages({ sessionID }))
  const sesion = resumir(propia)
  const ayudantes: Ayudante[] = []
  const vistos = new Set<string>([String(sessionID)])
  let cola: SessionID[] = [sessionID]
  while (cola.length && ayudantes.length < MAX_AYUDANTES) {
    const siguiente: SessionID[] = []
    for (const padre of cola) {
      for (const hija of yield* sessions.children(padre)) {
        if (vistos.has(String(hija.id)) || ayudantes.length >= MAX_AYUDANTES) continue
        vistos.add(String(hija.id))
        siguiente.push(hija.id)
        const r = resumir(pasosDe(yield* sessions.messages({ sessionID: hija.id }).pipe(Effect.orElseSucceed(() => [] as SessionV1.WithParts[]))))
        ayudantes.push({
          sessionID: String(hija.id),
          titulo: hija.title,
          pasos: r.pasos,
          tokensEnviados: r.tokensEnviadosPorPaso.total,
          salida: r.salida,
          cache: { leidos: r.cache.leidos, escritos: r.cache.escritos },
        })
      }
    }
    cola = siguiente
  }
  return {
    sessionID: String(sessionID),
    sesion,
    porPaso: propia.slice(-MAX_POR_PASO).map(({ mensajeID, enviado, sinCache, leidos, escritos, salida }) => ({ mensajeID, enviado, sinCache, leidos, escritos, salida })),
    ayudantes,
    total: {
      tokensEnviados: sesion.tokensEnviadosPorPaso.total + ayudantes.reduce((n, a) => n + a.tokensEnviados, 0),
      salida: sesion.salida + ayudantes.reduce((n, a) => n + a.salida, 0),
    },
  } satisfies Uso
})
