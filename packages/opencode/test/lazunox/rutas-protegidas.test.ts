import { describe, expect, test } from "bun:test"
import { activo, esProtegida } from "../../src/permission/rutas-protegidas"

describe("rutas protegidas", () => {
  test("reconoce carpetas y archivos sensibles, con / o \\ y en cualquier nivel", () => {
    for (const p of [
      ".git/hooks/pre-commit",
      "sub/.git/config",
      ".opencode/plugins/x.js",
      ".claude/settings.json",
      ".mcp.json",
      "app/.mcp.json",
      ".vscode/tasks.json",
      ".husky/pre-push",
      "C:\\proy\\.git\\hooks\\pre-commit",
      "./.GIT/config",
      ".gitmodules",
    ])
      expect(esProtegida(p)).toBe(true)
  })
  test("lazunox.15: opencode.json y opencode.jsonc (cualquier nivel, mayúsculas, \\) preguntan; package.json y tui.json no", () => {
    for (const p of ["opencode.json", "opencode.jsonc", "app/opencode.json", "./OpenCode.JSON", "C:\\proy\\opencode.jsonc", "../opencode.json"])
      expect(esProtegida(p)).toBe(true)
    // la protección sigue siendo por nombre exacto: parecidos no se marcan
    for (const p of ["package.json", "tui.json", "opencode.json.bak", "opencode.jsonl", "docs/opencode.md", "myopencode.json"])
      expect(esProtegida(p)).toBe(false)
    // apagable con el interruptor general (la decisión de no preguntar la toma quien llama a `activo`)
    expect(activo({ LAZUNOX_PROTECTED_PATHS: "0" } as NodeJS.ProcessEnv)).toBe(false)
  })
  test("no marca rutas normales ni nombres parecidos", () => {
    for (const p of ["src/index.ts", "README.md", "docs/git.md", ".github/workflows/ci.yml", ".gitignore", "my.git/x", "gitconfig.txt", "", "."])
      expect(esProtegida(p)).toBe(false)
  })
  test("se puede apagar", () => {
    expect(activo({} as NodeJS.ProcessEnv)).toBe(true)
    expect(activo({ LAZUNOX_PROTECTED_PATHS: "0" } as NodeJS.ProcessEnv)).toBe(false)
  })
})
