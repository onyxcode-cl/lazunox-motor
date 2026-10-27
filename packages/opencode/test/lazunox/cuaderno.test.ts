// Ola 7, paquete 7.15: cuaderno_editar (cuadernos Jupyter). No ejecuta nada.
import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import os from "os"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit } from "effect"
import { CuadernoTool } from "../../src/tool/cuaderno"
import { editarCuaderno } from "../../src/tool/cuaderno-nb"
import { cuadernoHabilitado, hayCuadernos } from "../../src/tool/cuaderno-registro"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { SessionID, MessageID } from "../../src/session/schema"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { testEffect } from "../lib/effect"

const asks: { permission: string; patterns: readonly string[] }[] = []
const ctx = {
  sessionID: SessionID.make("ses_test-cuaderno"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: (r: { permission: string; patterns: readonly string[] }) => Effect.sync(() => void asks.push(r)),
}

afterEach(async () => {
  asks.length = 0
  await disposeAllInstances()
})

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, EventV2Bridge.node, Truncate.node, Agent.node])))

const nb = (over: Record<string, unknown> = {}) => ({
  cells: [
    {
      cell_type: "markdown",
      id: "aaaa1111",
      metadata: {},
      source: ["# Título\n", "texto con ñ y 😀"],
    },
    {
      cell_type: "code",
      execution_count: 3,
      id: "bbbb2222",
      metadata: { tags: ["x"] },
      outputs: [{ name: "stdout", output_type: "stream", text: ["hola\n"] }],
      source: ["print('hola')"],
    },
    {
      cell_type: "code",
      execution_count: 4,
      id: "cccc3333",
      metadata: {},
      outputs: [
        { data: { "text/plain": ["1.5"], "image/png": "iVBORw0KGgo=" }, execution_count: 4, metadata: {}, output_type: "execute_result" },
      ],
      source: ["1.5"],
    },
  ],
  metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" }, language_info: { name: "python", version: "3.11.4" } },
  nbformat: 4,
  nbformat_minor: 5,
  ...over,
})
const texto = (o: unknown, indent: number | string = 1) => JSON.stringify(o, null, indent) + "\n"

const ejecutar = Effect.fn("nb.exec")(function* (args: Record<string, unknown>) {
  const t = yield* (yield* CuadernoTool).init()
  return yield* t.execute(args as never, ctx)
})
const mensaje = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(eff)
    if (Exit.isSuccess(exit)) return undefined
    const e = Cause.squash(exit.cause)
    return e instanceof Error ? e.message : String(e)
  })
const leer = (p: string) => Effect.promise(() => fs.readFile(p, "utf-8"))
const escribir = (p: string, t: string) => Effect.promise(() => fs.writeFile(p, t))

