import { describe, expect, test } from "bun:test"
import { limiteSubagentes, topeAlcanzado } from "../../src/tool/task"

const env = (v?: string) => ({ ...(v === undefined ? {} : { LAZUNOX_MAX_SUBAGENTS: v }) }) as NodeJS.ProcessEnv

describe("tope de ayudantes en segundo plano", () => {
  test("por defecto 8; respeta el valor válido y acota", () => {
    expect(limiteSubagentes(env())).toBe(8)
    expect(limiteSubagentes(env("3"))).toBe(3)
    expect(limiteSubagentes(env("0"))).toBe(8)
    expect(limiteSubagentes(env("-5"))).toBe(1)
    expect(limiteSubagentes(env("1000"))).toBe(64)
    expect(limiteSubagentes(env("abc"))).toBe(8)
  })
  test("se alcanza al llegar al máximo, no antes", () => {
    expect(topeAlcanzado(7, 8)).toBe(false)
    expect(topeAlcanzado(8, 8)).toBe(true)
    expect(topeAlcanzado(9, 8)).toBe(true)
  })
})
