// Ola 7, 7.6: ganchos completos. onFailure, filtro `if`, eventos PermissionRequest/SubagentStart/Interrupt/PostToolBatch, derrame a disco de
// salidas grandes y confianza por hash. Todo con comandos reales (node) y el archivo de ganchos de la app (LAZUNOX_HOOKS_FILE).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { reply } from "../lib/llm-server"
import {
  LazunoxGanchosPlugin,
  esperarPendientes,
  fallo,
  hashEsperado,
  leerConfig,
  motivoFallo,
  pideBloquear,
  registroGanchos,
  textoContexto,
} from "../../src/plugin/lazunox-ganchos"
import { aplicaIf, leerRegla, partesDeComando, sinEnvoltorios } from "../../src/plugin/ganchos-if"
import { acotar, derrameActivo } from "../../src/plugin/ganchos-derrame"
import { itConPlugin, registroDeTriggers, sesionConPeticion, useServerConfig } from "./bucle-util"

let dir: string
const entorno = ["LAZUNOX_HOOKS_FILE", "LAZUNOX_HOOKS_SHA256", "LAZUNOX_GANCHOS_DERRAME"] as const
const previo: Record<string, string | undefined> = {}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lzx-gan3-"))
  for (const k of entorno) previo[k] = process.env[k]
  delete process.env.LAZUNOX_HOOKS_SHA256
  delete process.env.LAZUNOX_GANCHOS_DERRAME
  registroGanchos.length = 0
  registroDeTriggers.length = 0
})
afterEach(() => {
  for (const k of entorno) {
    if (previo[k] === undefined) delete process.env[k]
    else process.env[k] = previo[k]
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

const script = (nombre: string, cuerpo: string) => {
  const f = path.join(dir, nombre)
  fs.writeFileSync(f, cuerpo)
  return `"${process.execPath}" "${f}"`
}
const instalar = async (hooks: Record<string, unknown[]>) => {
  const archivo = path.join(dir, "ganchos.json")
  fs.writeFileSync(archivo, JSON.stringify({ hooks }))
  process.env.LAZUNOX_HOOKS_FILE = archivo
  return LazunoxGanchosPlugin({ directory: dir } as never)
}
const contador = (nombre: string, salida = "") =>
  script(nombre, `require("fs").appendFileSync(${JSON.stringify(path.join(dir, nombre + ".log"))}, "x"); ${salida}`)
const veces = (nombre: string) => {
  try {
    return fs.readFileSync(path.join(dir, nombre + ".log"), "utf-8").length
  } catch {
    return 0
  }
}
const sale = (codigo: number, texto = "") => script(`sale${codigo}.js`, `process.stderr.write(${JSON.stringify(texto)}); process.exit(${codigo})`)

// ------------------------------------------------------------------------------------------------------------- onFailure
describe("7.6 onFailure: block (falla cerrado)", () => {
  test("fallo() distingue fallar de bloquear a propósito", () => {
    const base = { stdout: "", stderr: "", timedOut: false }
    expect(fallo({ ...base, code: 0 })).toBe(false)
    expect(fallo({ ...base, code: 2 })).toBe(false) // bloquea a propósito: no es un fallo
    expect(fallo({ ...base, code: 1 })).toBe(true)
    expect(fallo({ ...base, code: 127 })).toBe(true)
    expect(fallo({ ...base, code: null })).toBe(true)
    expect(fallo({ ...base, code: 0, timedOut: true })).toBe(true)
    expect(fallo({ ...base, code: 0, stdout: '{"decision":"blo' })).toBe(true)
    expect(fallo({ ...base, code: 0, stdout: "texto libre" })).toBe(false)
    expect(motivoFallo({ ...base, code: 1 })).toContain("código 1")
  })
  test("leerConfig conserva onFailure=block y descarta cualquier otro valor", () => {
    const c = leerConfig(JSON.stringify({ hooks: { PreToolUse: [{ command: "a", onFailure: "block" }, { command: "b", onFailure: "continue" }, { command: "c", onFailure: 1 }] } }))
    expect(c.PreToolUse.map((g) => g.onFailure)).toEqual(["block", undefined, undefined])
  })
  test("PreToolUse: con onFailure=block un gancho que falla (código 1, no existe, JSON roto, expira) bloquea la herramienta", async () => {
    const roto = script("roto.js", `console.log('{"decision":"blo')`)
    const lento = script("lento.js", `setTimeout(() => {}, 20000)`)
    for (const [cmd, motivo] of [
      [sale(1), "código 1"],
      ["comando-que-no-existe-xyz", "código 127"],
      [roto, "JSON"],
      [lento, "tiempo"],
    ] as const) {
      const h = await instalar({ PreToolUse: [{ command: cmd, onFailure: "block", timeout: 1 }] })
      await expect(h["tool.execute.before"]!({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "ls" } })).rejects.toThrow(motivo)
    }
  })
  test("sin onFailure el mismo fallo NO bloquea (como antes)", async () => {
    for (const cmd of [sale(1), "comando-que-no-existe-xyz"]) {
      const h = await instalar({ PreToolUse: [{ command: cmd }] })
      const args = { command: "ls" }
      await h["tool.execute.before"]!({ tool: "bash", sessionID: "s", callID: "c" }, { args })
      expect(args).toEqual({ command: "ls" })
    }
  })
  test("con onFailure=block un gancho que funciona (código 0) no bloquea, y uno que bloquea a propósito (código 2) sigue bloqueando con SU razón", async () => {
    let h = await instalar({ PreToolUse: [{ command: contador("ok"), onFailure: "block" }] })
    await h["tool.execute.before"]!({ tool: "bash", sessionID: "s", callID: "c" }, { args: {} })
    expect(veces("ok")).toBe(1)
    h = await instalar({ PreToolUse: [{ command: sale(2, "no se toca prod"), onFailure: "block" }] })
    await expect(h["tool.execute.before"]!({ tool: "bash", sessionID: "s", callID: "c" }, { args: {} })).rejects.toThrow("no se toca prod")
  })
  test("UserPromptSubmit: onFailure=block rechaza el mensaje; sin él, el fallo se ignora", async () => {
    const parts = () => [{ type: "text", text: "hola" }] as never
    let h = await instalar({ UserPromptSubmit: [{ command: sale(1), onFailure: "block" }] })
    await expect(h["chat.message"]!({ sessionID: "s", agent: "build" } as never, { message: { id: "m" }, parts: parts() } as never)).rejects.toThrow("falló")
    h = await instalar({ UserPromptSubmit: [{ command: sale(1) }] })
    await h["chat.message"]!({ sessionID: "s", agent: "build" } as never, { message: { id: "m" }, parts: parts() } as never)
  })
})

// ------------------------------------------------------------------------------------------------------------- filtro if
describe("7.6 filtro `if`", () => {
  const cwd = "/proyecto"
  test("leerRegla: nombre con o sin paréntesis; lo ilegible no es una regla", () => {
    expect(leerRegla("Bash(git *)")).toEqual({ herramienta: "Bash", patron: "git *" })
    expect(leerRegla("Read")).toEqual({ herramienta: "Read", patron: undefined })
    expect(leerRegla("Edit(*.ts)")?.patron).toBe("*.ts")
    expect(leerRegla("")).toBeUndefined()
    expect(leerRegla("(x)")).toBeUndefined()
    expect(leerRegla("Bash(" + "x".repeat(400) + ")")).toBeUndefined()
  })
  test("partesDeComando: divide por &&, ||, ;, | y saltos fuera de comillas", () => {
    expect(partesDeComando("git status && ls -la | wc -l")).toEqual(["git status", "ls -la", "wc -l"])
    expect(partesDeComando("a || b; c\nd")).toEqual(["a", "b", "c", "d"])
    expect(partesDeComando(`echo "a && b" && git push`)).toEqual([`echo "a && b"`, "git push"])
    expect(partesDeComando("echo 'x;y'")).toEqual(["echo 'x;y'"])
    expect(partesDeComando("sleep 5 &")).toEqual(["sleep 5"])
  })
  test("partesDeComando: lo que no se puede analizar devuelve undefined", () => {
    for (const c of ["echo $(whoami)", "echo `id`", "cat <<EOF\nx\nEOF", 'echo "sin cerrar', "diff <(ls) <(ls)", "eval git push"])
      expect(partesDeComando(c)).toBeUndefined()
  })
  test("sinEnvoltorios quita asignaciones y envoltorios simples", () => {
    expect(sinEnvoltorios("FOO=1 BAR=2 git push")).toBe("git push")
    expect(sinEnvoltorios("timeout 5 git push")).toBe("git push")
    expect(sinEnvoltorios("nice -n 10 time git push")).toBe("git push")
    expect(sinEnvoltorios("nohup git push")).toBe("git push")
    expect(sinEnvoltorios("git push")).toBe("git push")
  })
  test("aplicaIf: Bash(git *) coincide con cualquier parte del compuesto y con envoltorios", () => {
    const r = "Bash(git *)"
    expect(aplicaIf(r, "bash", { command: "git status" }, cwd)).toBe(true)
    expect(aplicaIf(r, "bash", { command: "ls && git push origin main" }, cwd)).toBe(true)
    expect(aplicaIf(r, "bash", { command: "FOO=1 timeout 5 git push" }, cwd)).toBe(true)
    expect(aplicaIf(r, "bash", { command: "ls -la && cat x" }, cwd)).toBe(false)
    expect(aplicaIf(r, "bash", { command: "echo git" }, cwd)).toBe(false)
    expect(aplicaIf(r, "edit", { filePath: "/x" }, cwd)).toBe(false)
  })
  test("aplicaIf: si no se puede analizar el comando, el gancho corre igual", () => {
    expect(aplicaIf("Bash(git *)", "bash", { command: "echo $(whoami)" }, cwd)).toBe(true)
    expect(aplicaIf("Bash(git *)", "bash", { command: 'echo "sin cerrar' }, cwd)).toBe(true)
    expect(aplicaIf("Bash(git *)", "bash", {}, cwd)).toBe(true)
    expect(aplicaIf("Bash(git *)", "bash", undefined, cwd)).toBe(true)
    expect(aplicaIf("regla rara ((", "bash", { command: "ls" }, cwd)).toBe(true)
  })
  test("aplicaIf: Edit(*.ts) cubre edit/write/apply_patch por ruta absoluta o relativa; sin patrón vale cualquier llamada de la herramienta", () => {
    expect(aplicaIf("Edit(*.ts)", "edit", { filePath: "/proyecto/src/a.ts" }, cwd)).toBe(true)
    expect(aplicaIf("Edit(*.ts)", "write", { filePath: "/proyecto/src/a.md" }, cwd)).toBe(false)
    expect(aplicaIf("Edit(src/*)", "edit", { filePath: "/proyecto/src/a.ts" }, cwd)).toBe(true)
    expect(aplicaIf("Edit(*.ts)", "apply_patch", { patchText: "*** Begin Patch\n*** Update File: x/y.ts\n@@\n-a\n+b\n*** End Patch" }, cwd)).toBe(true)
    expect(aplicaIf("Edit(*.ts)", "apply_patch", { patchText: "*** Begin Patch\n*** Update File: x/y.md\n@@\n-a\n+b\n*** End Patch" }, cwd)).toBe(false)
    expect(aplicaIf("Read", "read", { filePath: "/x" }, cwd)).toBe(true)
    expect(aplicaIf("mcp__srv__tool", "srv_tool", {}, cwd)).toBe(true)
  })
  test("PreToolUse con `if`: solo corre cuando la regla coincide", async () => {
    const h = await instalar({ PreToolUse: [{ command: contador("solo-git"), if: "Bash(git *)" }, { command: contador("sin-filtro") }] })
    await h["tool.execute.before"]!({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "ls" } })
    expect([veces("solo-git"), veces("sin-filtro")]).toEqual([0, 1])
    await h["tool.execute.before"]!({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "ls && git push" } })
    expect([veces("solo-git"), veces("sin-filtro")]).toEqual([1, 2])
    await h["tool.execute.before"]!({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "echo $(whoami)" } })
    expect(veces("solo-git")).toBe(2)
  })
  test("PostToolUse y PostToolUseFailure también respetan `if`", async () => {
    const h = await instalar({
      PostToolUse: [{ command: contador("post"), if: "Edit(*.ts)" }],
      PostToolUseFailure: [{ command: contador("falla"), if: "Edit(*.ts)" }],
    })
    await h["tool.execute.after"]!({ tool: "edit", sessionID: "s", callID: "c", args: { filePath: "/p/a.md" } }, { title: "", output: "x", metadata: {} })
    await h["tool.execute.failure"]!({ tool: "edit", sessionID: "s", callID: "c", args: { filePath: "/p/a.md" }, error: "e" }, {})
    expect([veces("post"), veces("falla")]).toEqual([0, 0])
    await h["tool.execute.after"]!({ tool: "edit", sessionID: "s", callID: "c", args: { filePath: "/p/a.ts" } }, { title: "", output: "x", metadata: {} })
    await h["tool.execute.failure"]!({ tool: "edit", sessionID: "s", callID: "c", args: { filePath: "/p/a.ts" }, error: "e" }, {})
    expect([veces("post"), veces("falla")]).toEqual([1, 1])
  })
})

