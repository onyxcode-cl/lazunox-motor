import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Schema } from "effect"
import {
  Continuaciones,
  LazunoxGanchosPlugin,
  TOPE_CONTINUACIONES,
  leerConfig,
  leerSalida,
  pideBloquear,
  registroGanchos,
  textoContexto,
  validarEntrada,
} from "../../src/plugin/lazunox-ganchos"

// 3D (P20): ganchos ampliados. Todo con comandos reales (node/bun) y el archivo de ganchos de la app (LAZUNOX_HOOKS_FILE).
let dir: string
let previo: string | undefined
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lzx-gan2-"))
  previo = process.env.LAZUNOX_HOOKS_FILE
  registroGanchos.length = 0
})
afterEach(() => {
  if (previo === undefined) delete process.env.LAZUNOX_HOOKS_FILE
  else process.env.LAZUNOX_HOOKS_FILE = previo
  fs.rmSync(dir, { recursive: true, force: true })
})

/** Crea un script JS en `dir` y devuelve el comando que lo ejecuta. */
const script = (nombre: string, cuerpo: string) => {
  const f = path.join(dir, nombre)
  fs.writeFileSync(f, cuerpo)
  return `"${process.execPath}" "${f}"`
}
const instalar = async (hooks: Record<string, unknown[]>, client?: unknown) => {
  const archivo = path.join(dir, "ganchos.json")
  fs.writeFileSync(archivo, JSON.stringify({ hooks }))
  process.env.LAZUNOX_HOOKS_FILE = archivo
  return LazunoxGanchosPlugin({ directory: dir, client } as never)
}
const contador = (nombre: string) => script(nombre, `require("fs").appendFileSync(${JSON.stringify(path.join(dir, nombre + ".log"))}, "x")`)
const veces = (nombre: string) => {
  try {
    return fs.readFileSync(path.join(dir, nombre + ".log"), "utf-8").length
  } catch {
    return 0
  }
}
const siempreBloquea = (razon = "sigue") => script("bloquea.js", `console.log(JSON.stringify({decision:"block",reason:${JSON.stringify(razon)}}))`)

describe("salida de los ganchos", () => {
  test("leerSalida: JSON roto, texto, arreglo o vacío = sin decisión y nunca lanza", () => {
    expect(leerSalida('{"decision":"block"')).toEqual({})
    expect(leerSalida("hola")).toEqual({})
    expect(leerSalida("[1,2]")).toEqual({})
    expect(leerSalida("")).toEqual({})
    expect(leerSalida('{"decision":"block","reason":"x"}')).toEqual({ decision: "block", reason: "x" })
    expect(leerSalida('{"hookSpecificOutput":{"updatedInput":{"a":1}}}').updatedInput).toEqual({ a: 1 })
    expect(leerSalida('{"decision":"allow"}').decision).toBeUndefined()
  })
  test("pideBloquear: código 2 con stderr o JSON block con código 0; JSON inválido, otro código o tiempo vencido no", () => {
    const base = { stdout: "", stderr: "", timedOut: false }
    expect(pideBloquear({ ...base, code: 2, stderr: "haz X" })).toBe("haz X")
    expect(pideBloquear({ ...base, code: 0, stdout: '{"decision":"block","reason":"R"}' })).toBe("R")
    expect(pideBloquear({ ...base, code: 0, stdout: '{"decision":"block"' })).toBeUndefined()
    expect(pideBloquear({ ...base, code: 1, stdout: '{"decision":"block","reason":"R"}' })).toBeUndefined()
    expect(pideBloquear({ ...base, code: 0, stdout: '{"decision":"block","reason":"R"}', timedOut: true })).toBeUndefined()
    expect(pideBloquear({ ...base, code: null })).toBeUndefined()
  })
  test("textoContexto: texto plano acotado a 4000; additionalContext de JSON; un block no es contexto; código ≠ 0 nada", () => {
    const base = { stderr: "", timedOut: false }
    expect(textoContexto({ ...base, code: 0, stdout: "z".repeat(8000) }).length).toBe(4000)
    expect(textoContexto({ ...base, code: 0, stdout: '{"additionalContext":"hola"}' })).toBe("hola")
    expect(textoContexto({ ...base, code: 0, stdout: '{"decision":"block","reason":"r"}' })).toBe("")
    expect(textoContexto({ ...base, code: 1, stdout: "no" })).toBe("")
  })
})

