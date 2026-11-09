export * as Confianza from "./confianza"

// Lazunox (lazunox.16, B2, ronda 2). Misma regla que `packages/opencode/src/config/confianza.ts` y
// `packages/opencode/src/project/instance-context.ts` (topeDeProyecto), pero vive en core para que la vía v2
// (location services: `config.ts`, `config/plugin/external.ts`) aplique las mismas dos reglas que la vía v1:
//
//  - E3 (tope del proyecto): sin git, no se sube a las carpetas madre.
//  - E8 (filtro de enlaces): un enlace simbólico dentro de la carpeta confiada no carga algo con destino fuera
//    de la cadena del proyecto.
//
// opencode/src/config/confianza.ts reexporta `filtroDeEnlaces` desde aquí para no duplicar la lógica.
import fs from "fs"
import path from "path"
import { Flag } from "../flag/flag"

/**
 * Hasta dónde sube la carga de config/plugins desde la carpeta abierta. Normal: la raíz del proyecto (repo git, o
 * tope ya resuelto por `project.resolve`). Con la confianza encendida y SIN git (`projectDirectory === "/"`), solo
 * la carpeta misma: sin repo no hay límite razonable, así que no se hereda nada de las carpetas madre (E3).
 */
export function topeDeProyecto(directory: string, projectDirectory: string): string {
  return Flag.LAZUNOX_TRUST_REQUIRED && projectDirectory === "/" ? directory : projectDirectory
}

const dentro = (raiz: string, destino: string) => {
  const rel = path.relative(raiz, destino)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

/**
 * Devuelve el filtro por archivo para una carpeta de configuración, o `undefined` si no hay que filtrar (confianza
 * apagada, o la carpeta es global/externa al proyecto: esa config no se limita). `raiz` = tope del proyecto (ver
 * `topeDeProyecto`). Falla cerrado: si no se puede resolver el enlace, no se carga.
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
