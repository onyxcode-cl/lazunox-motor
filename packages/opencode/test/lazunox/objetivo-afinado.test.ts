// Ola 7, 7.14: objetivo y revisor afinados con lo de Codex (solo texto de prompts y un tope). `LAZUNOX_OBJETIVO_AFINADO=0` = lo de antes.
import { afterEach, describe, expect, test } from "bun:test"
import * as Objetivo from "../../src/session/objetivo"
import { afinado, promptRevisor, REGLAS_REVISOR_AFINADAS } from "../../src/agent/revisor-afinado"
import PROMPT_REVISOR from "../../src/agent/prompt/revisor.txt"

afterEach(() => {
  delete process.env.LAZUNOX_OBJETIVO_AFINADO
})

const datos = { info: { condicion: "que pasen las pruebas", verificar: undefined, tope: 10, iteraciones: 2 } }

describe("7.14 objetivo", () => {
  test("la continuación añade la auditoría de cierre; apagado, queda como antes", () => {
    const nuevo = Objetivo.plantillaContinuacion(datos)
    expect(nuevo).toContain("Auditoría de cierre")
    expect(nuevo).toContain("evidencia debe ser de AHORA")
    expect(nuevo).toContain("agotado los intentos")
    // lo que ya existía sigue
    expect(nuevo).toContain("Descompón el objetivo en requisitos")
    expect(nuevo).toContain("«Creo que sí» o «debería funcionar» no es evidencia")
    process.env.LAZUNOX_OBJETIVO_AFINADO = "0"
    const viejo = Objetivo.plantillaContinuacion(datos)
    expect(viejo).not.toContain("Auditoría de cierre")
    expect(nuevo.startsWith(viejo.split("\n").slice(0, -1).join("\n").slice(0, 200))).toBe(true)
    expect(nuevo.length).toBeGreaterThan(viejo.length)
  })
  test("el juez sigue contestando con UNA palabra y recibe la regla de la evidencia dudosa", () => {
    const nuevo = Objetivo.promptJuez()
    expect(nuevo).toContain("Responde con UNA sola palabra en la primera línea")
    expect(nuevo).toContain("cuenta como NO lograda (SIGUE)")
    expect(nuevo).toContain("«lo intenté»")
    process.env.LAZUNOX_OBJETIVO_AFINADO = "0"
    expect(Objetivo.promptJuez()).not.toContain("lo intenté")
  })
  test("la lectura del veredicto no cambia (estricta)", () => {
    expect(Objetivo.leerVeredicto("CUMPLIDO")).toBe("cumplido")
    expect(Objetivo.leerVeredicto("Creo que CUMPLIDO")).toBe("sigue")
    expect(Objetivo.leerVeredicto("IMPOSIBLE: razón")).toBe("sigue")
  })
  test("la condición admite hasta 4000 caracteres (como Codex) y no más", () => {
    expect(Objetivo.MAX_CONDICION).toBe(4000)
    const ok = Objetivo.crear("ses_a", { condicion: "x".repeat(4000) }, "msg_1")
    expect(ok.condicion.length).toBe(4000)
    expect(() => Objetivo.crear("ses_b", { condicion: "x".repeat(4001) }, "msg_1")).toThrow("4000")
    Objetivo.reiniciarParaPruebas()
  })
  test("«bloqueado» sigue siendo tras 3 turnos seguidos sin avance", () => {
    expect(Objetivo.textoFinal("bloqueado", { condicion: "x", tope: 10, iteraciones: 3 })).toContain("3 turnos seguidos sin avance")
  })
})

describe("7.14 revisor", () => {
  test("las reglas van antes del formato de salida, que sigue siendo lo último", () => {
    const nuevo = promptRevisor(PROMPT_REVISOR)
    expect(nuevo).toContain("Qué merece ser un hallazgo")
    expect(nuevo).toContain(REGLAS_REVISOR_AFINADAS)
    expect(nuevo.indexOf("Qué merece ser un hallazgo")).toBeLessThan(nuevo.indexOf("Formato de la respuesta final"))
    expect(nuevo.endsWith(PROMPT_REVISOR.slice(PROMPT_REVISOR.indexOf("Formato de la respuesta final")))).toBe(true)
    // lo anterior se conserva entero
    for (const trozo of ["Solo lectura.", "Rúbrica de prioridad", "findings", "git diff --no-ext-diff"]) expect(nuevo).toContain(trozo)
  })
  test("apagado devuelve el prompt de antes, idéntico", () => {
    expect(promptRevisor(PROMPT_REVISOR, { LAZUNOX_OBJETIVO_AFINADO: "0" })).toBe(PROMPT_REVISOR)
    expect(afinado({})).toBe(true)
  })
  test("sin marca de formato las reglas se añaden al final", () => {
    expect(promptRevisor("base").endsWith(REGLAS_REVISOR_AFINADAS + "\n")).toBe(true)
  })
})
