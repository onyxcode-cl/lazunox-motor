// Lazunox (motor-18, J): ciclos de 2 a 5 llamadas y texto repetido. Positivos y falsos positivos.
import { describe, expect, test } from "bun:test"
import { Bucles } from "../../src/session/bucles"

const f = (tool: string, input: unknown) => Bucles.firma(tool, input)
const A = f("read", { filePath: "/p/a.ts" })
const B = f("grep", { pattern: "x" })
const C = f("bash", { command: "npm test" })

describe("ciclos de llamadas", () => {
  test("A-B repetido 4 veces (8 llamadas) es bucle; 3 veces todavía no", () => {
    expect(Bucles.ciclo([A, B, A, B, A, B, A, B])).toBe(2)
    expect(Bucles.ciclo([A, B, A, B, A, B])).toBeUndefined()
  })
  test("A-B-C repetido 3 veces es bucle; también largos 4 y 5", () => {
    expect(Bucles.ciclo([C, A, B, C, A, B, C, A, B, C])).toBe(3)
    const D = f("edit", { filePath: "/p/a.ts", oldString: "1", newString: "2" })
    const E = f("edit", { filePath: "/p/a.ts", oldString: "2", newString: "1" })
    expect(Bucles.ciclo([A, B, C, D, A, B, C, D, A, B, C, D])).toBe(4)
    expect(Bucles.ciclo([A, B, C, D, E, A, B, C, D, E, A, B, C, D, E])).toBe(5)
  })
  test("falso positivo: leer muchos archivos distintos con la misma herramienta NO es bucle", () => {
    const lecturas = Array.from({ length: 40 }, (_, i) => f("read", { filePath: `/p/archivo${i}.ts` }))
    expect(Bucles.ciclo(lecturas)).toBeUndefined()
    const alternas = Array.from({ length: 30 }, (_, i) => (i % 2 ? f("grep", { pattern: `p${i}` }) : f("read", { filePath: `/p/${i}` })))
    expect(Bucles.ciclo(alternas)).toBeUndefined()
  })
  test("falso positivo: el ciclo se rompe al final (hubo avance) o todo es idéntico (eso es del detector de siempre)", () => {
    expect(Bucles.ciclo([A, B, A, B, A, B, A, B, C])).toBeUndefined()
    expect(Bucles.ciclo([A, A, A, A, A, A, A, A, A, A])).toBeUndefined()
  })
  test("editar-probar-editar con argumentos que cambian no es bucle", () => {
    const pasos = Array.from({ length: 12 }, (_, i) => (i % 2 ? C : f("edit", { filePath: "/p/a.ts", oldString: `v${i}`, newString: `v${i + 1}` })))
    expect(Bucles.ciclo(pasos)).toBeUndefined()
  })
  test("se puede apagar", () => {
    expect(Bucles.activo({ LAZUNOX_BUCLES_AMPLIADOS: "0" })).toBe(false)
    expect(Bucles.activo({})).toBe(true)
  })
})

describe("texto repetido", () => {
  test("la misma frase una y otra vez es bucle", () => {
    const frase = "Voy a revisar el archivo de configuración para entender el problema. "
    expect(Bucles.textoRepetido("Empiezo. " + frase.repeat(12))).toBe(true)
  })
  test("pocas repeticiones o texto variado no es bucle", () => {
    const frase = "Voy a revisar el archivo de configuración para entender el problema. "
    expect(Bucles.textoRepetido(frase.repeat(4))).toBe(false)
    const variado = Array.from({ length: 80 }, (_, i) => `El paso ${i} revisa la función número ${i * 7} y anota lo que encontró.`).join(" ")
    expect(Bucles.textoRepetido(variado)).toBe(false)
  })
  test("falsos positivos: tablas, listas, código, separadores repetidos no cuentan", () => {
    const tabla = "| Columna | Valor |\n|---|---|\n" + "| dato repetido igual en cada fila de la tabla | 1 |\n".repeat(40)
    expect(Bucles.textoRepetido(tabla)).toBe(false)
    const lista = "- elemento de la lista que se repite igual muchas veces seguidas\n".repeat(40)
    expect(Bucles.textoRepetido(lista)).toBe(false)
    const codigo = "```ts\n" + "console.log('linea repetida dentro de un bloque de código');\n".repeat(40) + "```\n"
    expect(Bucles.textoRepetido(codigo)).toBe(false)
    expect(Bucles.textoRepetido("=".repeat(3000))).toBe(false)
  })
})
