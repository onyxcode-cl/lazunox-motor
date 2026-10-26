import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { EditTool, replace } from "../../src/tool/edit"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import * as Tool from "../../src/tool/tool"
import { testEffect } from "../lib/effect"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"

const ctx = {
  sessionID: SessionID.make("ses_test-edit-session"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const layer = LayerNode.compile(
  LayerNode.group([LSP.node, FSUtil.node, Format.node, EventV2Bridge.node, Truncate.node, Agent.node]),
)

const it = testEffect(layer)

const init = Effect.fn("EditToolTest.init")(function* () {
  const info = yield* EditTool
  return yield* info.init()
})

const run = Effect.fn("EditToolTest.run")(function* (
  args: Tool.InferParameters<typeof EditTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const fail = Effect.fn("EditToolTest.fail")(function* (args: Tool.InferParameters<typeof EditTool>) {
  const exit = yield* run(args).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected edit to fail")
})

const put = Effect.fn("EditToolTest.put")(function* (p: string, content: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(p, content)
})

const load = Effect.fn("EditToolTest.load")(function* (p: string) {
  const fs = yield* FSUtil.Service
  return yield* fs.readFileString(p)
})

const loadRaw = Effect.fn("EditToolTest.loadRaw")(function* (p: string) {
  return yield* Effect.promise(() => fs.readFile(p, "utf-8"))
})

const makeDirectory = Effect.fn("EditToolTest.makeDirectory")(function* (p: string) {
  const fs = yield* FSUtil.Service
  yield* fs.makeDirectory(p)
})


const LQ = "“", RQ = "”", EM = "—", EN = "–", NB = " "

describe("edicion tolerante a Unicode (6.5)", () => {
  test("comillas tipograficas del archivo contra comillas rectas del modelo", () => {
    const file = `Dijo ${LQ}hola${RQ} y se fue.\nOtra linea.`
    expect(replace(file, 'Dijo "hola" y', "Dijo chao y")).toBe("Dijo chao y se fue.\nOtra linea.")
  })
  test("angulares y simples", () => {
    const file = "Escribio «carta» y ‘nota’."
    expect(replace(file, `"carta" y 'nota'`, "X")).toBe("Escribio X.")
  })
  test("guiones largos y medios", () => {
    const file = `Total ${EM} sin IVA ${EN} neto\nfin`
    expect(replace(file, "Total - sin IVA - neto", "T")).toBe("T\nfin")
  })
  test("NBSP y espacios finos", () => {
    const file = `Monto:${NB}100 pesos\nresto`
    expect(replace(file, "Monto: 100 pesos", "M")).toBe("M\nresto")
  })
  test("conserva los caracteres originales fuera del tramo y newString exacto", () => {
    const file = `${LQ}uno${RQ}\n${LQ}dos${RQ}\n${LQ}tres${RQ}`
    const out = replace(file, '"dos"', '"DOS"')
    expect(out).toBe(`${LQ}uno${RQ}\n"DOS"\n${LQ}tres${RQ}`)
  })
  test("varias coincidencias tolerantes: error", () => {
    const file = `${LQ}a${RQ}\nx\n"a"\n`
    expect(() => replace(file, "'a'".replace(/'/g, '"'), "z")).not.toThrow() // la exacta "a" es unica
    const dos = `${LQ}a${RQ}\nx\n${LQ}a${RQ}\n`
    expect(() => replace(dos, '"a"', "z")).toThrow()
  })
  test("sin coincidencia: error como hoy", () => {
    expect(() => replace(`${LQ}a${RQ}`, '"b"', "z")).toThrow("Could not find")
  })
  test("homografo cirilico NO coincide", () => {
    const file = "pаssword = 1" // a cirilica
    expect(() => replace(file, "password = 1", "x")).toThrow()
    expect(() => replace("password = 1", "pаssword = 1", "x")).toThrow()
  })
  test("CRLF", () => {
    const file = `l1\r\n${LQ}dos${RQ}\r\nl3\r\n`
    expect(replace(file, '"dos"', "X")).toBe("l1\r\nX\r\nl3\r\n")
  })
  test("binario no se toca", () => {
    expect(() => replace(`a\0${LQ}b${RQ}`, '"b"', "x")).toThrow()
  })
  test("puntos suspensivos", () => {
    expect(replace("espera… ya", "espera... ya", "ok")).toBe("ok")
  })
  test("tildes NFC/NFD no se igualan (fuera de la lista cerrada)", () => {
    expect(() => replace("canción", "canción", "x")).toThrow()
  })
  test("no cambia la exacta ni otros replacers", () => {
    expect(replace("a b c", "b", "X")).toBe("a X c")
  })
})

describe("tool.edit unicode", () => {
  it.instance("edita y avisa en una linea", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "carta.txt")
      yield* put(filepath, `Estimado:\r\n${LQ}Gracias${RQ} ${EM} atte.\r\nFin\r\n`)
      const result = yield* run({ filePath: filepath, oldString: '"Gracias" - atte.', newString: '"Chao"' })
      expect(result.output).toContain("normalized")
      expect(yield* loadRaw(filepath)).toBe(`Estimado:\r\n"Chao"\r\nFin\r\n`)
    }),
  )
})
