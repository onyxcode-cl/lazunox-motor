import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

// Lazunox: el motor no debe llamar a servicios de OpenCode. Esta prueba recorre el código fuente y falla si aparece
// un servidor de OpenCode fuera de las excepciones documentadas en LAZUNOX.md (§ "Conexiones a internet").
const RAIZ = path.resolve(import.meta.dir, "../../../..")
const CARPETAS = ["packages/opencode/src", "packages/core/src"]
const PROHIBIDO = /(app|api|dev|models)\.opencode\.ai|opncd\.ai|https:\/\/opencode\.ai\/(install|v2|go|workspace|auth)|anomalyco\/opencode\/releases/

// Ruta (relativa a la raíz) -> motivo. Solo código que NO está en el camino de `serve`.
const EXCEPCIONES: Record<string, string> = {
  "packages/opencode/src/cli/cmd/github.handler.ts": "comando `github` de la CLI; el motor embebido nunca lo ejecuta",
  "packages/opencode/src/cli/cmd/import.ts": "comentario sobre enlaces compartidos",
  "packages/opencode/src/cli/cmd/providers.ts": "texto de ayuda de la CLI",
  "packages/opencode/src/cli/cmd/account.ts": "comando `account` de la CLI",
  "packages/opencode/src/session/retry.ts": "texto de un aviso de OpenCode Go (no hace llamadas)",
  "packages/core/src/plugin/provider/opencode.ts": "proveedor OpenCode Zen (modelos gratuitos); decisión consciente de Lazunox",
}

function* archivos(dir: string): Generator<string> {
  for (const nombre of readdirSync(dir)) {
    const p = path.join(dir, nombre)
    if (statSync(p).isDirectory()) yield* archivos(p)
    else if (/\.(ts|tsx)$/.test(nombre) && !/\.test\.tsx?$/.test(nombre)) yield p
  }
}

describe("sin conexiones a servicios de OpenCode", () => {
  test("el código del motor no menciona servidores de OpenCode fuera de las excepciones", () => {
    const hallazgos: string[] = []
    for (const carpeta of CARPETAS) {
      for (const f of archivos(path.join(RAIZ, carpeta))) {
        const rel = path.relative(RAIZ, f)
        if (EXCEPCIONES[rel]) continue
        readFileSync(f, "utf8")
          .split("\n")
          .forEach((linea, i) => {
            if (PROHIBIDO.test(linea)) hallazgos.push(`${rel}:${i + 1}: ${linea.trim().slice(0, 120)}`)
          })
      }
    }
    expect(hallazgos).toEqual([])
  })

  test("las excepciones apuntan a archivos que existen", () => {
    for (const rel of Object.keys(EXCEPCIONES)) expect(statSync(path.join(RAIZ, rel)).isFile()).toBe(true)
  })
})
