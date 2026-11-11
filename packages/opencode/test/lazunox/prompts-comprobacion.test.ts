import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

test("todos los textos de modelos piden comprobar el resultado y declarar las pruebas", () => {
  const dir = path.resolve(import.meta.dir, "../../src/session/prompt")
  for (const name of ["anthropic", "default", "default-compacto", "beast", "gemini", "gpt", "gpt-astra", "kimi", "meta", "codex", "trinity"]) {
    const text = fs.readFileSync(path.join(dir, `${name}.txt`), "utf8")
    expect(text).toContain("review each request against the result")
    expect(text).toContain("only if it ran after the last relevant change")
  }
})
