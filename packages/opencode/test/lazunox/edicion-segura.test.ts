// Ola 7, paquete 7.8: edición más segura. Rechazo de archivos que no son UTF-8, U+FFFD en write, y finales de línea por región.
// Cada caso con `LAZUNOX_EDICION_SEGURA=0` documenta el comportamiento de antes (el bug).
import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit } from "effect"
import { EditTool } from "../../src/tool/edit"
import { WriteTool } from "../../src/tool/write"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"
import * as Finales from "../../src/util/finales"

const ctx = {
  sessionID: SessionID.make("ses_test-edicion-segura"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  delete process.env.LAZUNOX_EDICION_SEGURA
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([LSP.node, FSUtil.node, Format.node, EventV2Bridge.node, Truncate.node, Agent.node]),
  ),
)

const edit = Effect.fn("seg.edit")(function* (args: { filePath: string; oldString: string; newString: string; replaceAll?: boolean }) {
  const t = yield* (yield* EditTool).init()
  return yield* t.execute(args, ctx)
})
const write = Effect.fn("seg.write")(function* (args: { filePath: string; content: string }) {
  const t = yield* (yield* WriteTool).init()
  return yield* t.execute(args, ctx)
})
const patch = Effect.fn("seg.patch")(function* (patchText: string) {
  const t = yield* (yield* ApplyPatchTool).init()
  return yield* t.execute({ patchText }, ctx)
})

const bytes = (p: string, b: Uint8Array | string) => Effect.promise(() => fs.writeFile(p, b))
const leer = (p: string) => Effect.promise(() => fs.readFile(p))
const leerTexto = (p: string) => Effect.promise(() => fs.readFile(p, "utf-8"))
const mensaje = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(eff)
    if (Exit.isSuccess(exit)) return undefined
    const e = Cause.squash(exit.cause)
    return e instanceof Error ? e.message : String(e)
  })

// "Ñandú" en Latin-1: F1 61 6E 64 FA — no es UTF-8 válido
const LATIN1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x6f, 0x74, 0x72, 0x6f, 0x0a])

describe("7.8 funciones puras de finales de línea", () => {
  test("conserva por línea en un archivo mixto", () => {
    const o = Finales.dividir("a\r\nb\nc\r\nd")
    expect(o.vista).toBe("a\nb\nc\nd")
    expect(Finales.restaurar("a\nB\nC\nd", o)).toBe("a\r\nB\nC\r\nd")
  })
  test("CR solitario", () => {
    const o = Finales.dividir("a\rb\rc")
    expect(Finales.restaurar("a\nX\nc", o)).toBe("a\rX\rc")
  })
  test("líneas añadidas heredan el final de la anterior", () => {
    const o = Finales.dividir("a\r\nb\nc\r\n")
    expect(Finales.restaurar("a\nnueva\nb\nc\n", o)).toBe("a\r\nnueva\r\nb\nc\r\n")
  })
})

