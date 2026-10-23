import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { CodeMode, Tool } from "../src/index.js"

// Lazunox: qué pasa con el trabajo cuando un script de Code Mode llega a un límite.
// Regla que garantizamos: lo que ya se ejecutó NO se deshace; solo se pierde lo que el script tenía en memoria.

const makeHost = (done: Array<number>) => ({
  host: {
    step: Tool.make({
      description: "Hace un paso con efecto",
      input: Schema.Struct({ id: Schema.Number }),
      output: Schema.Number,
      run: ({ id }) =>
        Effect.sync(() => {
          done.push(id)
          return id
        }),
    }),
  },
})

const run = (code: string, limits: { maxToolCalls?: number; timeoutMs?: number }, done: Array<number>) =>
  Effect.runPromise(CodeMode.make({ tools: makeHost(done), limits }).execute(code))

describe("límites de Code Mode", () => {
  test("al llegar al tope de llamadas, las ya hechas se conservan y el error lo dice", async () => {
    const done: Array<number> = []
    const r = await run(
      `console.log("empiezo"); const out = []; for (let i = 1; i <= 5; i++) { out.push(await tools.host.step({ id: i })) } return out`,
      { maxToolCalls: 3 },
      done,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("ToolCallLimitExceeded")
    expect(done).toEqual([1, 2, 3])
    expect(r.logs).toEqual(["empiezo"])
  })

  test("el script puede atrapar el límite y devolver lo parcial", async () => {
    const done: Array<number> = []
    const r = await run(
      `const out = []; try { for (let i = 1; i <= 5; i++) { out.push(await tools.host.step({ id: i })) } } catch (e) { return { parcial: out, motivo: String(e && e.message) } } return { completo: out }`,
      { maxToolCalls: 3 },
      done,
    )
    console.log("resultado atrapado:", JSON.stringify(r).slice(0, 300))
    expect(done).toEqual([1, 2, 3])
  })

  test("sin llegar al límite todo sale completo", async () => {
    const done: Array<number> = []
    const r = await run(`return [await tools.host.step({ id: 1 }), await tools.host.step({ id: 2 })]`, { maxToolCalls: 3 }, done)
    expect(r.ok).toBe(true)
    expect(done).toEqual([1, 2])
  })
})
