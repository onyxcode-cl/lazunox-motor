export * as ConfigSinCodigo from "./sin-codigo"

import path from "node:path"
import { Flag } from "../flag/flag"

// Lazunox (motor-18, 08.3): el segundo lector admite texto, nunca configuración ejecutable de la carpeta.
export const activo = () => Flag.LAZUNOX_PROYECTO_SIN_CODIGO

export function carpetaSinCodigo(directory: string, home: string) {
  if (!activo()) return false
  if (Flag.OPENCODE_CONFIG_DIR && path.resolve(directory) === path.resolve(Flag.OPENCODE_CONFIG_DIR)) return false
  return path.resolve(directory) !== path.resolve(home, ".opencode")
}

const objeto = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

function textos(value: unknown, keys: readonly string[]) {
  if (!objeto(value)) return {}
  return Object.fromEntries(keys.flatMap((key) => (typeof value[key] === "string" ? [[key, value[key]]] : [])))
}

/** Los permisos y opciones se eliminan antes de validar o migrar, también si el archivo mezcla formatos v1 y v2. */
export function limpiarAgente(value: unknown): Record<string, unknown> {
  return textos(value, ["prompt", "system", "description"])
}

/** La plantilla se conserva como texto; !`...` no conserva su significado de ejecutar una orden. */
export const sinEjecucion = (template: string) => template.replace(/!`([^`]+)`/g, "`$1`")

export function limpiarComando(value: unknown): Record<string, unknown> {
  const command = textos(value, ["template", "description"])
  return typeof command.template === "string" ? { ...command, template: sinEjecucion(command.template) } : command
}

export function limpiarInfo(value: unknown): Record<string, unknown> {
  if (!objeto(value)) return {}
  const result: Record<string, unknown> = textos(value, ["$schema", "username"])
  for (const key of ["agent", "agents", "mode", "command", "commands"]) {
    if (!objeto(value[key])) continue
    const clean = key === "command" || key === "commands" ? limpiarComando : limpiarAgente
    result[key] = Object.fromEntries(Object.entries(value[key]).map(([name, entry]) => [name, clean(entry)]))
  }
  if (Array.isArray(value.instructions))
    result.instructions = value.instructions.filter((item) => typeof item === "string")
  if (Array.isArray(value.skills)) result.skills = value.skills.filter((item) => typeof item === "string")
  else if (objeto(value.skills) && Array.isArray(value.skills.paths)) {
    result.skills = { paths: value.skills.paths.filter((item) => typeof item === "string") }
  }
  return result
}