describe("Continuaciones: el tope", () => {
  test("5 seguidas y la 6.ª se niega y reinicia; liberar reinicia; son por sesión y por gancho", () => {
    const c = new Continuaciones()
    for (let i = 0; i < TOPE_CONTINUACIONES; i++) expect(c.intentar("s", "g")).toBe(true)
    expect(c.intentar("s", "g")).toBe(false)
    expect(c.intentar("s", "g")).toBe(true) // reiniciado tras negarse
    c.liberar("s", "g")
    for (let i = 0; i < TOPE_CONTINUACIONES; i++) expect(c.intentar("s", "g")).toBe(true)
    expect(c.intentar("s", "otro")).toBe(true)
    expect(c.intentar("t", "g")).toBe(true)
    c.liberarSesion("s")
    expect(c.intentar("s", "g")).toBe(true)
  })
})

describe("Stop / SubagentStop con experimental.session.stop", () => {
  test("un Stop hostil que siempre bloquea deja seguir 5 veces y a la 6.ª la sesión PARA; luego se reinicia", async () => {
    const hooks = await instalar({ Stop: [{ command: siempreBloquea("termina las pruebas") }] })
    const stop = hooks["experimental.session.stop"]!
    for (let i = 0; i < TOPE_CONTINUACIONES; i++) {
      const o: { continuar?: string } = {}
      await stop({ sessionID: "ses_a" }, o)
      expect(o.continuar).toBe("termina las pruebas")
    }
    const o6: { continuar?: string } = {}
    await stop({ sessionID: "ses_a" }, o6)
    expect(o6.continuar).toBeUndefined()
    expect(registroGanchos.some((l) => l.includes("agotó 5 continuaciones"))).toBe(true)
    // otra sesión no se ve afectada
    const ob: { continuar?: string } = {}
    await stop({ sessionID: "ses_b" }, ob)
    expect(ob.continuar).toBe("termina las pruebas")
  })
  test("un mensaje de la persona reinicia la cuenta; uno sintético no", async () => {
    const hooks = await instalar({ Stop: [{ command: siempreBloquea() }] })
    const stop = hooks["experimental.session.stop"]!
    for (let i = 0; i < TOPE_CONTINUACIONES; i++) await stop({ sessionID: "ses_a" }, {})
    const msg = (synthetic: boolean) => ({ message: { id: "msg_1" }, parts: [{ type: "text", text: "sigue", synthetic }] }) as never
    await hooks["chat.message"]!({ sessionID: "ses_a" }, msg(true)) // continuación del bucle: NO reinicia
    const o1: { continuar?: string } = {}
    await stop({ sessionID: "ses_a" }, o1)
    expect(o1.continuar).toBeUndefined()
    for (let i = 0; i < TOPE_CONTINUACIONES - 1; i++) await stop({ sessionID: "ses_a" }, {}) // ya reiniciado por la negativa: quedan 4 usadas
    await hooks["chat.message"]!({ sessionID: "ses_a" }, msg(false)) // la persona habla: reinicia
    for (let i = 0; i < TOPE_CONTINUACIONES; i++) {
      const o: { continuar?: string } = {}
      await stop({ sessionID: "ses_a" }, o)
      expect(o.continuar).toBe("sigue")
    }
  })
  test("un gancho que deja parar (código 0 sin JSON) reinicia su cuenta; código 2 con stderr bloquea", async () => {
    const f = path.join(dir, "modo")
    fs.writeFileSync(f, "bloquea")
    const cmd = script("modo.js", `const m=require("fs").readFileSync(${JSON.stringify(f)},"utf-8");if(m==="bloquea"){console.error("haz más");process.exit(2)}`)
    const hooks = await instalar({ Stop: [{ command: cmd }] })
    const stop = hooks["experimental.session.stop"]!
    for (let i = 0; i < 3; i++) {
      const o: { continuar?: string } = {}
      await stop({ sessionID: "s" }, o)
      expect(o.continuar).toBe("haz más")
    }
    fs.writeFileSync(f, "deja")
    const o: { continuar?: string } = {}
    await stop({ sessionID: "s" }, o)
    expect(o.continuar).toBeUndefined()
    fs.writeFileSync(f, "bloquea")
    for (let i = 0; i < TOPE_CONTINUACIONES; i++) {
      const p: { continuar?: string } = {}
      await stop({ sessionID: "s" }, p)
      expect(p.continuar).toBe("haz más") // cuenta reiniciada: otras 5
    }
  })
  test("tiempo vencido, JSON inválido y salida enorme NO bloquean y no cuelgan", async () => {
    const cuelga = script("cuelga.js", "setTimeout(()=>{},30000)")
    const roto = script("roto.js", 'console.log(\'{"decision":"block","reason":"x"\')')
    const enorme = script("enorme.js", 'process.stdout.write("{\\"decision\\":\\"block\\",\\"reason\\":\\"" + "a".repeat(5_000_000) + "\\"}")')
    const hooks = await instalar({ Stop: [{ command: cuelga, timeout: 1 }, { command: roto }, { command: enorme }] })
    const t0 = Date.now()
    const o: { continuar?: string } = {}
    await hooks["experimental.session.stop"]!({ sessionID: "s" }, o)
    expect(o.continuar).toBeUndefined() // la salida enorme se corta a 8 KB: JSON incompleto = sin decisión
    expect(Date.now() - t0).toBeLessThan(15000)
    expect(registroGanchos.some((l) => l.includes("pasó de su tiempo"))).toBe(true)
  })
  test("la razón se acota a 2000 caracteres y varias razones se juntan", async () => {
    const a = script("a.js", 'console.log(JSON.stringify({decision:"block",reason:"A".repeat(7000)}))')
    const b = script("b.js", 'console.log(JSON.stringify({decision:"block",reason:"B"}))')
    const hooks = await instalar({ Stop: [{ command: a }, { command: b }] })
    const o: { continuar?: string } = {}
    await hooks["experimental.session.stop"]!({ sessionID: "s" }, o)
    expect(o.continuar!.length).toBeLessThanOrEqual(2000)
    expect(o.continuar!.startsWith("AAAA")).toBe(true)
    const solo = await instalar({ Stop: [{ command: b }, { command: b }] })
    const p: { continuar?: string } = {}
    await solo["experimental.session.stop"]!({ sessionID: "s2" }, p)
    expect(p.continuar).toBe("B\nB")
  })
  test("subagente:true corre SubagentStop (no Stop) y también puede hacerlo seguir", async () => {
    const hooks = await instalar({ Stop: [{ command: contador("stop") }], SubagentStop: [{ command: siempreBloquea("revisa") }] })
    const o: { continuar?: string } = {}
    await hooks["experimental.session.stop"]!({ sessionID: "hija", subagente: true }, o)
    expect(o.continuar).toBe("revisa")
    expect(veces("stop")).toBe(0)
    const p: { continuar?: string } = {}
    await hooks["experimental.session.stop"]!({ sessionID: "padre" }, p)
    expect(p.continuar).toBeUndefined()
    expect(veces("stop")).toBe(1)
  })
  test("el gancho recibe event, sessionID y cwd por stdin", async () => {
    const f = path.join(dir, "stdin.json")
    const cmd = script("stdin.js", `let d="";process.stdin.on("data",c=>d+=c).on("end",()=>require("fs").writeFileSync(${JSON.stringify(f)},d))`)
    const hooks = await instalar({ Stop: [{ command: cmd }] })
    await hooks["experimental.session.stop"]!({ sessionID: "ses_z", agent: "build" }, {})
    expect(JSON.parse(fs.readFileSync(f, "utf-8"))).toMatchObject({ event: "Stop", sessionID: "ses_z", cwd: dir, agent: "build" })
  })
  test("evento idle: informativo, una sola vez, y SubagentStop para sesiones hijas; con experimental.session.stop en uso ya no corre", async () => {
    const hooks = await instalar({ Stop: [{ command: contador("idle-stop") }], SubagentStop: [{ command: contador("idle-sub") }] })
    const ev = hooks.event!
    await ev({ event: { type: "session.created", properties: { info: { id: "hija", parentID: "padre" } } } } as never)
    await ev({ event: { type: "session.created", properties: { info: { id: "padre" } } } } as never)
    await ev({ event: { type: "session.status", properties: { sessionID: "hija", status: { type: "idle" } } } } as never)
    await ev({ event: { type: "session.status", properties: { sessionID: "padre", status: { type: "idle" } } } } as never)
    await ev({ event: { type: "session.status", properties: { sessionID: "padre", status: { type: "busy" } } } } as never)
    expect(veces("idle-sub")).toBe(1)
    expect(veces("idle-stop")).toBe(1)
    await hooks["experimental.session.stop"]!({ sessionID: "padre" }, {})
    expect(veces("idle-stop")).toBe(2) // la llamada directa
    await ev({ event: { type: "session.status", properties: { sessionID: "padre", status: { type: "idle" } } } } as never)
    expect(veces("idle-stop")).toBe(2) // el idle ya no repite
  })
})

