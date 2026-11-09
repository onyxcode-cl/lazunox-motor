import { describe, expect, test } from "bun:test"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { descripcionMcp, esquemaCompacto, parametrosCortos, TOPE_DESCRIPCION_MCP } from "../../src/tool/esquema-compacto"
import { descripcionAyudante } from "../../src/agent/descripciones-cortas"
import { ToolJsonSchema } from "../../src/tool/json-schema"
import { Parameters as TaskParameters } from "../../src/tool/task"
import { Parameters as SkillParameters } from "../../src/tool/skill"
import { AhorroTokens } from "../../src/tool/ahorro-tokens"

const OFF = { LAZUNOX_AHORRO_TOKENS: "0" }
const SEGURO = Number.MAX_SAFE_INTEGER

describe("C4: esquemas sin ruido", () => {
  const esquema: JSONSchema7 = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      offset: { type: "integer", minimum: -SEGURO, maximum: SEGURO, description: "x" },
      timeout: { type: "integer", exclusiveMinimum: 0, minimum: -SEGURO, maximum: SEGURO },
      edad: { type: "integer", minimum: 0, maximum: 120 },
      minimum: { type: "string" },
    },
    required: ["offset"],
  }
  test("quita $schema y los límites de entero seguro, y solo eso", () => {
    const r = esquemaCompacto(esquema, {})
    expect(r.$schema).toBeUndefined()
    expect(r.properties!.offset).toEqual({ type: "integer", description: "x" })
    expect(r.properties!.timeout).toEqual({ type: "integer", exclusiveMinimum: 0 })
    expect(r.properties!.edad).toEqual({ type: "integer", minimum: 0, maximum: 120 })
    expect(r.properties!.minimum).toEqual({ type: "string" }) // una propiedad llamada «minimum» no es un límite
    expect(r.required).toEqual(["offset"])
  })
  test("no muta la entrada y se apaga con LAZUNOX_AHORRO_TOKENS=0", () => {
    esquemaCompacto(esquema, {})
    expect(esquema.$schema).toBeDefined()
    expect((esquema.properties!.offset as any).minimum).toBe(-SEGURO)
    expect(esquemaCompacto(esquema, OFF)).toBe(esquema)
    expect(esquemaCompacto(esquema, { LAZUNOX_AHORRO_TOKENS: "bash" })).toBe(esquema)
    expect(esquemaCompacto(esquema, { LAZUNOX_AHORRO_TOKENS: "esquemas" }).$schema).toBeUndefined()
  })
})

describe("C4: descripciones de MCP acotadas", () => {
  test("una descripción normal no cambia", () => {
    const t = "Crea un ticket.\nDevuelve su id."
    expect(descripcionMcp(t, {})).toBe(t)
    expect(descripcionMcp("a".repeat(TOPE_DESCRIPCION_MCP), {})).toHaveLength(TOPE_DESCRIPCION_MCP)
  })
  test("una descripción enorme se corta en un límite de línea y lleva […]", () => {
    const t = Array.from({ length: 200 }, (_, i) => `Línea número ${i} con texto de relleno.`).join("\n")
    const r = descripcionMcp(t, {})
    expect(r.length).toBeLessThanOrEqual(TOPE_DESCRIPCION_MCP + 4)
    expect(r.endsWith(" […]")).toBe(true)
    expect(t.startsWith(r.slice(0, -4))).toBe(true)
    expect(r.slice(0, -4).endsWith("relleno.")).toBe(true) // cortó entre líneas
  })
  test("sin límite de línea corta por caracteres y no parte un emoji", () => {
    const t = "😀".repeat(1000)
    const r = descripcionMcp(t, {})
    expect(r.endsWith(" […]")).toBe(true)
    expect(r.includes("�")).toBe(false)
    expect(/[\uD800-\uDBFF]\s*…/.test(r)).toBe(false)
  })
  test("apagado: queda entera", () => {
    const t = "z".repeat(5000)
    expect(descripcionMcp(t, OFF)).toBe(t)
    expect(descripcionMcp(t, { LAZUNOX_AHORRO_TOKENS: "mcp" }).length).toBeLessThan(1300)
  })
})

