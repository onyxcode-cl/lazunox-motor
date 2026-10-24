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
  test("no marca rutas normales ni nombres parecidos", () => {
    for (const p of ["src/index.ts", "README.md", "docs/git.md", ".github/workflows/ci.yml", ".gitignore", "my.git/x", "gitconfig.txt", "", "."])
      expect(esProtegida(p)).toBe(false)
  })
  test("se puede apagar", () => {
    expect(activo({} as NodeJS.ProcessEnv)).toBe(true)
    expect(activo({ LAZUNOX_PROTECTED_PATHS: "0" } as NodeJS.ProcessEnv)).toBe(false)
  })
})
