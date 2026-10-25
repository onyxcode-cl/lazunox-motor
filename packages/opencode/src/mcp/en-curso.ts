// Lazunox: registro de llamadas MCP vivas, por cliente (servidor), para los formularios (`elicitation/create`).
//
// El cliente MCP es por servidor y carpeta, no por sesión: una solicitud del servidor no dice qué sesión la provoca.
// La atribución se hace con las llamadas vivas de ESE cliente (las registran `McpInvocar.run` y `invokeChildTool` de Code Mode):
// - 0 llamadas vivas -> no se adivina (el manejador responde `decline`);
// - llamadas de una sola sesión -> esa sesión;
// - llamadas de sesiones distintas -> ambiguo (`decline`).
//
// También aquí vive el temporizador PAUSABLE de la llamada: el `timeout` de `callTool` (30 s por defecto) cortaría la llamada
// mientras la persona escribe en el formulario. Con formularios activos (`LAZUNOX_MCP_ELICITATION=1`) al SDK se le pasa un tope
// alto (1 h) y el tiempo real lo mide este temporizador, que se detiene mientras haya un formulario abierto de la llamada.
// Sin la variable no cambia nada: el SDK sigue cortando por su cuenta, igual que antes.
import { Effect } from "effect"
import { elicitacionActiva } from "./elicitation-esquema"

/** Una llamada MCP viva. */
export interface LiveCall {
  readonly key: string
  readonly sessionID: string
  readonly messageID: string
  readonly callID: string | undefined
  readonly abort: AbortSignal | undefined
  /** Cliente MCP (identidad) que ejecuta la llamada; es la clave del registro. */
  readonly client?: object
  /** Detiene el temporizador de la llamada; devuelve la función que lo reanuda (con tiempo completo). */
  readonly pausar?: () => () => void
}

/** Se llama al entrar (`enter`) y al salir (`exit`, siempre, también con error o aborto) de la llamada al servidor. */
export type OnCall = (phase: "enter" | "exit", call: LiveCall) => void

export const TOPE_SDK_MS = 3_600_000
export const TIEMPO_LLAMADA_DEFECTO_MS = 30_000

interface Cliente {
  vivas: Set<LiveCall>
  alSalir?: (call: LiveCall) => void
}

const clientes = new WeakMap<object, Cliente>()

/** Registrador por defecto de `McpInvocar.run` y de Code Mode. */
export const registrar: OnCall = (fase, call) => {
  const cliente = call.client
  if (!cliente) return
  if (fase === "enter") {
    let c = clientes.get(cliente)
    if (!c) clientes.set(cliente, (c = { vivas: new Set() }))
    c.vivas.add(call)
    return
  }
  const c = clientes.get(cliente)
  if (!c) return
  c.vivas.delete(call)
  try {
    c.alSalir?.(call)
  } catch {
    // un fallo al limpiar nunca debe romper la llamada
  }
}

/** Llamadas vivas de un cliente. */
export function vivas(cliente: object): ReadonlyArray<LiveCall> {
  return Array.from(clientes.get(cliente)?.vivas ?? [])
}

/** Avisa cuando termina una llamada de este cliente (la capa MCP lo usa para `McpElicitation.finishCall`). */
export function alSalir(cliente: object, fn: ((call: LiveCall) => void) | undefined) {
  let c = clientes.get(cliente)
  if (!c) clientes.set(cliente, (c = { vivas: new Set() }))
  c.alSalir = fn
}

export type Atribucion =
  | { kind: "ninguna" }
  | { kind: "ambigua"; sesiones: ReadonlyArray<string> }
  | {
      kind: "sesion"
      sessionID: string
      /** Solo si hay exactamente una llamada viva de esa sesión. */
      callID: string | undefined
      llamadas: ReadonlyArray<LiveCall>
    }

/** Atribuye una solicitud del servidor a la sesión que la provoca (sin adivinar). */
export function atribuir(cliente: object): Atribucion {
  const llamadas = vivas(cliente)
  if (llamadas.length === 0) return { kind: "ninguna" }
  const sesiones = [...new Set(llamadas.map((l) => l.sessionID))]
  if (sesiones.length > 1) return { kind: "ambigua", sesiones }
  return {
    kind: "sesion",
    sessionID: sesiones[0],
    callID: llamadas.length === 1 ? llamadas[0].callID : undefined,
    llamadas,
  }
}

