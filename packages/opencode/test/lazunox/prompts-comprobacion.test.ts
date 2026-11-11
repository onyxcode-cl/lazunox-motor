import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { SystemPrompt } from "../../src/session/system"
import type { Provider } from "../../src/provider/provider"
import { Token } from "../../src/util/token"

test("todos los textos de modelos piden comprobar el resultado y declarar las pruebas", () => {
  const dir = path.resolve(import.meta.dir, "../../src/session/prompt")
  for (const name of ["anthropic", "default", "default-compacto", "beast", "gemini", "gpt", "gpt-astra", "kimi", "meta", "codex", "trinity"]) {
    const text = fs.readFileSync(path.join(dir, `${name}.txt`), "utf8")
    expect(text).toContain("review each request against the result")
    expect(text).toContain("only if it ran after the last relevant change")
  }
})

const rules = [
  "When 'this' or 'that' has no clear referent or attachment, inspect the working directory and read the likely file before answering; ask only if ambiguity remains.",
  "Fill known details, including today's date for a new letter; mark only unknown details as placeholders.",
  "If you substitute an agent or tool, disclose the substitution and name what you actually used.",
  "Before claiming nothing was found, verify the search scope and filter with a broader check; report limits.",
]

test("cada modelo recibe una sola copia de las cuatro reglas de comprensión, con coste fijo acotado", () => {
  for (const id of [
    "claude-sonnet",
    "gpt-4",
    "gemini-3",
    "gpt-5",
    "gpt-6-luna",
    "gpt-5-codex",
    "kimi-k2",
    "muse-spark",
    "trinity",
    "otro",
  ]) {
    const prompt = SystemPrompt.provider({ providerID: "test", api: { id } } as Provider.Model).join("\n")
    for (const rule of rules) expect(prompt.split(rule)).toHaveLength(2)
  }
  expect(rules).toHaveLength(4)
  expect(Token.estimate("\n" + rules.join("\n"))).toBeLessThanOrEqual(140)
})

test("los dos textos de reserva conservan las mismas cuatro reglas sin depender del recorte", () => {
  for (const name of ["default", "default-compacto"]) {
    const text = fs.readFileSync(path.resolve(import.meta.dir, `../../src/session/prompt/${name}.txt`), "utf8")
    expect(text.endsWith(rules.join("\n") + "\n")).toBe(true)
  }
})