describe("UserPromptSubmit", () => {
  const msg = (text: string, synthetic = false) => ({ message: { id: "msg_1" }, parts: [{ type: "text", text, synthetic }] })
  test("código 2 rechaza el mensaje con el motivo; JSON block también", async () => {
    const dos = script("dos.js", 'console.error("sin secretos");process.exit(2)')
    const h1 = await instalar({ UserPromptSubmit: [{ command: dos }] })
    await expect(h1["chat.message"]!({ sessionID: "s" }, msg("hola") as never)).rejects.toThrow("sin secretos")
    const h2 = await instalar({ UserPromptSubmit: [{ command: siempreBloquea("no") }] })
    await expect(h2["chat.message"]!({ sessionID: "s" }, msg("hola") as never)).rejects.toThrow("rechazó")
  })
  test("stdout (código 0) se añade como parte sintética marcada, acotada; recibe el prompt por stdin", async () => {
    const f = path.join(dir, "p.json")
    const cmd = script("ctx.js", `let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{require("fs").writeFileSync(${JSON.stringify(f)},d);console.log("rama: "+"x".repeat(9000))})`)
    const hooks = await instalar({ UserPromptSubmit: [{ command: cmd }] })
    const m = msg("arregla el bug") as { message: { id: string }; parts: any[] }
    await hooks["chat.message"]!({ sessionID: "s", agent: "build" }, m as never)
    expect(m.parts.length).toBe(2)
    expect(m.parts[1]).toMatchObject({ type: "text", synthetic: true, sessionID: "s", messageID: "msg_1" })
    expect(m.parts[1].text.startsWith("[Gancho UserPromptSubmit]\nrama: ")).toBe(true)
    expect(m.parts[1].text.length).toBeLessThanOrEqual("[Gancho UserPromptSubmit]\n".length + 4000)
    expect(typeof m.parts[1].id).toBe("string")
    expect(JSON.parse(fs.readFileSync(f, "utf-8"))).toMatchObject({ event: "UserPromptSubmit", sessionID: "s", prompt: "arregla el bug", agent: "build" })
  })
  test("no corre con mensajes solo sintéticos ni en sesiones de ayudante", async () => {
    const client = { session: { get: async ({ path: p }: { path: { id: string } }) => ({ data: p.id === "hija" ? { parentID: "padre" } : {} }) } }
    const hooks = await instalar({ UserPromptSubmit: [{ command: contador("ups") }] }, client)
    await hooks["chat.message"]!({ sessionID: "s" }, msg("auto", true) as never)
    expect(veces("ups")).toBe(0)
    await hooks["chat.message"]!({ sessionID: "hija" }, msg("tarea del padre") as never)
    expect(veces("ups")).toBe(0)
    await hooks["chat.message"]!({ sessionID: "s" }, msg("hola") as never)
    expect(veces("ups")).toBe(1)
  })
})