/** Señal que se dispara si CUALQUIERA de las llamadas se aborta (undefined si ninguna tiene señal). */
export function senalDeAborto(llamadas: ReadonlyArray<LiveCall>): AbortSignal | undefined {
  const senales = llamadas.map((l) => l.abort).filter((s): s is AbortSignal => s !== undefined)
  if (senales.length === 0) return undefined
  if (senales.length === 1) return senales[0]
  return AbortSignal.any(senales)
}

/** Pausa el temporizador de todas las llamadas dadas; devuelve la función que las reanuda. */
export function pausarTodas(llamadas: ReadonlyArray<LiveCall>): () => void {
  const reanudar = llamadas.map((l) => l.pausar?.()).filter((f): f is () => void => f !== undefined)
  let hecho = false
  return () => {
    if (hecho) return
    hecho = true
    for (const r of reanudar) r()
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Temporizador pausable
// ---------------------------------------------------------------------------------------------------------------------

export interface Temporizador {
  /** Señal que se pasa al SDK: la del usuario combinada con la del tiempo propio. */
  readonly signal: AbortSignal | undefined
  /** `timeout` que se pasa al SDK (alto si el tiempo lo mide este temporizador). */
  readonly timeout: number | undefined
  /** Se pasa como `onprogress`: reinicia el tiempo (igual que `resetTimeoutOnProgress`). */
  readonly onprogress: () => void
  readonly arrancar: () => void
  readonly parar: () => void
  readonly pausar: () => () => void
  readonly activo: boolean
}

export function crearTemporizador(opts: {
  timeoutMs: number | undefined
  signal: AbortSignal | undefined
  /** Ausente = `elicitacionActiva()`. */
  activo?: boolean
}): Temporizador {
  const activo = opts.activo ?? elicitacionActiva()
  if (!activo) {
    return {
      signal: opts.signal,
      timeout: opts.timeoutMs,
      onprogress: () => {},
      arrancar: () => {},
      parar: () => {},
      pausar: () => () => {},
      activo: false,
    }
  }
  const total = opts.timeoutMs !== undefined && opts.timeoutMs > 0 ? opts.timeoutMs : TIEMPO_LLAMADA_DEFECTO_MS
  const propio = new AbortController()
  const signal = opts.signal ? AbortSignal.any([opts.signal, propio.signal]) : propio.signal
  let timer: ReturnType<typeof setTimeout> | undefined
  let pausas = 0
  let parado = false
  const limpiar = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const armar = () => {
    limpiar()
    if (parado || pausas > 0) return
    timer = setTimeout(() => {
      timer = undefined
      propio.abort(new Error(`MCP request timed out after ${total} ms`))
    }, total)
  }
  return {
    signal,
    timeout: TOPE_SDK_MS,
    onprogress: armar,
    arrancar: armar,
    parar: () => {
      parado = true
      limpiar()
    },
    pausar: () => {
      pausas++
      limpiar()
      let hecho = false
      return () => {
        if (hecho) return
        hecho = true
        pausas--
        // Al reanudar el tiempo vuelve a empezar completo: la persona acaba de contestar.
        armar()
      }
    },
    activo: true,
  }
}

/**
 * Ejecuta `use` como llamada viva: la registra al entrar y la borra al salir (siempre), con el temporizador pausable.
 * Es el único sitio donde se acoplan registro y tiempo, para que la llamada directa, `mcp_call` y Code Mode se comporten igual.
 */
export const conLlamadaViva = <A, E, R>(input: {
  call: Omit<LiveCall, "pausar">
  timeoutMs: number | undefined
  onCall?: OnCall
  use: (t: Temporizador) => Effect.Effect<A, E, R>
}): Effect.Effect<A, E, R> => {
  const onCall = input.onCall ?? registrar
  const t = crearTemporizador({ timeoutMs: input.timeoutMs, signal: input.call.abort })
  const live: LiveCall = { ...input.call, pausar: t.activo ? t.pausar : undefined }
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      t.arrancar()
      onCall("enter", live)
    }),
    () => input.use(t),
    () =>
      Effect.sync(() => {
        t.parar()
        onCall("exit", live)
      }),
  )
}