describe("C4: descripciones de parámetros más cortas", () => {
  test("task: sin `command` para el modelo (ni en required), `task_id` corto, el resto igual", () => {
    const base = ToolJsonSchema.fromSchema(TaskParameters as any)
    expect(Object.keys(base.properties!)).toContain("command")
    const r = parametrosCortos("task", base, {})
    expect(Object.keys(r.properties!)).not.toContain("command")
    expect(Object.keys(r.properties!)).toEqual(Object.keys(base.properties!).filter((k) => k !== "command"))
    expect(r.required).toEqual(base.required)
    expect((r.properties!.task_id as any).description.length).toBeLessThan((base.properties!.task_id as any).description.length)
    expect(r.properties!.description).toEqual(base.properties!.description) // «3-5 words» se conserva
    expect(Object.keys(base.properties!)).toContain("command") // la entrada no se tocó
  })
  test("skill: `args` conserva que es para skills con context: fork", () => {
    const r = parametrosCortos("skill", ToolJsonSchema.fromSchema(SkillParameters as any), {})
    expect((r.properties!.args as any).description).toContain("context: fork")
  })
  test("todowrite: baja por items y quita lo que repite la descripción; no toca nombres ni required", () => {
    const base: JSONSchema7 = {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The updated todo list",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "Brief description of the task" },
              status: { type: "string", description: "Current status of the task: pending, in_progress, completed, cancelled" },
              verificar: { type: "string", description: 'Optional. "$ cmd" runs a shell command when marked completed; other text is a note.' },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    }
    const r = parametrosCortos("todowrite", base, {}) as any
    const items = r.properties.todos.items
    expect(Object.keys(items.properties)).toEqual(["content", "status", "verificar"])
    expect(items.required).toEqual(["content", "status"])
    expect(items.properties.status.description).toBe("pending, in_progress, completed, cancelled")
    expect(items.properties.content.description).toBeUndefined()
    expect(items.properties.verificar.description).toBeUndefined()
    expect(r.properties.todos.description).toBeUndefined()
    expect(r.required).toEqual(["todos"])
    expect((base.properties!.todos as any).items.properties.content.description).toBeDefined() // sin mutar
  })
  test("si la descripción ya no es la original, no se toca; herramientas sin reglas, tampoco; apagado, tampoco", () => {
    const base: JSONSchema7 = { type: "object", properties: { path: { type: "string", description: "Mi texto propio" } } }
    expect(parametrosCortos("glob", base, {})).toBe(base)
    expect(parametrosCortos("otra", base, {})).toBe(base)
    const orig: JSONSchema7 = {
      type: "object",
      properties: { path: { type: "string", description: 'The directory to search in. If not specified, the current working directory will be used. IMPORTANT: …' } },
    }
    expect(parametrosCortos("glob", orig, OFF)).toBe(orig)
    expect(parametrosCortos("glob", orig, {})).not.toBe(orig)
  })
})

describe("C4: descripciones de los ayudantes nativos", () => {
  const original = `Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx").`
  test("el nativo con su texto original usa el corto", () => {
    const d = descripcionAyudante({ name: "explore", description: original, native: true }, {})!
    expect(d.length).toBeLessThan(original.length + 80)
    expect(d).toContain("thoroughness")
  })
  test("un texto cambiado por la persona, un agente propio o el interruptor apagado se respetan", () => {
    expect(descripcionAyudante({ name: "explore", description: "Mi explorador", native: true }, {})).toBe("Mi explorador")
    expect(descripcionAyudante({ name: "explore", description: original }, {})).toBe(original)
    expect(descripcionAyudante({ name: "explore", description: original, native: true }, OFF)).toBe(original)
    expect(descripcionAyudante({ name: "x", native: true }, {})).toBeUndefined()
  })
})

describe("C4: los recortes nuevos son parte de LAZUNOX_AHORRO_TOKENS", () => {
  test("esquemas, mcp y agentes están en la lista; se pueden encender solos", () => {
    for (const r of ["esquemas", "mcp", "agentes"]) expect(AhorroTokens.RECORTES as readonly string[]).toContain(r)
    expect([...AhorroTokens.recortesActivos({ LAZUNOX_AHORRO_TOKENS: "mcp,agentes" })].sort()).toEqual(["agentes", "mcp"])
  })
})