// ------------------------------------------------------------------------------------------------------------- eventos nuevos
describe("7.6 eventos nuevos", () => {
  const peticion = (extra: Record<string, unknown> = {}) =>
    ({ id: "per_1", type: "bash", pattern: ["git push *"], sessionID: "s", messageID: "m", callID: "c", title: "bash", metadata: { command: "git push origin main" }, time: { created: 1 }, ...extra }) as never

  test("PermissionRequest: código 2 o {decision:block} NIEGA la petición", async () => {
    for (const cmd of [sale(2, "no"), script("b.js", `console.log(JSON.stringify({decision:"block",reason:"no"}))`)]) {
      const h = await instalar({ PermissionRequest: [{ command: cmd }] })
      const o = { status: "ask" as "ask" | "deny" | "allow" }
      await h["permission.ask"]!(peticion(), o)
      expect(o.status).toBe("deny")
    }
  })
  test("PermissionRequest: NUNCA aprueba (un «allow» en su salida se ignora) y no hace nada si no bloquea", async () => {
    const permite = script("permite.js", `console.log(JSON.stringify({decision:"allow", hookSpecificOutput:{decision:{behavior:"allow"}}, permissionDecision:"allow"}))`)
    const h = await instalar({ PermissionRequest: [{ command: permite }] })
    const o = { status: "ask" as "ask" | "deny" | "allow" }
    await h["permission.ask"]!(peticion(), o)
    expect(o.status).toBe("ask")
  })
  test("PermissionRequest: matcher por permiso, `if` por comando y onFailure=block", async () => {
    const o = () => ({ status: "ask" as "ask" | "deny" | "allow" })
    let h = await instalar({ PermissionRequest: [{ command: sale(2), matcher: "edit" }] })
    let r = o()
    await h["permission.ask"]!(peticion(), r)
    expect(r.status).toBe("ask") // el matcher es edit, el permiso es bash
    h = await instalar({ PermissionRequest: [{ command: sale(2), if: "Bash(git push *)" }] })
    r = o()
    await h["permission.ask"]!(peticion(), r)
    expect(r.status).toBe("deny")
    r = o()
    await h["permission.ask"]!(peticion({ metadata: { command: "ls" } }), r)
    expect(r.status).toBe("ask")
    h = await instalar({ PermissionRequest: [{ command: sale(1), onFailure: "block" }] })
    r = o()
    await h["permission.ask"]!(peticion(), r)
    expect(r.status).toBe("deny")
    h = await instalar({ PermissionRequest: [{ command: sale(1) }] })
    r = o()
    await h["permission.ask"]!(peticion(), r)
    expect(r.status).toBe("ask")
  })
  test("PermissionRequest: el gancho recibe el permiso, los patrones y el comando por stdin", async () => {
    const guarda = script("g.js", `let t="";process.stdin.on("data",d=>t+=d).on("end",()=>require("fs").writeFileSync(${JSON.stringify(path.join(dir, "in.json"))}, t))`)
    const h = await instalar({ PermissionRequest: [{ command: guarda }] })
    await h["permission.ask"]!(peticion(), { status: "ask" })
    const j = JSON.parse(fs.readFileSync(path.join(dir, "in.json"), "utf-8"))
    expect(j).toMatchObject({ event: "PermissionRequest", permission: "bash", patterns: ["git push *"], command: "git push origin main", sessionID: "s" })
  })
  test("SubagentStart: solo cuando nace una sesión HIJA; no espera ni bloquea", async () => {
    const h = await instalar({ SubagentStart: [{ command: contador("sub") }] })
    await h.event!({ event: { type: "session.created", properties: { info: { id: "ses_a" } } } } as never)
    await esperarPendientes()
    expect(veces("sub")).toBe(0)
    await h.event!({ event: { type: "session.created", properties: { info: { id: "ses_b", parentID: "ses_a", title: "Explorar" } } } } as never)
    await esperarPendientes()
    expect(veces("sub")).toBe(1)
  })
  test("Interrupt y PostToolBatch se disparan con su entrada", async () => {
    const guarda = (n: string) => script(`${n}.js`, `let t="";process.stdin.on("data",d=>t+=d).on("end",()=>require("fs").writeFileSync(${JSON.stringify(path.join(dir, n + ".json"))}, t))`)
    const h = await instalar({ Interrupt: [{ command: guarda("int") }], PostToolBatch: [{ command: guarda("lote") }] })
    await h["session.interrupt"]!({ sessionID: "s1" }, {})
    await h["session.tool-batch"]!({ sessionID: "s1", messageID: "m1", tools: [{ tool: "bash", callID: "c1", status: "completed" }] }, {})
    await esperarPendientes()
    expect(JSON.parse(fs.readFileSync(path.join(dir, "int.json"), "utf-8"))).toMatchObject({ event: "Interrupt", sessionID: "s1", subagente: false })
    expect(JSON.parse(fs.readFileSync(path.join(dir, "lote.json"), "utf-8"))).toMatchObject({ event: "PostToolBatch", messageID: "m1", tools: [{ tool: "bash", status: "completed" }] })
  })
  test("sin archivo de ganchos o sin esos eventos no pasa nada", async () => {
    const h = await instalar({ PreToolUse: [] })
    await h["session.interrupt"]!({ sessionID: "s" }, {})
    await h["session.tool-batch"]!({ sessionID: "s", messageID: "m", tools: [] }, {})
    const o = { status: "ask" as "ask" | "deny" | "allow" }
    await h["permission.ask"]!(peticion(), o)
    expect(o.status).toBe("ask")
  })
})

