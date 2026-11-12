import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { SystemPrompt } from "../../src/session/system"
import type { Provider } from "../../src/provider/provider"
import { Token } from "../../src/util/token"
import { Comprension } from "../../src/session/comprension"
import hashes from "../fixture/prompts-comprension-sha256.json"

const original = {
  LAZUNOX_VISTAZO_CARPETA: process.env.LAZUNOX_VISTAZO_CARPETA,
  LAZUNOX_LINEAS_COMPRENSION: process.env.LAZUNOX_LINEAS_COMPRENSION,
  LAZUNOX_AHORRO_TOKENS: process.env.LAZUNOX_AHORRO_TOKENS,
}

beforeEach(() => {
  for (const key of Object.keys(original)) delete process.env[key]
})

afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test("todos los textos de modelos piden comprobar el resultado y declarar las pruebas", () => {
  const dir = path.resolve(import.meta.dir, "../../src/session/prompt")
  for (const name of [
    "anthropic",
    "default",
    "default-compacto",
    "beast",
    "gemini",
    "gpt",
    "gpt-astra",
    "kimi",
    "meta",
    "codex",
    "trinity",
  ]) {
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

// Huellas obtenidas de git show 7bac581^:<ruta> (base) y 7bac581:<ruta> (enabled).
// La prueba no necesita git ni reconstruye el resultado histórico con el código nuevo.
test("los once textos base son idénticos al padre y por defecto se reproduce 7bac581 byte a byte", async () => {
  for (const [name, hash] of Object.entries(hashes)) {
    const text = await Bun.file(path.resolve(import.meta.dir, `../../src/session/prompt/${name}.txt`)).text()
    expect(new Bun.CryptoHasher("sha256").update(text).digest("hex")).toBe(hash.base)
    expect(new Bun.CryptoHasher("sha256").update(Comprension.agregarLineas(text)).digest("hex")).toBe(hash.enabled)
    process.env.LAZUNOX_LINEAS_COMPRENSION = "0"
    expect(Comprension.agregarLineas(text)).toBe(text)
    delete process.env.LAZUNOX_LINEAS_COMPRENSION
  }
})

const routes = [
  { id: "claude-sonnet", name: "anthropic" },
  { id: "gpt-4", name: "beast" },
  { id: "o1", name: "beast" },
  { id: "o3", name: "beast" },
  { id: "gemini-3", name: "gemini" },
  { id: "gpt-5", name: "gpt" },
  { id: "gpt-6-luna", name: "gpt-astra" },
  { id: "gpt-5-codex", name: "codex" },
  { id: "kimi-k2", name: "kimi" },
  { id: "k3", name: "kimi", providerID: "moonshotai" },
  { id: "muse-spark", name: "meta", modelName: "Muse Spark" },
  { id: "muse-glimmer", name: "meta", modelName: "Muse Glimmer" },
  { id: "trinity", name: "trinity" },
  { id: "otro", name: "default", ahorro: "0" },
  { id: "otro", name: "default-compacto", ahorro: "on" },
]

for (const preview of ["0", "1"]) {
  for (const mask of Array.from({ length: 16 }, (_, index) => index)) {
    test(`texto de sistema: vistazo=${preview}, subconjunto=${mask}`, async () => {
      const selected = rules.filter((_, index) => (mask & (1 << index)) !== 0)
      process.env.LAZUNOX_VISTAZO_CARPETA = preview
      process.env.LAZUNOX_LINEAS_COMPRENSION =
        rules.flatMap((_, index) => ((mask & (1 << index)) !== 0 ? [index + 1] : [])).join(",") || "0"
      for (const route of routes) {
        process.env.LAZUNOX_AHORRO_TOKENS = route.ahorro ?? "on"
        const base = (
          await Bun.file(path.resolve(import.meta.dir, `../../src/session/prompt/${route.name}.txt`)).text()
        ).replaceAll("{{MODEL_NAME}}", route.modelName ?? "")
        expect(
          SystemPrompt.provider({ providerID: route.providerID ?? "test", api: { id: route.id } } as Provider.Model),
        ).toEqual([base + (selected.length === 0 ? "" : "\n" + selected.join("\n") + "\n")])
      }
    })
  }
}

test("la selección cambia después de importar; vacío/on activan todas, 1 solo la primera y la lista no duplica ni reordena", () => {
  for (const value of ["", "on", " ON "]) {
    process.env.LAZUNOX_LINEAS_COMPRENSION = value
    expect(Comprension.agregarLineas("base\n")).toBe("base\n\n" + rules.join("\n") + "\n")
  }
  process.env.LAZUNOX_LINEAS_COMPRENSION = "1"
  expect(Comprension.agregarLineas("base\n")).toBe("base\n\n" + rules[0] + "\n")
  process.env.LAZUNOX_LINEAS_COMPRENSION = " 4,2,2,desconocido,5 "
  expect(Comprension.agregarLineas("base\n")).toBe("base\n\n" + rules[1] + "\n" + rules[3] + "\n")
  process.env.LAZUNOX_LINEAS_COMPRENSION = "desconocido"
  expect(Comprension.agregarLineas("base\n")).toBe("base\n")
  process.env.LAZUNOX_LINEAS_COMPRENSION = "0"
  expect(Comprension.agregarLineas("base\n")).toBe("base\n")
})
