// Lazunox (Ola 7, 7.9): `@imports` en AGENTS.md / CLAUDE.md. Una línea que sea SOLO `@ruta/relativa.md` se sustituye por el contenido de
// ese archivo (como Claude Code), con hasta 4 niveles. El contenido importado es DATO de contexto, igual que el archivo que lo importa.
//
// Seguridad: solo archivos dentro de la carpeta del proyecto (tras realpath, así que un symlink que escapa no vale; `~` se rechaza);
// nunca archivos sensibles (.env*, llaves, auth.json, *.pem…), aunque estén dentro; detección de ciclos; topes de bytes por archivo y
// total. Cualquier fallo deja una nota breve en lugar de la línea y NUNCA lanza ni rompe la carga. Una línea dentro de un bloque de
// código (``` o ~~~) no se expande. `LAZUNOX_IMPORTS=0` lo apaga (comportamiento anterior: el texto queda tal cual).
import fsp from "node:fs/promises"
import path from "node:path"

export const activo = (env: NodeJS.ProcessEnv = process.env) => env.LAZUNOX_IMPORTS !== "0"

export const NIVELES_MAX = 4
export const ARCHIVO_MAX_BYTES = 32 * 1024
export const TOTAL_MAX_BYTES = 128 * 1024

export interface Opciones {
  niveles?: number
  archivoMaxBytes?: number
  totalMaxBytes?: number
}

const dentro = (raiz: string, p: string) => p === raiz || p.startsWith(raiz.endsWith(path.sep) ? raiz : raiz + path.sep)

const NOMBRE_SENSIBLE = [
  /^\.env(\..*)?$/i,
  /^auth\.json$/i,
  /\.(pem|key|p12|pfx|jks|keystore|crt|cer|der|asc|gpg)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\..*)?$/i,
  /^\.(npmrc|netrc|pypirc|git-credentials|pgpass)$/i,
  /^(credentials|secrets?)(\..*)?$/i,
  /^.*\.(secret|secrets)$/i,
]
const CARPETA_SENSIBLE = new Set([".ssh", ".aws", ".gnupg", ".kube", ".docker"])

/** ¿Es un archivo que nunca se importa? Se mira el nombre pedido y el real (un enlace «ok.md» → «.env» no pasa). */
export function esSensible(...rutas: string[]) {
  for (const r of rutas) {
    const partes = r.split(/[\\/]+/).filter(Boolean)
    if (partes.some((p) => CARPETA_SENSIBLE.has(p))) return true
    const nombre = partes.at(-1) ?? ""
    if (NOMBRE_SENSIBLE.some((re) => re.test(nombre))) return true
  }
  return false
}

const IMPORT = /^\s*@(\S+)\s*$/
/** Apertura/cierre de un bloque de código vallado. */
const VALLA = /^\s{0,3}(`{3,}|~{3,})/

/** ¿Parece una ruta (lleva «/» o «.»)? Evita tratar «@todo» o una mención suelta como import. */
const pareceRuta = (s: string) => /[/.]/.test(s)

export async function expandir(
  texto: string,
  archivo: string,
  raiz: string,
  opciones: Opciones = {},
): Promise<{ texto: string; notas: string[] }> {
  const notas: string[] = []
  try {
    const niveles = opciones.niveles ?? NIVELES_MAX
    const archivoMax = opciones.archivoMaxBytes ?? ARCHIVO_MAX_BYTES
    const totalMax = opciones.totalMaxBytes ?? TOTAL_MAX_BYTES
    const raizReal = await fsp.realpath(raiz).catch(() => undefined)
    const real = await fsp.realpath(archivo).catch(() => undefined)
    // El archivo de partida debe ser del proyecto; uno de fuera (p. ej. el AGENTS.md global) no importa nada.
    if (!raizReal || !real || !dentro(raizReal, real) || !texto.includes("@")) return { texto, notas }
    let usados = 0

    const nota = (ruta: string, motivo: string) => {
      const n = `[@import omitido: ${ruta.slice(0, 80)} (${motivo})]`
      notas.push(n)
      return n
    }

    const proceso = async (cuerpo: string, base: string, pila: string[], nivel: number): Promise<string> => {
      const salida: string[] = []
      let valla: { c: string; n: number } | undefined
      for (const linea of cuerpo.split("\n")) {
        const v = VALLA.exec(linea)
        if (v) {
          const marca = v[1]!
          if (!valla) valla = { c: marca[0]!, n: marca.length }
          else if (marca[0] === valla.c && marca.length >= valla.n && linea.trim() === marca) valla = undefined
          salida.push(linea)
          continue
        }
        const m = valla ? null : IMPORT.exec(linea.replace(/\r$/, ""))
        if (!m || !pareceRuta(m[1]!)) {
          salida.push(linea)
          continue
        }
        salida.push(await importar(m[1]!, base, pila, nivel))
      }
      return salida.join("\n")
    }

    const importar = async (pedida: string, base: string, pila: string[], nivel: number): Promise<string> => {
      try {
        if (nivel + 1 > niveles) return nota(pedida, `más de ${niveles} niveles`)
        if (pedida.startsWith("~") || pedida.includes("\0")) return nota(pedida, "ruta no permitida")
        const candidata = path.isAbsolute(pedida) ? pedida : path.resolve(base, pedida)
        if (esSensible(pedida, candidata)) return nota(pedida, "archivo sensible")
        const destino = await fsp.realpath(candidata).catch(() => undefined)
        if (!destino) return nota(pedida, "no existe")
        if (!dentro(raizReal, destino)) return nota(pedida, "fuera del proyecto")
        if (esSensible(destino)) return nota(pedida, "archivo sensible")
        if (pila.includes(destino)) return nota(pedida, "ciclo")
        const st = await fsp.stat(destino).catch(() => undefined)
        if (!st?.isFile()) return nota(pedida, "no es un archivo")
        if (st.size > archivoMax) return nota(pedida, "archivo demasiado grande")
        if (usados + st.size > totalMax) return nota(pedida, "tope total de imports")
        const buf = await fsp.readFile(destino)
        if (buf.byteLength > archivoMax) return nota(pedida, "archivo demasiado grande")
        if (buf.includes(0)) return nota(pedida, "no es texto")
        usados += buf.byteLength
        const hijo = buf.toString("utf-8")
        const expandido = await proceso(hijo, path.dirname(destino), [...pila, destino], nivel + 1)
        return expandido.replace(/\n+$/, "")
      } catch {
        return nota(pedida, "no se pudo leer")
      }
    }

    return { texto: await proceso(texto, path.dirname(real), [real], 0), notas }
  } catch {
    return { texto, notas }
  }
}
