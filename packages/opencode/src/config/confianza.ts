// Lazunox (lazunox.16, B2, E8): con la confianza encendida, un plugin, config, agente, comando o skill de una carpeta confiada que sea
// un ENLACE SIMBÓLICO con destino fuera de la cadena del proyecto (la carpeta y sus madres hasta la raíz del repo) no se carga: confiar
// en una carpeta es confiar en lo que HAY en ella, no en lo que un enlace apunte fuera. Falla cerrado (si no se puede resolver, no se carga).
import fs from "fs"
import path from "path"
import { Flag } from "@opencode-ai/core/flag/flag"

const dentro = (raiz: string, destino: string) => {
  const rel = path.relative(raiz, destino)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

/**
 * Devuelve el filtro por archivo para una carpeta de configuración, o `undefined` si no hay que filtrar (confianza apagada, o la
 * carpeta es global: la config del usuario no se limita). `raiz` = tope del proyecto (raíz del repo, o la carpeta sin git).
 */
export function filtroDeEnlaces(raiz: string, dirDeConfig: string): ((file: string) => boolean) | undefined {
  if (!Flag.LAZUNOX_TRUST_REQUIRED) return undefined
  let raizReal: string
  try {
    raizReal = fs.realpathSync.native(raiz)
  } catch {
    return () => false
  }
  // Una carpeta de config que no está bajo el proyecto (global, ~/.opencode, OPENCODE_CONFIG_DIR) no se limita.
  const lex = path.relative(path.resolve(raiz), path.resolve(dirDeConfig))
  if (lex.startsWith("..") || path.isAbsolute(lex)) return undefined
  return (file: string) => {
    try {
      return dentro(raizReal, fs.realpathSync.native(file))
    } catch {
      return false
    }
  }
}