// ------------------------------------------------------------------------------------------------------------- derrame
describe("7.6 derrame a disco de salidas grandes", () => {
  test("acotar: un texto corto pasa igual; uno largo deja el principio, el final y la ruta, dentro del mismo tope, y el archivo tiene todo", () => {
    expect(acotar("hola", 100, "x")).toBe("hola")
    const largo = "A".repeat(3000) + "MEDIO" + "Z".repeat(9000)
    const r = acotar(largo, 4000, "un gancho de prueba")
    expect(r.length).toBeLessThanOrEqual(4000)
    expect(r.startsWith("AAAA")).toBe(true)
    expect(r.endsWith("ZZZZ")).toBe(true)
    const ruta = /completo en (\S+)/.exec(r)?.[1]
    expect(ruta).toBeTruthy()
    expect(fs.readFileSync(ruta!, "utf-8")).toBe(largo)
    fs.rmSync(ruta!, { force: true })
  })
  test("LAZUNOX_GANCHOS_DERRAME=0: corte silencioso como antes", () => {
    process.env.LAZUNOX_GANCHOS_DERRAME = "0"
    expect(derrameActivo()).toBe(false)
    expect(acotar("x".repeat(9000), 4000, "x")).toBe("x".repeat(4000))
  })
  test("el archivo derramado tiene tope de 1 MB", () => {
    const r = acotar("y".repeat(1024 * 1024 + 500), 4000, "x")
    const ruta = /completo en (\S+)/.exec(r)?.[1]!
    expect(fs.statSync(ruta).size).toBe(1024 * 1024)
    expect(r).toContain("más de")
    fs.rmSync(ruta, { force: true })
  })
  test("textoContexto de una salida de 50 KB: principio y final + ruta, y el archivo completo", () => {
    const stdout = "INICIO" + "m".repeat(50_000) + "FINAL"
    const t = textoContexto({ code: 0, stdout, stderr: "", timedOut: false })
    expect(t.length).toBeLessThanOrEqual(4000)
    expect(t.startsWith("INICIO")).toBe(true)
    expect(t.endsWith("FINAL")).toBe(true)
    const ruta = /completo en (\S+)/.exec(t)?.[1]!
    expect(fs.readFileSync(ruta, "utf-8")).toBe(stdout)
    fs.rmSync(ruta, { force: true })
  })
  test("UserPromptSubmit con un gancho que escribe 30 KB: la parte sintética lleva la ruta; el motivo de un bloqueo largo también se derrama", async () => {
    const grande = script("grande.js", `process.stdout.write("Z".repeat(30000))`)
    const h = await instalar({ UserPromptSubmit: [{ command: grande }] })
    const o = { message: { id: "m" }, parts: [{ type: "text", text: "hola" }] } as { message: { id: string }; parts: { type?: string; text?: string }[] }
    await h["chat.message"]!({ sessionID: "s", agent: "build" } as never, o as never)
    const texto = o.parts[1]!.text!
    expect(texto).toContain("completo en")
    expect(texto.length).toBeLessThan(4200)
    const ruta = /completo en (\S+)/.exec(texto)?.[1]!
    expect(fs.readFileSync(ruta, "utf-8")).toHaveLength(30000)
    fs.rmSync(ruta, { force: true })
    const razonGrande = script("razon.js", `process.stderr.write("R".repeat(9000)); process.exit(2)`)
    const razon = pideBloquear({ code: 2, stdout: "", stderr: "R".repeat(9000), timedOut: false })!
    expect(razon.length).toBeLessThanOrEqual(2000)
    expect(razon).toContain("completo en")
    void razonGrande
  })
})