describe("SessionStart", () => {
  test("se ejecuta UNA vez por sesión principal, su stdout va al sistema marcado y se repite igual en cada paso; ayudantes no", async () => {
    const client = { session: { get: async ({ path: p }: { path: { id: string } }) => ({ data: p.id === "hija" ? { parentID: "padre" } : {} }) } }
    const cmd = script("ss.js", `require("fs").appendFileSync(${JSON.stringify(path.join(dir, "ss.log"))},"x");console.log("Rama: main")`)
    const hooks = await instalar({ SessionStart: [{ command: cmd }] }, client)
    const tf = hooks["experimental.chat.system.transform"]!
    const a = { system: ["base"] }
    await tf({ sessionID: "s", model: {} as never }, a)
    const b = { system: ["base"] }
    await tf({ sessionID: "s", model: {} as never }, b)
    expect(a.system).toEqual(["base", "[Gancho SessionStart]\nRama: main"])
    expect(b.system).toEqual(a.system)
    expect(veces("ss")).toBe(1)
    const h = { system: ["base"] }
    await tf({ sessionID: "hija", model: {} as never }, h)
    expect(h.system).toEqual(["base"])
    const sin = { system: ["base"] }
    await tf({ model: {} as never }, sin)
    expect(sin.system).toEqual(["base"])
    expect(veces("ss")).toBe(1)
  })
  test("un SessionStart que falla o se pasa de tiempo no aporta nada", async () => {
    const hooks = await instalar({ SessionStart: [{ command: script("f.js", 'console.log("NO");process.exit(1)') }, { command: script("c.js", "setTimeout(()=>{},30000)"), timeout: 1 }] })
    const o = { system: ["base"] }
    await hooks["experimental.chat.system.transform"]!({ sessionID: "s", model: {} as never }, o)
    expect(o.system).toEqual(["base"])
  })
})

