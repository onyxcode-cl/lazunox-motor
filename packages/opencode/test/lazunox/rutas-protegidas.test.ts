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
  test("lazunox.15: opencode.json y opencode.jsonc (cualquier nivel, mayúsculas, \\) preguntan; package.json no", () => {
    for (const p of ["opencode.json", "opencode.jsonc", "app/opencode.json", "./OpenCode.JSON", "C:\\proy\\opencode.jsonc", "../opencode.json"])
      expect(esProtegida(p)).toBe(true)
    // la protección sigue siendo por nombre exacto: parecidos no se marcan
    for (const p of ["package.json", "opencode.json.bak", "opencode.jsonl", "docs/opencode.md", "myopencode.json"])
      expect(esProtegida(p)).toBe(false)
    // apagable con el interruptor general (la decisión de no preguntar la toma quien llama a `activo`)
    expect(activo({ LAZUNOX_PROTECTED_PATHS: "0" } as NodeJS.ProcessEnv)).toBe(false)
  })
  test("ronda 2: tui.json/tui.jsonc y los alias de Windows (punto/espacio final, ::$DATA, nombre 8.3) también", () => {
    for (const p of [
      "tui.json",
      "sub/tui.jsonc",
      "opencode.json.",
      "opencode.json...",
      "opencode.json ",
      "opencode.json::$DATA",
      "opencode.jsonc:stream:$DATA",
      "OPENCO~1.JSO",
      "sub\\OPENCO~1.JSO",
      "MCP~1.JSO",
      ".mcp.json.",
      ".mcp.json::$DATA",
      ".git./hooks/pre-commit",
      ".git::$INDEX_ALLOCATION/config",
      "GIT~1/config",
      "x\\.git.\\hooks\\pre-commit",
    ])
      expect(esProtegida(p)).toBe(true)
    // sin falsos positivos con nombres normales
    for (const p of ["notas~backup.md", "a~b.txt", "docs/leeme.txt.", "src/index.ts", "C:/proy/src/a.ts", "~/x.ts"]) expect(esProtegida(p)).toBe(false)
  })
  test("2.ª ronda: alias Unicode de APFS/NTFS (ſ → s) y compatibilidad (NFKC) también están protegidos", () => {
    for (const p of [
      "opencode.j\u017Fon",
      "OPENCODE.J\u017FON",
      "sub/opencode.j\u017Fonc",
      ".hu\u017Fky/pre-commit",
      ".v\u017Fcode/tasks.json",
      ".mcp.j\u017Fon",
      "tui.j\u017Fon",
      ".gitmodule\u017F",
      ".gitattribute\u017F",
      "\uFF4Fpencode.json", // o ancho completo
      ".\u212Aaude", // kelvin (no aplica, pero no debe romper)
    ])
      expect(esProtegida(p), p).toBe(p === ".\u212Aaude" ? false : true)
  })
  test("2.ª ronda: 8.3 solo de nombres PROTEGIDOS; los benignos no preguntan", () => {
    for (const p of ["OPENCO~1.JSO", "OPENCO~2.JSO", "GIT~1/config", "MCP~1.JSO", "HUSKY~1/pre-commit", "VSCODE~1/tasks.json", "TUI~1.JSO", "GITMOD~1", "GITATT~1", "GITCON~1", "CLAUDE~1/x", "IDEA~1/x", "OPENCO~1/x", "OP1A2B~1.JSO", "sub/GIT~3"])
      expect(esProtegida(p), p).toBe(true)
    for (const p of [
      "notes~1.md",
      "build~2/x.ts",
      "file~1",
      "v~2.txt",
      "C:\\Users\\JUANPE~1\\proj\\src\\a.ts",
      "C:/Users/RUNNER~1/AppData/Local/Temp/x/a.ts",
      "PROGRA~1/x.dll",
      "OPENCO~1.TXT", // extensión que no es la del archivo protegido
      "GIT~1.md",
    ])
      expect(esProtegida(p), p).toBe(false)
  })
  test("2.ª ronda: unidad relativa de Windows (c:opencode.json) también", () => {
    expect(esProtegida("c:opencode.json")).toBe(true)
    expect(esProtegida("c:.git/config")).toBe(true)
    expect(esProtegida("c:src/a.ts")).toBe(false)
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

// --- Enlaces simbólicos (2.ª ronda): se evalúa también el destino real, también si el enlace está roto ---
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
describe("rutas protegidas y enlaces simbólicos", () => {
  const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lzx-rp-")))
  const E = {} as NodeJS.ProcessEnv
  test("un enlace hacia .git/config, hacia un enlace roto a opencode.json y por cadena protegen el destino", () => {
    const r = tmp()
    try {
      fs.mkdirSync(path.join(r, ".git"))
      fs.writeFileSync(path.join(r, ".git/config"), "[core]\n")
      fs.symlinkSync(".git/config", path.join(r, "notas.cfg"))
      fs.symlinkSync("opencode.json", path.join(r, "ajustes.json")) // roto: opencode.json no existe
      fs.symlinkSync("notas.cfg", path.join(r, "cadena.txt")) // enlace a enlace
      fs.symlinkSync(".git", path.join(r, "carpeta")) // directorio protegido
      fs.symlinkSync("ajustes.json", path.join(r, "ciclo-a")) // sin ciclo: roto igual
      fs.symlinkSync("bucle-b", path.join(r, "bucle-a"))
      fs.symlinkSync("bucle-a", path.join(r, "bucle-b"))
      const o = { raiz: r }
      for (const p of ["notas.cfg", "ajustes.json", "cadena.txt", "carpeta/hooks/pre-commit", "ciclo-a", "bucle-a", path.join(r, "notas.cfg")])
        expect(esProtegida(p, E, o), p).toBe(true)
      // sin raiz no se pueden resolver: queda la decisión por nombre (y por eso se pasa raiz desde permission/index.ts)
      expect(esProtegida("notas.cfg", E)).toBe(false)
    } finally {
      fs.rmSync(r, { recursive: true, force: true })
    }
  })
  test("enlaces benignos y rutas normales no se marcan; un enlace hacia fuera sin nombre protegido tampoco", () => {
    const r = tmp()
    const fuera = tmp()
    try {
      fs.mkdirSync(path.join(r, "src"))
      fs.writeFileSync(path.join(r, "src/a.ts"), "x")
      fs.writeFileSync(path.join(fuera, "datos.txt"), "x")
      fs.symlinkSync("src/a.ts", path.join(r, "alias.ts"))
      fs.symlinkSync("src", path.join(r, "carpeta-src"))
      fs.symlinkSync(path.join(fuera, "datos.txt"), path.join(r, "afuera"))
      fs.mkdirSync(path.join(r, "..h"))
      fs.symlinkSync("..h/x.txt", path.join(r, "dd"))
      const o = { raiz: r }
      for (const p of ["alias.ts", "carpeta-src/a.ts", "src/nuevo.ts", "nuevo/otro.ts", "afuera", "dd", "..h/x.txt"]) expect(esProtegida(p, E, o), p).toBe(false)
    } finally {
      fs.rmSync(r, { recursive: true, force: true })
      fs.rmSync(fuera, { recursive: true, force: true })
    }
  })
  test("3.ª ronda: `..` en el destino se aplica sobre la carpeta ya resuelta (s -> .git/hooks, a -> s/../config)", () => {
    const r = tmp()
    try {
      fs.mkdirSync(path.join(r, ".git/hooks"), { recursive: true })
      fs.writeFileSync(path.join(r, ".git/config"), "[core]\n")
      fs.symlinkSync(".git/hooks", path.join(r, "s"))
      fs.symlinkSync("s/../config", path.join(r, "a"))
      expect(fs.readFileSync(path.join(r, "a"), "utf-8")).toBe("[core]\n") // el sistema SÍ llega a .git/config
      expect(esProtegida("a", E, { raiz: r })).toBe(true)
    } finally {
      fs.rmSync(r, { recursive: true, force: true })
    }
  })
  test("3.ª ronda: destino absoluto con otras mayúsculas (sistemas que no distinguen) se canoniza", () => {
    const r = tmp()
    try {
      // solo tiene sentido si el volumen no distingue mayúsculas (APFS/NTFS por defecto)
      const mayus = r.toUpperCase()
      if (!fs.existsSync(mayus)) return
      fs.mkdirSync(path.join(r, ".git"))
      fs.writeFileSync(path.join(r, ".git/config"), "x")
      fs.symlinkSync(path.join(mayus, ".git", "config"), path.join(r, "mayus"))
      expect(esProtegida("mayus", E, { raiz: r })).toBe(true)
    } finally {
      fs.rmSync(r, { recursive: true, force: true })
    }
  })
  test("3.ª ronda: proyecto SIN git: el patrón viene relativo a `/` (base) y la raíz es la carpeta", () => {
    const r = tmp()
    try {
      fs.mkdirSync(path.join(r, ".git"))
      fs.symlinkSync(".git", path.join(r, "carpeta"))
      fs.symlinkSync(".git/config", path.join(r, "directo"))
      const rel = (f: string) => path.relative("/", path.join(r, f)) // como lo construyen edit/write/apply_patch con worktree "/"
      expect(esProtegida(rel("directo"), E, { raiz: r, base: "/" })).toBe(true)
      expect(esProtegida(rel("carpeta/hooks/x"), E, { raiz: r, base: "/" })).toBe(true)
      expect(esProtegida(rel("src/a.ts"), E, { raiz: r, base: "/" })).toBe(false)
      // sin la base correcta (el fallo de antes) el patrón apuntaba a una ruta que no existe
      expect(esProtegida(rel("directo"), E, { raiz: r })).toBe(false)
    } finally {
      fs.rmSync(r, { recursive: true, force: true })
    }
  })
  test("3.ª ronda: en POSIX un nombre con `\\` es un nombre más (b\\c -> .git/config)", () => {
    if (path.sep !== "/") return
    const r = tmp()
    try {
      fs.mkdirSync(path.join(r, ".git"))
      fs.writeFileSync(path.join(r, ".git/config"), "x")
      fs.symlinkSync(".git/config", path.join(r, "b\\c"))
      expect(esProtegida("b\\c", E, { raiz: r })).toBe(true)
      expect(esProtegida("b\\otro", E, { raiz: r })).toBe(false)
    } finally {
      fs.rmSync(r, { recursive: true, force: true })
    }
  })
  test("3.ª ronda: una carpeta cuyo nombre empieza por `..` (..h) no es «fuera» del proyecto", () => {
    const r = tmp()
    try {
      fs.mkdirSync(path.join(r, "..h/.git"), { recursive: true })
      fs.writeFileSync(path.join(r, "..h/.git/config"), "x")
      fs.symlinkSync("..h/.git/config", path.join(r, "dotdot"))
      expect(esProtegida("dotdot", E, { raiz: r })).toBe(true)
    } finally {
      fs.rmSync(r, { recursive: true, force: true })
    }
  })
  test("3.ª ronda: un enlace hacia FUERA del proyecto cuyo destino tiene nombre protegido (opencode.json global, .gitconfig, .git ajeno) pregunta", () => {
    const r = tmp()
    const fuera = tmp()
    try {
      fs.mkdirSync(path.join(fuera, ".config/opencode"), { recursive: true })
      fs.mkdirSync(path.join(fuera, "otro/.git"), { recursive: true })
      fs.writeFileSync(path.join(fuera, ".config/opencode/opencode.json"), "{}")
      fs.writeFileSync(path.join(fuera, ".gitconfig"), "")
      fs.symlinkSync(path.join(fuera, ".config/opencode/opencode.json"), path.join(r, "cfg"))
      fs.symlinkSync(path.join(fuera, ".gitconfig"), path.join(r, "gc"))
      fs.symlinkSync(path.join(fuera, "otro/.git/config"), path.join(r, "ajeno")) // roto, destino previsto
      for (const p of ["cfg", "gc", "ajeno"]) expect(esProtegida(p, E, { raiz: r }), p).toBe(true)
    } finally {
      fs.rmSync(r, { recursive: true, force: true })
      fs.rmSync(fuera, { recursive: true, force: true })
    }
  })
})
