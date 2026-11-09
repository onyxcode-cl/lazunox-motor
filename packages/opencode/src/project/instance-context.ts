import { LocalContext } from "@/util/local-context"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Flag } from "@opencode-ai/core/flag/flag"
import type * as Project from "./project"

export interface InstanceContext {
  directory: string
  worktree: string
  project: Project.Info
  /**
   * Lazunox (lazunox.16, B2): instancia «fría» de una carpeta NO confiada (solo con LAZUNOX_TRUST_REQUIRED). Solo lee la
   * configuración global/inline: sin config del proyecto ni de carpetas superiores, sin instalar dependencias, sin plugins, conectores,
   * agentes, comandos, skills ni instrucciones de la carpeta. Es el reemplazo POR INSTANCIA de OPENCODE_DISABLE_PROJECT_CONFIG.
   */
  cold?: boolean
}

/** ¿Hay que ignorar la configuración del proyecto? Bandera global heredada (OPENCODE_DISABLE_PROJECT_CONFIG) o instancia fría. */
export const sinConfigDeProyecto = (ctx?: { cold?: boolean }) => Flag.OPENCODE_DISABLE_PROJECT_CONFIG || ctx?.cold === true

/**
 * Hasta dónde sube la carga de config/instrucciones/skills desde la carpeta. Normal: la raíz del repo git (`worktree`). Con la
 * confianza encendida y SIN git (`worktree === "/"`), solo la carpeta misma: sin repo no hay límite razonable, así que no se hereda
 * nada de las carpetas madre (decisión E3).
 */
export const topeDeProyecto = (ctx: { directory: string; worktree: string }) =>
  Flag.LAZUNOX_TRUST_REQUIRED && ctx.worktree === "/" ? ctx.directory : ctx.worktree

export const context = LocalContext.create<InstanceContext>("instance")

/**
 * Check if a path is within the project boundary.
 * Returns true if path is inside ctx.directory OR ctx.worktree.
 * Paths within the worktree but outside the working directory should not trigger external_directory permission.
 */
export function containsPath(filepath: string, ctx: InstanceContext): boolean {
  if (FSUtil.contains(ctx.directory, filepath)) return true
  // Non-git projects set worktree to "/" which would match ANY absolute path.
  // Skip worktree check in this case to preserve external_directory permissions.
  if (ctx.worktree === "/") return false
  return FSUtil.contains(ctx.worktree, filepath)
}