describe("PreToolUse updatedInput validado contra el esquema", () => {
  const Param = Schema.Struct({ n: Schema.Number, nombre: Schema.optional(Schema.String) })
  const definir = async (hooks: any, id = "mi_tool", parameters: unknown = Param) => hooks["tool.definition"]({ toolID: id }, { description: "d", parameters })
  const salida = (obj: unknown) => script("ui.js", `console.log(${JSON.stringify(JSON.stringify(obj))})`)

  test("updatedInput válido reemplaza los argumentos EN SITIO (mismo objeto)", async () => {
    const hooks = await instalar({ PreToolUse: [{ matcher: "mi_tool", command: salida({ updatedInput: { n: 2, nombre: "z" } }) }] })
    await definir(hooks)
    const args: any = { n: 1, borrar: true }
    const mismo = args
    await hooks["tool.execute.before"]!({ tool: "mi_tool", sessionID: "s", callID: "c" }, { args })
    expect(args).toBe(mismo)
    expect(args).toEqual({ n: 2, nombre: "z" })
  })
  test("también con hookSpecificOutput.updatedInput", async () => {
    const hooks = await instalar({ PreToolUse: [{ command: salida({ hookSpecificOutput: { updatedInput: { n: 7 } } }) }] })
    await definir(hooks)
    const args: any = { n: 1 }
    await hooks["tool.execute.before"]!({ tool: "mi_tool", sessionID: "s", callID: "c" }, { args })
    expect(args).toEqual({ n: 7 })
  })
  test("updatedInput inválido (tipo equivocado, falta requerido, no objeto, arreglo) se IGNORA y se registra", async () => {
    for (const malo of [{ n: "x" }, { nombre: "sin n" }, "texto", [1], null, 5]) {
      registroGanchos.length = 0
      const hooks = await instalar({ PreToolUse: [{ command: salida({ updatedInput: malo }) }] })
      await definir(hooks)
      const args: any = { n: 1 }
      await hooks["tool.execute.before"]!({ tool: "mi_tool", sessionID: "s", callID: "c" }, { args })
      expect(args).toEqual({ n: 1 })
      if (malo !== null) expect(registroGanchos.some((l) => l.includes("updatedInput") && l.includes("se ignora"))).toBe(true)
    }
  })
  test("herramienta sin esquema conocido (p. ej. MCP): se ignora y se registra", async () => {
    const hooks = await instalar({ PreToolUse: [{ command: salida({ updatedInput: { n: 2 } }) }] })
    const args: any = { n: 1 }
    await hooks["tool.execute.before"]!({ tool: "otra", sessionID: "s", callID: "c" }, { args })
    expect(args).toEqual({ n: 1 })
    expect(registroGanchos.some((l) => l.includes("no se conoce el esquema"))).toBe(true)
  })
  test("esquema JSON (jsonSchema) también se respeta: required, tipos y enum", async () => {
    const hooks = await instalar({ PreToolUse: [{ command: salida({ updatedInput: { modo: "c" } }) }] })
    await hooks["tool.definition"]!(
      { toolID: "js" },
      { description: "d", parameters: undefined, jsonSchema: { type: "object", properties: { modo: { type: "string", enum: ["a", "b"] } }, required: ["modo"] } },
    )
    const args: any = { modo: "a" }
    await hooks["tool.execute.before"]!({ tool: "js", sessionID: "s", callID: "c" }, { args })
    expect(args).toEqual({ modo: "a" })
    expect(validarEntrada({ jsonSchema: { type: "object", properties: { modo: { type: "string", enum: ["a", "b"] } }, required: ["modo"] } }, { modo: "b" })).toBeUndefined()
  })
  test("updatedInput gigante se ignora; un gancho que bloquea con JSON block también bloquea; gancho que falla (código 1) no cambia nada", async () => {
    const grande = salida({ updatedInput: { n: 1, nombre: "a".repeat(300 * 1024) } })
    const h1 = await instalar({ PreToolUse: [{ command: grande }] })
    await definir(h1)
    const args: any = { n: 1 }
    await h1["tool.execute.before"]!({ tool: "mi_tool", sessionID: "s", callID: "c" }, { args })
    expect(args).toEqual({ n: 1 }) // además la salida se corta a 8 KB: JSON roto
    const h2 = await instalar({ PreToolUse: [{ command: siempreBloquea("nunca") }] })
    await expect(h2["tool.execute.before"]!({ tool: "mi_tool", sessionID: "s", callID: "c" }, { args })).rejects.toThrow("nunca")
    const h3 = await instalar({ PreToolUse: [{ command: script("e.js", `console.log(${JSON.stringify(JSON.stringify({ updatedInput: { n: 9 } }))});process.exit(1)`) }] })
    await definir(h3)
    await h3["tool.execute.before"]!({ tool: "mi_tool", sessionID: "s", callID: "c" }, { args })
    expect(args).toEqual({ n: 1 })
  })
  test("dos ganchos encadenados: el 2.º ve los argumentos ya cambiados por el 1.º", async () => {
    const f = path.join(dir, "visto.json")
    const segundo = script("seg.js", `let d="";process.stdin.on("data",c=>d+=c).on("end",()=>require("fs").writeFileSync(${JSON.stringify(f)},JSON.stringify(JSON.parse(d).args)))`)
    const hooks = await instalar({ PreToolUse: [{ command: salida({ updatedInput: { n: 5 } }) }, { command: segundo }] })
    await definir(hooks)
    const args: any = { n: 1 }
    await hooks["tool.execute.before"]!({ tool: "mi_tool", sessionID: "s", callID: "c" }, { args })
    expect(JSON.parse(fs.readFileSync(f, "utf-8"))).toEqual({ n: 5 })
  })
})

