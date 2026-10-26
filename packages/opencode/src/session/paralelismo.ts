// Lazunox (Ola 7 — 7.3): paralelismo seguro. El AI SDK lanza cada `execute` en cuanto llega su llamada, así que todas las
// herramientas de un paso corrían a la vez, también las que escriben. Aquí hay un candado de lectura/escritura POR SESIÓN:
// las herramientas de solo lectura toman el candado compartido (siguen en paralelo) y las demás el exclusivo (esperan a las
// anteriores y bloquean a las siguientes). Cola FIFO: el orden de llegada = el orden pedido por el modelo, así una lectura
// pedida DESPUÉS de una escritura ve el efecto de la escritura. `LAZUNOX_PARALELISMO_SEGURO=0` lo apaga.
//
// Los permisos se piden DENTRO del `execute` de cada herramienta (con el candado ya tomado): un permiso pendiente de una
// herramienta exclusiva retiene el candado hasta que la persona responde, y las lecturas lanzadas ANTES ya estaban dentro.
// No hay interbloqueo posible: quien espera el candado no retiene nada que el permiso necesite, y el candado es por sesión
// (un ayudante `task` usa el candado de su propia sesión).

export const activo = (env: NodeJS.ProcessEnv = process.env) => env.LAZUNOX_PARALELISMO_SEGURO !== "0"

/** Lista cerrada de herramientas que comparten el candado (solo leen, o delegan como `task`). El resto (shell, edit, write, apply_patch…) es exclusivo. */
export const SOLO_LECTURA: ReadonlySet<string> = new Set([
  "read",
  "glob",
  "grep",
  "skill",
  "task_list",
  "tool_search",
  // Herramientas de recursos MCP que arma `session/tools.ts`: solo listan o leen.
  // Desviación del plan: `task` comparte el candado (no escribe él mismo: lo hace el ayudante, en SU sesión y con SU candado).
  // Si fuera exclusivo, las unidades en paralelo de `lote` y los ayudantes simultáneos pasarían a correr uno tras otro.
  "task",
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
])

/** `true` si la herramienta puede compartir el candado: id de la lista cerrada. */
export function esSoloLectura(id: string): boolean {
  return SOLO_LECTURA.has(id)
}

/** Herramienta MCP que declara `annotations.readOnlyHint === true` (solo ese valor exacto). */
export function mcpSoloLectura(def: unknown): boolean {
  return (def as { annotations?: { readOnlyHint?: unknown } } | undefined)?.annotations?.readOnlyHint === true
}

type Espera = { modo: "lectura" | "escritura"; entrar: () => void }

export class Candado {
  private lectores = 0
  private escritor = false
  private cola: Espera[] = []

  /** Estado para pruebas. */
  get estado() {
    return { lectores: this.lectores, escritor: this.escritor, esperando: this.cola.length }
  }

  private puedeEntrar(modo: Espera["modo"]) {
    return modo === "lectura" ? !this.escritor : !this.escritor && this.lectores === 0
  }

  private avanzar() {
    // FIFO estricto: si el primero no cabe, nadie pasa (una escritura no se queda sin turno por lecturas posteriores).
    while (this.cola.length > 0 && this.puedeEntrar(this.cola[0]!.modo)) {
      const siguiente = this.cola.shift()!
      siguiente.entrar()
    }
  }

  /** Resuelve con la función que libera. Si `senal` se aborta mientras espera, sale de la cola y rechaza. */
  adquirir(modo: Espera["modo"], senal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (senal?.aborted) return reject(new Error("Interrumpido mientras esperaba el turno de la herramienta"))
      let liberado = false
      const liberar = () => {
        if (liberado) return
        liberado = true
        if (modo === "lectura") this.lectores--
        else this.escritor = false
        this.avanzar()
      }
      const espera: Espera = {
        modo,
        entrar: () => {
          senal?.removeEventListener("abort", alAbortar)
          if (modo === "lectura") this.lectores++
          else this.escritor = true
          resolve(liberar)
        },
      }
      const alAbortar = () => {
        const i = this.cola.indexOf(espera)
        if (i < 0) return
        this.cola.splice(i, 1)
        reject(new Error("Interrumpido mientras esperaba el turno de la herramienta"))
        this.avanzar()
      }
      senal?.addEventListener("abort", alAbortar, { once: true })
      this.cola.push(espera)
      this.avanzar()
    })
  }
}

const candados = new Map<string, Candado>()

/** Candado de la sesión (se crea al vuelo y se descarta cuando queda libre y sin cola). */
export function candadoDe(sessionID: string): Candado {
  let c = candados.get(sessionID)
  if (!c) {
    c = new Candado()
    candados.set(sessionID, c)
  }
  return c
}

/** Ejecuta `fn` con el candado de la sesión. Con el interruptor apagado, ejecuta directo. */
export async function conCandado<T>(
  sessionID: string,
  soloLectura: boolean,
  senal: AbortSignal | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!activo()) return fn()
  const c = candadoDe(sessionID)
  const liberar = await c.adquirir(soloLectura ? "lectura" : "escritura", senal)
  try {
    return await fn()
  } finally {
    liberar()
    const e = c.estado
    if (e.lectores === 0 && !e.escritor && e.esperando === 0 && candados.get(sessionID) === c) candados.delete(sessionID)
  }
}
