import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { aplica, ejecutar, leerConfig, LazunoxGanchosPlugin } from "../../src/plugin/lazunox-ganchos"

describe("ganchos de usuario", () => {
  test("leerConfig descarta lo inválido y acota tiempos y cantidad", () => {
    const vacio = { PreToolUse: [], PostToolUse: [], PreCompact: [], PostCompact: [], Stop: [], SessionStart: [], UserPromptSubmit: [], SubagentStop: [], PostToolUseFailure: [], PermissionDenied: [] }
    expect(leerConfig("no json")).toEqual(vacio)
    expect(leerConfig('{"hooks":7}')).toEqual(vacio)
    expect(leerConfig('{"hooks":{"PreCompact":[{"command":"x"}],"Stop":[{"command":"y"}]}}')).toMatchObject({ PreCompact: [{ command: "x" }], Stop: [{ command: "y" }] })
    const c = leerConfig(
      JSON.stringify({
        hooks: {
          PreToolUse: [{ command: "a", timeout: 9999 }, { command: "" }, { nada: 1 }, { command: "b", timeout: -4, matcher: "bash" }, 5, null],
          PostToolUse: Array.from({ length: 50 }, () => ({ command: "x" })),
        },
      }),
    )
    expect(c.PreToolUse.map((g) => g.command)).toEqual(["a", "b"])
    expect(c.PreToolUse[0]!.timeout).toBe(60)
    expect(c.PreToolUse[1]!.timeout).toBe(1)
    expect(c.PostToolUse.length).toBe(20)
  })
  test("aplica: sin matcher o «*» todo; si no, regex anclada", () => {
    expect(aplica({ command: "x" }, "bash")).toBe(true)
    expect(aplica({ command: "x", matcher: "*" }, "edit")).toBe(true)
    expect(aplica({ command: "x", matcher: "bash|edit" }, "edit")).toBe(true)
    expect(aplica({ command: "x", matcher: "bash" }, "bashful")).toBe(false)
    expect(aplica({ command: "x", matcher: "(" }, "bash")).toBe(false)
  })
  test("ejecutar: recibe el JSON por stdin, devuelve el código y el stderr", async () => {
    const cmd = `"${process.execPath}" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.error('visto '+j.tool);process.exit(j.tool==='write'?2:0)})"`
    const bloquea = await ejecutar({ command: cmd }, { tool: "write" }, process.cwd())
    expect(bloquea.code).toBe(2)
    expect(bloquea.stderr).toContain("visto write")
    const deja = await ejecutar({ command: cmd }, { tool: "read" }, process.cwd())
    expect(deja.code).toBe(0)
  })
  test("ejecutar: pasarse del tiempo lo mata y no cuelga", async () => {
    const t0 = Date.now()
    const r = await ejecutar({ command: `"${process.execPath}" -e "setTimeout(()=>{},30000)"`, timeout: 1 }, {}, process.cwd())
    expect(r.timedOut).toBe(true)
    expect(Date.now() - t0).toBeLessThan(8000)
  })
  test("leerConfig reconoce PostCompact y lo acota como los demás", () => {
    const c = leerConfig(JSON.stringify({ hooks: { PostCompact: [{ command: "a", timeout: 999 }, { command: "" }] } }))
    expect(c.PostCompact).toEqual([{ command: "a", matcher: undefined, timeout: 60 }])
  })
  test("PostCompact: el stdout (código 0) llega a output.context marcado, el stdin lleva las cifras; código ≠ 0 o sin archivo no aporta", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lzx-post-"))
    const previo = process.env.LAZUNOX_HOOKS_FILE
    try {
      const imprime = `"${process.execPath}" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log('MARCA '+j.event+' '+j.trigger+' '+j.parcial+' '+j.tokensAntes+'>'+j.tokensDespues)})"`
      const falla = `"${process.execPath}" -e "console.log('NO-DEBE-SALIR');process.exit(1)"`
      const largo = `"${process.execPath}" -e "console.log('z'.repeat(9000))"`
      const archivo = path.join(dir, "ganchos.json")
      fs.writeFileSync(archivo, JSON.stringify({ hooks: { PostCompact: [{ command: imprime }, { command: falla }, { command: largo }] } }))
      process.env.LAZUNOX_HOOKS_FILE = archivo
      const hooks = await LazunoxGanchosPlugin({ directory: dir } as never)
      const out = { context: [] as string[] }
      await hooks["experimental.session.compacted"]!(
        { sessionID: "ses_x", trigger: "manual", parcial: true, tokensAntes: 900, tokensDespues: 120 },
        out,
      )
      expect(out.context.length).toBe(2)
      expect(out.context[0]).toBe("[Gancho PostCompact]\nMARCA PostCompact manual true 900>120")
      expect(out.context[1]!.length).toBeLessThanOrEqual("[Gancho PostCompact]\n".length + 4000)
      expect(out.context.join("")).not.toContain("NO-DEBE-SALIR")

      // Sin LAZUNOX_HOOKS_FILE el plugin ni se registra (un proyecto no puede traer sus propios ganchos).
      delete process.env.LAZUNOX_HOOKS_FILE
      expect(await LazunoxGanchosPlugin({ directory: dir } as never)).toEqual({})
    } finally {
      if (previo === undefined) delete process.env.LAZUNOX_HOOKS_FILE
      else process.env.LAZUNOX_HOOKS_FILE = previo
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
  test("leerConfig reconoce SessionStart, UserPromptSubmit y SubagentStop y los acota igual", () => {
    const c = leerConfig(
      JSON.stringify({ hooks: { SessionStart: [{ command: "a", timeout: 999 }], UserPromptSubmit: [{ command: "" }, { command: "b" }], SubagentStop: Array.from({ length: 30 }, () => ({ command: "x" })) } }),
    )
    expect(c.SessionStart).toEqual([{ command: "a", matcher: undefined, timeout: 60 }])
    expect(c.UserPromptSubmit.map((g) => g.command)).toEqual(["b"])
    expect(c.SubagentStop.length).toBe(20)
  })
  test("PreToolUse: código 2 sigue bloqueando y un gancho que no devuelve nada no cambia los argumentos", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lzx-pre-"))
    const previo = process.env.LAZUNOX_HOOKS_FILE
    try {
      const archivo = path.join(dir, "ganchos.json")
      fs.writeFileSync(
        archivo,
        JSON.stringify({ hooks: { PreToolUse: [{ matcher: "bash", command: `"${process.execPath}" -e "console.error('no');process.exit(2)"` }, { matcher: "read", command: `"${process.execPath}" -e "console.log('hola')"` }] } }),
      )
      process.env.LAZUNOX_HOOKS_FILE = archivo
      const hooks = await LazunoxGanchosPlugin({ directory: dir } as never)
      await expect(hooks["tool.execute.before"]!({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "ls" } })).rejects.toThrow("no")
      const args = { filePath: "/x" }
      await hooks["tool.execute.before"]!({ tool: "read", sessionID: "s", callID: "c" }, { args })
      expect(args).toEqual({ filePath: "/x" })
    } finally {
      if (previo === undefined) delete process.env.LAZUNOX_HOOKS_FILE
      else process.env.LAZUNOX_HOOKS_FILE = previo
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