describe("7.15 núcleo puro", () => {
  test("reemplazar una celda de código por id borra solo SUS salidas y deja las demás intactas", () => {
    const o = texto(nb())
    const r = editarCuaderno(o, { operacion: "reemplazar", celdaId: "bbbb2222", contenido: "print('adiós')\nx = 1" })
    const n = JSON.parse(r.texto)
    expect(n.cells[1].source).toEqual(["print('adiós')\n", "x = 1"])
    expect(n.cells[1].outputs).toEqual([])
    expect(n.cells[1].execution_count).toBeNull()
    expect(n.cells[1].metadata).toEqual({ tags: ["x"] })
    expect(n.cells[1].id).toBe("bbbb2222")
    expect(n.cells[2]).toEqual(nb().cells[2])
    expect(n.cells[0]).toEqual(nb().cells[0])
    expect(n.nbformat_minor).toBe(5)
    expect(n.metadata).toEqual(nb().metadata)
    expect(r.normalizado).toBe(false)
    expect(r.texto.endsWith("\n")).toBe(true)
  })
  test("reemplazar con el mismo código conserva las salidas", () => {
    const r = editarCuaderno(texto(nb()), { operacion: "reemplazar", indice: 1, contenido: "print('hola')" })
    expect(JSON.parse(r.texto).cells[1].outputs).toHaveLength(1)
    expect(r.texto).toBe(texto(nb()))
  })
  test("celda de texto: reemplazar cambia el texto y no añade salidas", () => {
    const r = editarCuaderno(texto(nb()), { operacion: "reemplazar", indice: 0, contenido: "## Nuevo" })
    const c = JSON.parse(r.texto).cells[0]
    expect(c.source).toEqual(["## Nuevo"])
    expect(c.outputs).toBeUndefined()
    expect(c.execution_count).toBeUndefined()
  })
  test("cambiar el tipo de código a texto quita las salidas; de texto a código las crea vacías", () => {
    const a = JSON.parse(editarCuaderno(texto(nb()), { operacion: "reemplazar", indice: 1, tipo: "markdown", contenido: "x" }).texto)
    expect(a.cells[1].cell_type).toBe("markdown")
    expect(a.cells[1].outputs).toBeUndefined()
    const b = JSON.parse(editarCuaderno(texto(nb()), { operacion: "reemplazar", indice: 0, tipo: "code", contenido: "y" }).texto)
    expect(b.cells[0].outputs).toEqual([])
    expect(b.cells[0].execution_count).toBeNull()
  })
  test("insertar: después de un id, en un índice, y al final; con id nuevo único (nbformat 4.5)", () => {
    const despues = JSON.parse(editarCuaderno(texto(nb()), { operacion: "insertar", celdaId: "aaaa1111", contenido: "a = 1" }).texto)
    expect(despues.cells.map((c: { id: string }) => c.id)[0]).toBe("aaaa1111")
    expect(despues.cells[1].source).toEqual(["a = 1"])
    expect(despues.cells[1].cell_type).toBe("code")
    expect(despues.cells[1].outputs).toEqual([])
    expect(despues.cells[1].id).toMatch(/^[0-9a-f]{8}$/)
    expect(new Set(despues.cells.map((c: { id: string }) => c.id)).size).toBe(4)
    const enIndice = JSON.parse(editarCuaderno(texto(nb()), { operacion: "insertar", indice: 0, tipo: "markdown", contenido: "# Inicio" }).texto)
    expect(enIndice.cells[0].source).toEqual(["# Inicio"])
    expect(enIndice.cells[0].outputs).toBeUndefined()
    const alFinal = JSON.parse(editarCuaderno(texto(nb()), { operacion: "insertar", contenido: "fin" }).texto)
    expect(alFinal.cells[3].source).toEqual(["fin"])
    const enN = JSON.parse(editarCuaderno(texto(nb()), { operacion: "insertar", indice: 3, contenido: "fin" }).texto)
    expect(enN.cells).toHaveLength(4)
  })
  test("insertar en nbformat 4.4 no inventa ids", () => {
    const viejo = nb({ nbformat_minor: 4 })
    for (const c of viejo.cells as Record<string, unknown>[]) delete c.id
    const r = JSON.parse(editarCuaderno(texto(viejo), { operacion: "insertar", contenido: "z" }).texto)
    expect(r.cells[3].id).toBeUndefined()
  })
  test("borrar por id y por índice", () => {
    const a = JSON.parse(editarCuaderno(texto(nb()), { operacion: "borrar", celdaId: "bbbb2222" }).texto)
    expect(a.cells.map((c: { id: string }) => c.id)).toEqual(["aaaa1111", "cccc3333"])
    expect(a.cells[1]).toEqual(nb().cells[2])
    const b = JSON.parse(editarCuaderno(texto(nb()), { operacion: "borrar", indice: 2 }).texto)
    expect(b.cells).toHaveLength(2)
  })
  test("índice fuera de rango, id inexistente, id e índice contradictorios y falta de destino", () => {
    const o = texto(nb())
    expect(() => editarCuaderno(o, { operacion: "borrar", indice: 3 })).toThrow("fuera de rango")
    expect(() => editarCuaderno(o, { operacion: "borrar", indice: -1 })).toThrow("fuera de rango")
    expect(() => editarCuaderno(o, { operacion: "reemplazar", indice: 99, contenido: "x" })).toThrow("fuera de rango")
    expect(() => editarCuaderno(o, { operacion: "insertar", indice: 4, contenido: "x" })).toThrow("fuera de rango")
    expect(() => editarCuaderno(o, { operacion: "borrar", indice: 1.5 })).toThrow("entero")
    expect(() => editarCuaderno(o, { operacion: "borrar", celdaId: "nope" })).toThrow('No hay ninguna celda con id "nope"')
    expect(() => editarCuaderno(o, { operacion: "borrar", celdaId: "aaaa1111", indice: 2 })).toThrow("distintas")
    expect(() => editarCuaderno(o, { operacion: "borrar" })).toThrow("Indica la celda")
    expect(() => editarCuaderno(o, { operacion: "reemplazar", indice: 0 })).toThrow("contenido")
    expect(() => editarCuaderno(o, { operacion: "insertar" })).toThrow("contenido")
  })
  test("JSON roto, no cuaderno, nbformat 3, celdas inválidas, ids repetidos", () => {
    expect(() => editarCuaderno("{ no es json", { operacion: "borrar", indice: 0 })).toThrow("JSON válido")
    expect(() => editarCuaderno("[1]", { operacion: "borrar", indice: 0 })).toThrow("no es un cuaderno")
    expect(() => editarCuaderno(JSON.stringify({ cells: [] }), { operacion: "insertar", contenido: "x" })).toThrow("nbformat 4")
    expect(() => editarCuaderno(JSON.stringify(nb({ nbformat: 3 })), { operacion: "borrar", indice: 0 })).toThrow("nbformat 4")
    expect(() => editarCuaderno(JSON.stringify(nb({ cells: [{ cell_type: "otra", source: "" }] })), { operacion: "borrar", indice: 0 })).toThrow("cell_type")
    expect(() => editarCuaderno(JSON.stringify(nb({ cells: [{ cell_type: "raw", source: 5 }] })), { operacion: "borrar", indice: 0 })).toThrow("source")
    const dup = nb()
    ;(dup.cells[1] as { id: string }).id = "aaaa1111"
    expect(() => editarCuaderno(JSON.stringify(dup), { operacion: "borrar", indice: 0 })).toThrow("repetido")
  })
  test("conserva la sangría (1 espacio, 2 o tabulador), la falta de salto final y CRLF", () => {
    for (const sang of [1, 2, 4, "\t"] as const) {
      const r = editarCuaderno(texto(nb(), sang), { operacion: "reemplazar", indice: 0, contenido: "# Título\ntexto con ñ y 😀" })
      expect(r.texto).toBe(texto(nb(), sang).replace('"# Título\\n",\n', '"# Título\\n",\n'))
    }
    const sinSalto = JSON.stringify(nb(), null, 1)
    expect(editarCuaderno(sinSalto, { operacion: "borrar", indice: 2 }).texto.endsWith("\n")).toBe(false)
    const crlf = texto(nb()).replaceAll("\n", "\r\n")
    const r = editarCuaderno(crlf, { operacion: "borrar", indice: 2 })
    expect(r.texto).toContain("\r\n")
    expect(r.texto.replaceAll("\r\n", "")).not.toContain("\n")
  })
  test("cuaderno sin cambios de formato no se marca como normalizado; con \\u escapes sí", () => {
    expect(editarCuaderno(texto(nb()), { operacion: "borrar", indice: 2 }).normalizado).toBe(false)
    const escapado = texto(nb()).replace("ñ", "\\u00f1")
    expect(editarCuaderno(escapado, { operacion: "borrar", indice: 2 }).normalizado).toBe(true)
  })
  test("rechaza enteros de 16+ dígitos fuera de cadenas (se corromperían) pero no base64 en cadenas", () => {
    const o = nb()
    ;(o.cells[1] as { metadata: unknown }).metadata = {}
    const conGrande = texto(o).replace('"execution_count": 3', '"execution_count": 12345678901234567890')
    expect(() => editarCuaderno(conGrande, { operacion: "borrar", indice: 0 })).toThrow("16 o más dígitos")
    const b64 = nb()
    ;(b64.cells[2] as unknown as { outputs: { data: Record<string, string> }[] }).outputs[0]!.data["image/png"] = "AAAA12345678901234567890BBBB"
    expect(() => editarCuaderno(texto(b64), { operacion: "borrar", indice: 0 })).not.toThrow()
  })
  test("archivo grande: se rechaza por tamaño; contenido enorme también", () => {
    expect(() => editarCuaderno(" ".repeat(21 * 1024 * 1024), { operacion: "borrar", indice: 0 })).toThrow("20 MB")
    expect(() => editarCuaderno(texto(nb()), { operacion: "insertar", contenido: "x".repeat(1024 * 1024 + 1) })).toThrow("KB")
  })
  test("cuaderno con muchas celdas (3000) se edita sin tocar las demás", () => {
    const grande = nb({ cells: Array.from({ length: 3000 }, (_, i) => ({ cell_type: "code", execution_count: i, id: `id${String(i).padStart(6, "0")}`, metadata: {}, outputs: [], source: [`x = ${i}`] })) })
    const r = JSON.parse(editarCuaderno(texto(grande), { operacion: "reemplazar", indice: 1500, contenido: "y" }).texto)
    expect(r.cells).toHaveLength(3000)
    expect(r.cells[1499]).toEqual(grande.cells[1499])
    expect(r.cells[1500].source).toEqual(["y"])
  })
})