describe("el archivo de ganchos sigue siendo solo el de la app", () => {
  test("sin LAZUNOX_HOOKS_FILE (o con ruta relativa) no hay ganchos, aunque el proyecto traiga un archivo con el mismo formato", async () => {
    fs.mkdirSync(path.join(dir, ".opencode"), { recursive: true })
    const marca = path.join(dir, "marca")
    const hostil = { hooks: { Stop: [{ command: `echo x > "${marca}"` }], SessionStart: [{ command: `echo x > "${marca}"` }], UserPromptSubmit: [{ command: `echo x > "${marca}"` }] } }
    for (const f of ["ganchos.json", ".opencode/hooks.json", "hooks.json", ".claude/settings.json"]) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
      fs.writeFileSync(path.join(dir, f), JSON.stringify(hostil))
    }
    delete process.env.LAZUNOX_HOOKS_FILE
    expect(await LazunoxGanchosPlugin({ directory: dir } as never)).toEqual({})
    process.env.LAZUNOX_HOOKS_FILE = "ganchos.json"
    expect(await LazunoxGanchosPlugin({ directory: dir } as never)).toEqual({})
    expect(fs.existsSync(marca)).toBe(false)
  })
  test("el archivo de la app con tipos nuevos se lee con leerConfig igual", () => {
    expect(leerConfig('{"hooks":{"Stop":[{"command":"a"}]}}').Stop.length).toBe(1)
  })
})