describe("7.8 archivos que no son UTF-8", () => {
  it.instance("edit se niega y no toca el archivo", () =>
    Effect.gen(function* () {
      const p = path.join((yield* TestInstance).directory, "latin1.txt")
      yield* bytes(p, LATIN1)
      const m = yield* mensaje(edit({ filePath: p, oldString: "otro", newString: "OTRO" }))
      expect(m).toContain("no es UTF-8")
      expect(m).toContain("shell")
      expect(Buffer.compare(yield* leer(p), LATIN1)).toBe(0)
    }),
  )
  it.instance("write se niega a sobrescribir un archivo no UTF-8", () =>
    Effect.gen(function* () {
      const p = path.join((yield* TestInstance).directory, "latin1.txt")
      yield* bytes(p, LATIN1)
      const m = yield* mensaje(write({ filePath: p, content: "nuevo" }))
      expect(m).toContain("no es UTF-8")
      expect(Buffer.compare(yield* leer(p), LATIN1)).toBe(0)
    }),
  )
  it.instance("apply_patch se niega y no toca el archivo", () =>
    Effect.gen(function* () {
      const p = path.join((yield* TestInstance).directory, "latin1.txt")
      yield* bytes(p, LATIN1)
      const m = yield* mensaje(patch(`*** Begin Patch\n*** Update File: latin1.txt\n@@\n-otro\n+OTRO\n*** End Patch`))
      expect(m).toContain("no es UTF-8")
      expect(Buffer.compare(yield* leer(p), LATIN1)).toBe(0)
    }),
  )
  it.instance("con LAZUNOX_EDICION_SEGURA=0 vuelve a degradar (documenta el bug)", () =>
    Effect.gen(function* () {
      process.env.LAZUNOX_EDICION_SEGURA = "0"
      const p = path.join((yield* TestInstance).directory, "latin1.txt")
      yield* bytes(p, LATIN1)
      yield* edit({ filePath: p, oldString: "otro", newString: "OTRO" })
      expect(yield* leerTexto(p)).toContain("�")
    }),
  )
  it.instance("UTF-16 LE con BOM se edita y se conserva en UTF-16 LE", () =>
    Effect.gen(function* () {
      const p = path.join((yield* TestInstance).directory, "u16.txt")
      yield* bytes(p, Buffer.from("﻿hola\r\nmundo\r\n", "utf16le"))
      yield* edit({ filePath: p, oldString: "mundo", newString: "tierra" })
      const out = yield* leer(p)
      expect(out[0]).toBe(0xff)
      expect(out[1]).toBe(0xfe)
      expect(out.toString("utf16le")).toBe("﻿hola\r\ntierra\r\n")
    }),
  )
  it.instance("un archivo UTF-8 con BOM sigue conservando el BOM", () =>
    Effect.gen(function* () {
      const p = path.join((yield* TestInstance).directory, "bom.txt")
      yield* bytes(p, "﻿café\n")
      yield* edit({ filePath: p, oldString: "café", newString: "té" })
      expect(yield* leerTexto(p)).toBe("﻿té\n")
    }),
  )
})

describe("7.8 write y U+FFFD", () => {
  it.instance("se niega si el contenido nuevo trae U+FFFD que no estaba", () =>
    Effect.gen(function* () {
      const p = path.join((yield* TestInstance).directory, "a.txt")
      yield* bytes(p, "limpio\n")
      const m = yield* mensaje(write({ filePath: p, content: "caf�\n" }))
      expect(m).toContain("U+FFFD")
      expect(yield* leerTexto(p)).toBe("limpio\n")
    }),
  )
  it.instance("un archivo nuevo con U+FFFD también se rechaza", () =>
    Effect.gen(function* () {
      const p = path.join((yield* TestInstance).directory, "nuevo.txt")
      expect(yield* mensaje(write({ filePath: p, content: "x�y" }))).toContain("U+FFFD")
    }),
  )
  it.instance("si el archivo ya lo tenía, se permite", () =>
    Effect.gen(function* () {
      const p = path.join((yield* TestInstance).directory, "b.txt")
      yield* bytes(p, "ya � estaba\n")
      yield* write({ filePath: p, content: "ya � estaba y más\n" })
      expect(yield* leerTexto(p)).toBe("ya � estaba y más\n")
    }),
  )
  it.instance("apagado: escribe con U+FFFD como antes", () =>
    Effect.gen(function* () {
      process.env.LAZUNOX_EDICION_SEGURA = "0"
      const p = path.join((yield* TestInstance).directory, "c.txt")
      yield* write({ filePath: p, content: "x�y" })
      expect(yield* leerTexto(p)).toBe("x�y")
    }),
  )
})

