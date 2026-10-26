// Lazunox (Ola 7, 7.8): finales de línea por región. La edición se hace sobre una «vista» con todos los finales en LF
// (así `oldString`, que el modelo escribe con LF, coincide aunque el archivo sea CRLF, CR o mixto) y al volver se
// reescribe cada línea con el final que tenía. Las líneas nuevas heredan el final de la línea que reemplazan o, si no
// reemplazan ninguna, el de la línea anterior (o el dominante del archivo).
import { diffArrays } from "diff"

export interface Finales {
  /** Texto con todos los finales como "\n". */
  readonly vista: string
  /** Final de la línea i (i < lineas-1): "\r\n" | "\r" | "\n". */
  readonly finales: readonly string[]
  readonly dominante: string
}

export function dividir(text: string): Finales {
  const lineas: string[] = []
  const finales: string[] = []
  const re = /\r\n|\r|\n/g
  let desde = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    lineas.push(text.slice(desde, m.index))
    finales.push(m[0])
    desde = m.index + m[0].length
  }
  lineas.push(text.slice(desde))
  const cuenta = new Map<string, number>()
  for (const f of finales) cuenta.set(f, (cuenta.get(f) ?? 0) + 1)
  let dominante = "\n"
  let max = 0
  for (const [f, n] of cuenta) if (n > max) ((dominante = f), (max = n))
  return { vista: lineas.join("\n"), finales, dominante }
}

/** Vista LF de un texto cualquiera (lo que escribe el modelo). */
export function aVista(text: string) {
  return text.replace(/\r\n|\r/g, "\n")
}

/** Reescribe `nueva` (vista LF ya editada) con los finales de la vista original. */
export function restaurar(nueva: string, origen: Finales): string {
  if (origen.finales.every((f) => f === "\n")) return nueva
  if (origen.finales.every((f) => f === origen.finales[0])) {
    // archivo homogéneo: todo el texto nuevo con ese final, como antes
    return origen.finales[0] === "\n" ? nueva : nueva.replaceAll("\n", origen.finales[0])
  }
  const viejas = origen.vista.split("\n")
  const nuevas = nueva.split("\n")
  const partes = diffArrays(viejas, nuevas)
  const out: string[] = []
  let oi = 0
  let ultimo = origen.dominante
  let borrados: string[] = []
  const finalDe = (i: number) => (i < origen.finales.length ? origen.finales[i] : undefined)
  for (const parte of partes) {
    const n = parte.count ?? parte.value.length
    if (parte.removed) {
      for (let k = 0; k < n; k++) borrados.push(finalDe(oi + k) ?? ultimo)
      oi += n
    } else if (parte.added) {
      for (let k = 0; k < n; k++) {
        const f = borrados.length ? borrados[Math.min(k, borrados.length - 1)] : ultimo
        out.push(f)
        ultimo = f
      }
      borrados = []
    } else {
      borrados = []
      for (let k = 0; k < n; k++) {
        const f = finalDe(oi + k) ?? ultimo
        out.push(f)
        ultimo = f
      }
      oi += n
    }
  }
  // out tiene un final por línea nueva; el de la última línea no se escribe
  let res = ""
  for (let i = 0; i < nuevas.length; i++) res += nuevas[i] + (i < nuevas.length - 1 ? (out[i] ?? origen.dominante) : "")
  return res
}
