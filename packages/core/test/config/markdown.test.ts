import { expect, test } from "bun:test"
import path from "node:path"
import { ConfigMarkdown } from "@opencode-ai/core/config/markdown"
import { tmpdir } from "../fixture/tmpdir"

for (const language of ["js", "javascript", "JAVASCRIPT"]) {
  test(`no ejecuta encabezados ${language}`, async () => {
    await using tmp = await tmpdir()
    const sentinel = path.join(tmp.path, "centinela.txt")
    const text = `---${language}\n(require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "encabezado"), { description: "texto" })\n---\nTexto`
    expect(ConfigMarkdown.parseOption(text)).toBeUndefined()
    expect(await Bun.file(sentinel).exists()).toBe(false)
  })
}

test("conserva YAML y su corrección de dos puntos", () => {
  expect(ConfigMarkdown.parse("---\ndescription: Texto: más texto\n---\nCuerpo")).toMatchObject({
    data: { description: "Texto: más texto" },
    content: "Cuerpo",
  })
})

test("conserva encabezados JSON", () => {
  expect(ConfigMarkdown.parse('---json\n{"description":"Texto"}\n---\nCuerpo')).toMatchObject({
    data: { description: "Texto" },
    content: "Cuerpo",
  })
})