describe("7.8 edit conserva los finales por región", () => {
  it.instance("archivo mixto: las líneas LF y CRLF siguen como estaban", () =>
    Effect.gen(function* () {
      const p = path.join((yield* TestInstance).directory, "mixto.txt")
      yield* bytes(p, "a\r\nb\nc\r\nd\n")
      yield* edit({ filePath: p, oldString: "b\nc", newString: "B\nC" })
      expect(yield* leerTexto(p)).toBe("a\r\nB\nC\r\nd\n")
    }),
  )
  it.instance("mixto: el oldString multilínea coincide aunque las líneas tengan finales distintos", () =>
    Effect.gen(function* () {
      const p = path.join((yield* TestInstance).directory, "mixto2.txt")
      yield* bytes(p, "uno\ndos\r\ntres\n")
      yield* edit({ filePath: p, oldString: "uno\ndos\ntres", newString: "1\n2\n3" })
      expect(yield* leerTexto(p)).toBe("1\n2\r\n3\n")
    }),
  )
  it.instance("CR solitario se conserva", () =>
    Effect.gen(function* () {
      const p = path.join((yield* TestInstance).directory, "cr.txt")
      yield* bytes(p, "a\rb\rc\r")
      yield* edit({ filePath: p, oldString: "b", newString: "B\nextra" })
      expect(yield* leerTexto(p)).toBe("a\rB\rextra\rc\r")
    }),
  )
  it.instance("CRLF puro sigue igual que antes", () =>
    Effect.gen(function* () {
      const p = path.join((yield* TestInstance).directory, "crlf.txt")
      yield* bytes(p, "a\r\nb\r\nc\r\n")
      yield* edit({ filePath: p, oldString: "b", newString: "B1\nB2" })
      expect(yield* leerTexto(p)).toBe("a\r\nB1\r\nB2\r\nc\r\n")
    }),
  )
  it.instance("apagado: el mixto se convierte entero (el bug de antes)", () =>
    Effect.gen(function* () {
      process.env.LAZUNOX_EDICION_SEGURA = "0"
      const p = path.join((yield* TestInstance).directory, "mixto.txt")
      yield* bytes(p, "a\r\nb\nc\r\nd\n")
      yield* mensaje(edit({ filePath: p, oldString: "b\nc", newString: "B\nC" }))
      // antes: o fallaba o convertía todo el texto nuevo al final detectado; en ningún caso conserva el LF de la línea B
      expect(yield* leerTexto(p)).not.toBe("a\r\nB\nC\r\nd\n")
    }),
  )
})

describe("7.8 apply_patch conserva CRLF/LF", () => {
  it.instance("archivo CRLF: las líneas nuevas salen en CRLF", () =>
    Effect.gen(function* () {
      const p = path.join((yield* TestInstance).directory, "crlf.txt")
      yield* bytes(p, "uno\r\ndos\r\ntres\r\n")
      yield* patch(`*** Begin Patch\n*** Update File: crlf.txt\n@@\n uno\n-dos\n+DOS\n+DOS2\n tres\n*** End Patch`)
      expect(yield* leerTexto(p)).toBe("uno\r\nDOS\r\nDOS2\r\ntres\r\n")
    }),
  )
  it.instance("archivo mixto: lo que no se toca queda igual", () =>
    Effect.gen(function* () {
      const p = path.join((yield* TestInstance).directory, "mixto.txt")
      yield* bytes(p, "uno\ndos\r\ntres\n")
      yield* patch(`*** Begin Patch\n*** Update File: mixto.txt\n@@\n-uno\n+UNO\n dos\n tres\n*** End Patch`)
      expect(yield* leerTexto(p)).toBe("UNO\ndos\r\ntres\n")
    }),
  )
  it.instance("apagado: las líneas nuevas salen en LF dentro de un archivo CRLF (el bug de antes)", () =>
    Effect.gen(function* () {
      process.env.LAZUNOX_EDICION_SEGURA = "0"
      const p = path.join((yield* TestInstance).directory, "crlf.txt")
      yield* bytes(p, "uno\r\ndos\r\ntres\r\n")
      yield* patch(`*** Begin Patch\n*** Update File: crlf.txt\n@@\n uno\n-dos\n+DOS\n tres\n*** End Patch`)
      expect(yield* leerTexto(p)).toContain("DOS\n")
      expect(yield* leerTexto(p)).not.toContain("DOS\r\n")
    }),
  )
})