describe("7.15 la herramienta", () => {
  it.instance("edita el archivo, pide permiso edit con la ruta relativa y no toca lo demás", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const p = path.join(dir, "n.ipynb")
      yield* escribir(p, texto(nb()))
      const r = yield* ejecutar({ filePath: p, operacion: "reemplazar", celdaId: "cccc3333", contenido: "2 + 2" })
      expect(r.output).toContain("Reemplazada la celda 2")
      expect(asks).toHaveLength(1)
      expect(asks[0]!.permission).toBe("edit")
      expect(asks[0]!.patterns[0]!.endsWith("n.ipynb")).toBe(true)
      expect(asks[0]!.patterns[0]!.startsWith("..")).toBe(false)
      const n = JSON.parse(yield* leer(p))
      expect(n.cells[1]).toEqual(nb().cells[1])
      expect(n.cells[2].source).toEqual(["2 + 2"])
    }),
  )
  it.instance("si el permiso se niega, el archivo queda igual", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const p = path.join(dir, "n.ipynb")
      yield* escribir(p, texto(nb()))
      const t = yield* (yield* CuadernoTool).init()
      const m = yield* mensaje(t.execute({ filePath: p, operacion: "borrar", indice: 0 } as never, { ...ctx, ask: () => Effect.fail(new Error("negado")) } as never))
      expect(m).toContain("negado")
      expect(yield* leer(p)).toBe(texto(nb()))
    }),
  )
  it.instance("errores: no es .ipynb, no existe, JSON roto (sin pedir permiso ni tocar nada)", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      expect(yield* mensaje(ejecutar({ filePath: path.join(dir, "a.py"), operacion: "borrar", indice: 0 }))).toContain("solo edita archivos .ipynb")
      expect(yield* mensaje(ejecutar({ filePath: path.join(dir, "no.ipynb"), operacion: "borrar", indice: 0 }))).toContain("No existe")
      const roto = path.join(dir, "roto.ipynb")
      yield* escribir(roto, "{ roto")
      expect(yield* mensaje(ejecutar({ filePath: roto, operacion: "borrar", indice: 0 }))).toContain("JSON válido")
      expect(yield* leer(roto)).toBe("{ roto")
      expect(asks).toHaveLength(0)
    }),
  )
  it.instance("rechaza un cuaderno que no es UTF-8", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const p = path.join(dir, "l.ipynb")
      yield* Effect.promise(() => fs.writeFile(p, Buffer.from([0x7b, 0xe9, 0x7d])))
      expect(yield* mensaje(ejecutar({ filePath: p, operacion: "borrar", indice: 0 }))).toContain("no es UTF-8")
    }),
  )
  it.instance("ruta fuera del proyecto: pide external_directory antes", () =>
    Effect.gen(function* () {
      const fuera = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "nbfuera-")))
      const p = path.join(fuera, "n.ipynb")
      yield* escribir(p, texto(nb()))
      yield* ejecutar({ filePath: p, operacion: "borrar", indice: 0 })
      expect(asks.map((a) => a.permission)).toEqual(["external_directory", "edit"])
      yield* Effect.promise(() => fs.rm(fuera, { recursive: true }))
    }),
  )
  it.instance("dos ediciones simultáneas no se pisan", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const p = path.join(dir, "n.ipynb")
      yield* escribir(p, texto(nb()))
      yield* Effect.all(
        [0, 1, 2].map((i) => ejecutar({ filePath: p, operacion: "insertar", contenido: `c${i}` })),
        { concurrency: "unbounded" },
      )
      expect(JSON.parse(yield* leer(p)).cells).toHaveLength(6)
    }),
  )
})

describe("7.15 registro condicionado", () => {
  test("solo se ofrece si hay cuadernos; el interruptor manda", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nbreg-"))
    try {
      expect(cuadernoHabilitado(dir, {})).toBe(false)
      await fs.mkdir(path.join(dir, "node_modules"))
      await fs.writeFile(path.join(dir, "node_modules", "x.ipynb"), "{}")
      expect(hayCuadernos(dir)).toBe(false)
      await fs.mkdir(path.join(dir, "ana", "lisis"), { recursive: true })
      await fs.writeFile(path.join(dir, "ana", "lisis", "Datos.IPYNB"), "{}")
      expect(cuadernoHabilitado(dir, {})).toBe(true)
      expect(cuadernoHabilitado(dir, { LAZUNOX_CUADERNO: "0" })).toBe(false)
      expect(cuadernoHabilitado(path.join(dir, "node_modules"), { LAZUNOX_CUADERNO: "1" })).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })
})
