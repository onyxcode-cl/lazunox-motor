// Lazunox (Ola 7, 7.5): dónde se aplica el sanitizador de secretos (`@opencode-ai/core/sanitizar`) a las partes de herramienta.
//   Nivel 1 (siempre, salvo LAZUNOX_SANITIZAR=0): lo que se MUESTRA y se guarda del llamado: el comando de shell, el título y los
//     metadatos (vista previa de la salida, ruta del comando…). El comando que se ejecuta NO cambia: solo lo que queda en la parte.
//   Nivel 2 (LAZUNOX_SANITIZAR_MODELO=1): además lo que VE EL MODELO de la salida de shell y de celdas de Code Mode.
import fs from "fs/promises"
import path from "path"
import { TRUNCATION_DIR } from "@/tool/truncation-dir"
import { activo, activoParaElModelo, sanitizar, sanitizarProfundo } from "@opencode-ai/core/sanitizar"

/**
 * Herramientas cuya salida puede traer secretos hacia el modelo (el nivel 2 solo toca estas): comandos, guiones y también
 * `read`/`grep` (el banco mostró que el modelo lee `.entorno` con `read`). Solo se enmascaran los patrones que el sanitizador
 * reconoce como secretos; el archivo en disco no cambia, así que `edit` sigue funcionando salvo que el texto citado sea el secreto.
 */
const SALIDA_DE_COMANDO = new Set(["bash", "shell_wait", "execute", "execute_wait", "read", "grep"])

export const esSalidaDeComando = (tool: string) => SALIDA_DE_COMANDO.has(tool)

/** Entrada que se guarda: del shell se sanea `command` y `description`; el resto queda igual. */
export function entradaGuardada(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  if (!activo() || tool !== "bash") return input
  const command = typeof input.command === "string" ? sanitizar(input.command) : input.command
  const description = typeof input.description === "string" ? sanitizar(input.description) : input.description
  if (command === input.command && description === input.description) return input
  return { ...input, command, description }
}

export function textoGuardado(titulo: string) {
  return activo() ? sanitizar(titulo) : titulo
}

export function metadatosGuardados<T>(metadata: T): T {
  return activo() ? sanitizarProfundo(metadata) : metadata
}

/** Texto que llega al modelo desde un comando: solo con LAZUNOX_SANITIZAR_MODELO=1. */
export function textoParaElModelo(tool: string, texto: string) {
  return activoParaElModelo() && esSalidaDeComando(tool) ? sanitizar(texto) : texto
}

/**
 * Nivel 2 sobre el resultado de una herramienta de comando, antes de que llegue al modelo: sanea `output` y, si la salida larga
 * quedó en un archivo de la carpeta de salidas del motor, reescribe ese archivo sin secretos (el modelo lo puede abrir por ruta).
 */
export async function resultadoParaElModelo<T>(tool: string, resultado: T): Promise<T> {
  if (!activoParaElModelo() || !esSalidaDeComando(tool) || typeof resultado !== "object" || resultado === null) return resultado
  const r = resultado as { output?: unknown; metadata?: unknown }
  if (typeof r.output === "string") r.output = sanitizar(r.output)
  const meta = r.metadata
  const archivo = typeof meta === "object" && meta !== null ? (meta as { outputPath?: unknown }).outputPath : undefined
  if (typeof archivo === "string" && path.resolve(archivo).startsWith(TRUNCATION_DIR + path.sep)) {
    const original = await fs.readFile(archivo, "utf-8").catch(() => undefined)
    if (original !== undefined) {
      const limpio = sanitizar(original)
      if (limpio !== original) await fs.writeFile(archivo, limpio).catch(() => undefined)
    }
  }
  return resultado
}
