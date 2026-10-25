import { describe, expect, test } from "bun:test"
import { BLOQUE_MAX_BYTES, construirBloque, presupuestoBloque, recortarBytes } from "../../src/session/contexto-vigente"

const vacio = { tareas: [], habilidades: [], instrucciones: [], ayudantes: [], ganchos: [], presupuestoBytes: BLOQUE_MAX_BYTES }
const bytes = (s: string) => Buffer.byteLength(s, "utf-8")

describe("bloque <contexto-vigente>", () => {
  test("sin nada que decir no hay bloque", () => {
    expect(construirBloque(vacio)).toBeUndefined()
    expect(construirBloque({ ...vacio, tareas: [{ status: "pending", content: "   " }] })).toBeUndefined()
  })

  test("tareas, habilidad, instrucción de carpeta, ayudante y gancho, en ese orden y con etiquetas de cifras", () => {
    const b = construirBloque({
      ...vacio,
      tareas: [
        { status: "in_progress", content: "Migrar la tabla" },
        { status: "pending", content: "Escribir pruebas" },
      ],
      habilidades: [{ nombre: "deploy", contenido: "Pasos de deploy" }],
      instrucciones: [{ nombre: "sub/AGENTS.md", contenido: "Usa tabs en sub/" }],
      ayudantes: [{ id: "ses_a1", titulo: "Revisar logs", estado: "en curso" }],
      ganchos: ["[Gancho PostCompact]\nMARCADOR-123"],
    })!
    expect(b.texto.startsWith("<contexto-vigente>")).toBe(true)
    expect(b.texto.trimEnd().endsWith("</contexto-vigente>")).toBe(true)
    const orden = ["[in_progress] Migrar la tabla", "Pasos de deploy", "Usa tabs en sub/", "ses_a1", "MARCADOR-123"].map((x) => b.texto.indexOf(x))
    expect(orden.every((i) => i >= 0)).toBe(true)
    expect(orden).toEqual(orden.toSorted((a, c) => a - c))
    expect(b.etiquetas).toEqual(["plan:2", "habilidades:1", "instrucciones:1", "ayudantes:1", "gancho:1"])
    // Las etiquetas son solo cifras: nunca el contenido.
    expect(b.etiquetas.join(" ")).not.toContain("deploy")
    expect(b.habilidades).toEqual(["deploy"])
    expect(b.instrucciones).toEqual(["sub/AGENTS.md"])
  })

  test("nunca pasa de 16 KB aunque el presupuesto pedido sea mayor", () => {
    const grande = "x".repeat(100_000)
    const b = construirBloque({
      ...vacio,
      presupuestoBytes: 10_000_000,
      tareas: [{ status: "pending", content: "tarea" }],
      habilidades: [{ nombre: "a", contenido: grande }, { nombre: "b", contenido: grande }],
      instrucciones: [{ nombre: "c/AGENTS.md", contenido: grande }],
      ganchos: [grande],
    })!
    expect(bytes(b.texto)).toBeLessThanOrEqual(BLOQUE_MAX_BYTES)
    expect(b.texto).toContain("[pending] tarea")
  })

  test("un documento que no cabe sale solo con su nombre y el aviso de volver a cargarla", () => {
    const b = construirBloque({
      ...vacio,
      habilidades: [
        { nombre: "corta", contenido: "contenido corto" },
        { nombre: "enorme", contenido: "y".repeat(50_000) },
      ],
    })!
    expect(b.texto).toContain("contenido corto")
    expect(b.texto).toContain("### enorme")
    expect(b.texto).toContain("vuelve a cargarla si la necesitas")
    expect(b.texto).not.toContain("yyyy")
    // El nombre sigue guardado para la compactación siguiente.
    expect(b.habilidades).toEqual(["corta", "enorme"])
  })

  test("el presupuesto sigue el 10 % de lo usable cuando es menor que 16 KB", () => {
    expect(presupuestoBloque(1_000_000)).toBe(BLOQUE_MAX_BYTES)
    expect(presupuestoBloque(10_000)).toBe(4_000)
    expect(presupuestoBloque(0)).toBe(0)
    const b = construirBloque({ ...vacio, presupuestoBytes: 600, tareas: [{ status: "pending", content: "a".repeat(2000) }] })
    expect(b === undefined || bytes(b.texto) <= 600).toBe(true)
  })

  test("recortarBytes no parte caracteres de varios bytes", () => {
    const t = "áéíóú".repeat(100)
    const r = recortarBytes(t, 101)
    expect(bytes(r)).toBeLessThanOrEqual(101)
    expect(r).not.toContain("�")
    expect(t.startsWith(r)).toBe(true)
  })
})