// ------------------------------------------------------------------------------------------------------------- confianza por hash
describe("7.6 confianza por hash del archivo", () => {
  const sha = (t: string) => createHash("sha256").update(t).digest("hex")
  test("hashEsperado: ausente = sin comprobación; mal formado = null", () => {
    expect(hashEsperado({})).toBeUndefined()
    expect(hashEsperado({ LAZUNOX_HOOKS_SHA256: "" })).toBeUndefined()
    expect(hashEsperado({ LAZUNOX_HOOKS_SHA256: "xyz" })).toBeNull()
    expect(hashEsperado({ LAZUNOX_HOOKS_SHA256: sha("a").toUpperCase() })).toBe(sha("a"))
  })
  test("con el hash correcto los ganchos corren; con otro (el archivo cambió) o mal formado no corre ninguno", async () => {
    const archivo = path.join(dir, "ganchos.json")
    const texto = JSON.stringify({ hooks: { PreToolUse: [{ command: contador("hash") }] } })
    fs.writeFileSync(archivo, texto)
    process.env.LAZUNOX_HOOKS_FILE = archivo
    const h = await LazunoxGanchosPlugin({ directory: dir } as never)
    const correr = () => h["tool.execute.before"]!({ tool: "bash", sessionID: "s", callID: "c" }, { args: {} })

    process.env.LAZUNOX_HOOKS_SHA256 = sha(texto)
    await correr()
    expect(veces("hash")).toBe(1)

    process.env.LAZUNOX_HOOKS_SHA256 = sha("otro contenido")
    await correr()
    expect(veces("hash")).toBe(1)
    expect(registroGanchos.some((l) => l.includes("no coincide con el hash"))).toBe(true)

    process.env.LAZUNOX_HOOKS_SHA256 = "no-es-un-hash"
    await correr()
    expect(veces("hash")).toBe(1)

    // El archivo cambia por debajo (mismo hash aprobado): deja de ejecutarse.
    process.env.LAZUNOX_HOOKS_SHA256 = sha(texto)
    fs.writeFileSync(archivo, texto.replace("hash", "hash") + " ")
    await new Promise((r) => setTimeout(r, 20))
    await correr()
    expect(veces("hash")).toBe(1)

    delete process.env.LAZUNOX_HOOKS_SHA256
    await correr()
    expect(veces("hash")).toBe(2)
  })
})

// ------------------------------------------------------------------------------------------------------------- bucle real
describe("7.6 el motor dispara PostToolBatch e Interrupt", () => {
  itConPlugin.instance("un paso con dos herramientas dispara UN session.tool-batch con las dos llamadas", () =>
    Effect.gen(function* () {
      const { dir: carpeta, llm } = yield* useServerConfig()
      fs.writeFileSync(path.join(carpeta, "a.txt"), "a")
      fs.writeFileSync(path.join(carpeta, "b.txt"), "b")
      const { prompt, session } = yield* sesionConPeticion("lee los dos")
      yield* llm.push(
        reply()
          .toolAt(0, "read", { filePath: path.join(carpeta, "a.txt") })
          .toolAt(1, "read", { filePath: path.join(carpeta, "b.txt") }),
      )
      yield* llm.text("listo")
      yield* prompt.loop({ sessionID: session.id })
      const lotes = registroDeTriggers.filter((t) => t.name === "session.tool-batch")
      expect(lotes).toHaveLength(1)
      const entrada = lotes[0]!.input as { sessionID: string; tools: { tool: string; status: string }[] }
      expect(entrada.sessionID).toBe(String(session.id))
      expect(entrada.tools.map((t) => t.tool)).toEqual(["read", "read"])
      expect(entrada.tools.every((t) => t.status === "completed")).toBe(true)
    }),
  )

  itConPlugin.instance("cancelar la sesión dispara session.interrupt", () =>
    Effect.gen(function* () {
      yield* useServerConfig()
      const { prompt, session } = yield* sesionConPeticion("hola")
      yield* prompt.cancel(session.id)
      const hits = registroDeTriggers.filter((t) => t.name === "session.interrupt")
      expect(hits).toHaveLength(1)
      expect((hits[0]!.input as { sessionID: string }).sessionID).toBe(String(session.id))
    }),
  )
})
