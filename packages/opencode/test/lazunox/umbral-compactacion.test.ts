import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Config } from "@/config/config"
import { SessionCompaction } from "../../src/session/compaction"
import {
  PASOS_MINIMOS_TRAS_RESUMEN,
  UMBRAL_MINIMO,
  anticipadoPermitido,
  interpretarUmbral,
  isOverflow,
  olvidarPrefijos,
  prefijoDeSesion,
  preservarPorModelo,
  resolverUmbral,
  usable,
} from "../../src/session/overflow"
import { TestConfig } from "../fixture/config"
import { createModel, itCompaction, llm, withCompaction } from "./compactacion-util"

// Paquete 6.2: umbral de compactación anticipado (H1) y valores por modelo (H2).
// Reglas: apagado por defecto, SOLO de la configuración global, mínimo 16 000, nunca sobre lo usable, sin bucles.

const base = Schema.decodeUnknownSync(ConfigV1.Info)({}) as ConfigV1.Info
const conf = (compaction: ConfigV1.Info["compaction"]) => ({ ...base, compaction }) as ConfigV1.Info
const model = createModel({ context: 100_000, output: 32_000 }) // usable = 68 000
const tok = (input: number, extra: Partial<SessionV1.Assistant["tokens"]> = {}) =>
  ({ input, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, ...extra }) as SessionV1.Assistant["tokens"]

afterEach(() => olvidarPrefijos())

describe("interpretarUmbral", () => {
  test("entero, porcentaje de lo usable, mínimo y techo", () => {
    expect(interpretarUmbral(40_000, 68_000)).toBe(40_000)
    expect(interpretarUmbral("50%", 68_000)).toBe(34_000)
    expect(interpretarUmbral(" 100% ", 68_000)).toBe(68_000)
    expect(interpretarUmbral("20%", 68_000)).toBe(UMBRAL_MINIMO) // 13 600 sube al mínimo
    expect(interpretarUmbral(1_000, 68_000)).toBe(UMBRAL_MINIMO)
    expect(interpretarUmbral(500_000, 68_000)).toBe(68_000) // nunca sobre lo usable
    expect(interpretarUmbral("30000", 68_000)).toBe(30_000)
  })
  test("valores no válidos se ignoran (apagado), nunca lanzan", () => {
    for (const v of ["0%", "101%", "abc", "-5", "5.5%", "", 0, -3, NaN, Infinity, null, {}, [], "1e9"])
      expect(interpretarUmbral(v, 68_000)).toBeUndefined()
    expect(interpretarUmbral(40_000, 0)).toBeUndefined()
  })
})

describe("resolverUmbral (global + por modelo)", () => {
  const u = usable({ cfg: base, model })
  test("sin configurar: apagado", () => {
    expect(u).toBe(68_000)
    expect(resolverUmbral({ global: undefined, model, usable: u })).toBeUndefined()
    expect(resolverUmbral({ global: base, model, usable: u })).toBeUndefined()
    expect(resolverUmbral({ global: conf({ auto: true }), model, usable: u })).toBeUndefined()
  })
  test("global entero o porcentaje", () => {
    expect(resolverUmbral({ global: conf({ umbral: 30_000 }), model, usable: u })).toBe(30_000)
    expect(resolverUmbral({ global: conf({ umbral: "50%" }), model, usable: u })).toBe(34_000)
  })
  test("por_modelo gana al global y solo aplica al modelo con esa clave", () => {
    const g = conf({ umbral: 30_000, por_modelo: { "test/test-model": { umbral: "75%", preserve_recent_tokens: 5_000 }, "otro/m": { umbral: 20_000 } } })
    expect(resolverUmbral({ global: g, model, usable: u })).toBe(51_000)
    expect(preservarPorModelo(g, model)).toBe(5_000)
    const otro = { id: "x", providerID: "test" } as never
    expect(resolverUmbral({ global: g, model: otro, usable: u })).toBe(30_000)
    expect(preservarPorModelo(g, otro)).toBeUndefined()
  })
  test("por_modelo sin umbral hereda el global; claves como __proto__ no se cuelan", () => {
    const g = conf({ umbral: 30_000, por_modelo: { "test/test-model": { preserve_recent_tokens: 1 } } })
    expect(resolverUmbral({ global: g, model, usable: u })).toBe(30_000)
    const proto = { id: "__proto__", providerID: "" } as never
    expect(resolverUmbral({ global: conf({ por_modelo: {} }), model: proto, usable: u })).toBeUndefined()
    expect(preservarPorModelo(conf({ por_modelo: {} }), { id: "constructor", providerID: "" } as never)).toBeUndefined()
  })
  test("el esquema acepta la configuración y rechaza tipos erróneos", () => {
    const ok = Schema.decodeUnknownSync(ConfigV1.Info)({ compaction: { umbral: "60%", por_modelo: { "a/b": { umbral: 20_000 } } } })
    expect(ok.compaction?.umbral).toBe("60%")
    expect(() => Schema.decodeUnknownSync(ConfigV1.Info)({ compaction: { umbral: true } })).toThrow()
  })
})

describe("isOverflow con umbral", () => {
  test("sin umbral no cambia nada", () => {
    expect(isOverflow({ cfg: base, tokens: tok(67_999), model })).toBe(false)
    expect(isOverflow({ cfg: base, tokens: tok(68_000), model })).toBe(true)
  })
  test("compacta al cruzar el umbral y no antes", () => {
    expect(isOverflow({ cfg: base, tokens: tok(29_999), model, umbral: 30_000 })).toBe(false)
    expect(isOverflow({ cfg: base, tokens: tok(30_000), model, umbral: 30_000 })).toBe(true)
  })
  test("el prefijo fijo no cuenta (body_after_prefix)", () => {
    expect(isOverflow({ cfg: base, tokens: tok(40_000), model, umbral: 30_000, prefijo: 15_000 })).toBe(false)
    expect(isOverflow({ cfg: base, tokens: tok(45_000), model, umbral: 30_000, prefijo: 15_000 })).toBe(true)
  })
  test("auto:false lo apaga todo y el desbordamiento real sigue mandando", () => {
    expect(isOverflow({ cfg: conf({ auto: false }), tokens: tok(60_000), model, umbral: 30_000 })).toBe(false)
    expect(isOverflow({ cfg: base, tokens: tok(70_000), model, umbral: 30_000, prefijo: 60_000 })).toBe(true)
  })
})

// --- mensajes a mano para el tope contra bucles -------------------------------------------------------------------
const asistente = (id: string, entrada: number, opts: { summary?: boolean } = {}) =>
  ({
    info: {
      id,
      role: "assistant",
      sessionID: "ses_x",
      summary: opts.summary,
      finish: "stop",
      tokens: tok(entrada),
    },
    parts: [],
  }) as never
const usuario = (id: string) => ({ info: { id, role: "user", sessionID: "ses_x" }, parts: [] }) as never

describe("tope contra bucles de compactación", () => {
  test("sin resumen previo se permite", () => {
    expect(anticipadoPermitido({ msgs: [usuario("u1"), asistente("a1", 35_000)], umbral: 30_000, prefijo: 0 })).toEqual({ permitido: true })
  })
  test(`tras un resumen exige ${PASOS_MINIMOS_TRAS_RESUMEN} pasos nuevos`, () => {
    const r = asistente("s", 90_000, { summary: true })
    const uno = anticipadoPermitido({ msgs: [r, usuario("u2"), asistente("a2", 20_000)], umbral: 30_000, prefijo: 0 })
    expect(uno.permitido).toBe(false)
    const dos = anticipadoPermitido({ msgs: [r, usuario("u2"), asistente("a2", 20_000), asistente("a3", 31_000)], umbral: 30_000, prefijo: 0 })
    expect(dos).toEqual({ permitido: true })
  })
  test("si el resumen y la cola ya superan el umbral, no se compacta (compactar no ayuda)", () => {
    const r = asistente("s", 90_000, { summary: true })
    const res = anticipadoPermitido({ msgs: [r, asistente("a2", 35_000), asistente("a3", 36_000)], umbral: 30_000, prefijo: 0 })
    expect(res.permitido).toBe(false)
    // con prefijo grande, el cuerpo sí cabe
    expect(anticipadoPermitido({ msgs: [r, asistente("a2", 35_000), asistente("a3", 36_000)], umbral: 30_000, prefijo: 10_000 })).toEqual({ permitido: true })
  })
  test("simulación: un umbral mínimo no produce más compactaciones que una cada 2 pasos", () => {
    // Cada paso informa 40 000 (siempre por encima del umbral de 16 000) y cada compactación deja resumen + cola de 1 paso.
    let msgs: unknown[] = [usuario("u")]
    let compactaciones = 0
    const pasos = 20
    for (let i = 0; i < pasos; i++) {
      const ultimo = [...msgs].reverse().find((m) => (m as { info: { role: string; summary?: boolean } }).info.role === "assistant") as
        | { info: { tokens: SessionV1.Assistant["tokens"] } }
        | undefined
      const dispara =
        ultimo !== undefined &&
        isOverflow({ cfg: base, tokens: ultimo.info.tokens, model, umbral: UMBRAL_MINIMO, prefijo: 0 }) &&
        anticipadoPermitido({ msgs: msgs as never, umbral: UMBRAL_MINIMO, prefijo: 0 }).permitido
      if (dispara) {
        compactaciones++
        msgs = [asistente(`s${i}`, 40_000, { summary: true })]
      }
      msgs.push(asistente(`a${i}`, 40_000))
    }
    // Tras cada resumen el primer paso ya supera el umbral: el tope lo corta y solo queda el desbordamiento real.
    expect(compactaciones).toBeLessThanOrEqual(1)
  })
})

describe("prefijoDeSesion", () => {
  test("recuerda lo que envió la primera petición y no lo cambia después", () => {
    const m1 = [usuario("u1"), asistente("a1", 12_000)]
    expect(prefijoDeSesion("ses_p", m1)).toBe(12_000)
    expect(prefijoDeSesion("ses_p", [...m1, asistente("a2", 50_000)])).toBe(12_000)
  })
  test("tras un resumen sin medida previa vale 0 (lo más conservador)", () => {
    expect(prefijoDeSesion("ses_q", [asistente("s", 90_000, { summary: true }), asistente("a2", 20_000)])).toBe(0)
  })
})

// --- integración con el servicio de compactación y la configuración -----------------------------------------------
const configuracion = (proyecto: ConfigV1.Info["compaction"], global: ConfigV1.Info["compaction"]) =>
  Layer.succeed(Config.Service, TestConfig.make({ get: () => Effect.succeed(conf(proyecto)), getGlobal: () => Effect.succeed(conf(global)) }))

describe("SessionCompaction.isOverflow: configuración global, no la del proyecto", () => {
  const msgs = [usuario("u1"), asistente("a1", 10_000), asistente("a2", 40_000)]
  const pregunta = (tokens: number, conMensajes = true) =>
    SessionCompaction.use.isOverflow({
      tokens: tok(tokens),
      model,
      ...(conMensajes ? { sessionID: "ses_int" as never, messages: msgs } : {}),
    })

  itCompaction.instance("global con umbral: compacta al cruzarlo (menos el prefijo medido de 10 000) y no antes", () =>
    Effect.gen(function* () {
      expect(yield* pregunta(39_999)).toBe(false)
      expect(yield* pregunta(40_000)).toBe(true)
    }).pipe(withCompaction({ llm: llm().llmLayer, config: configuracion(undefined, { umbral: 30_000 }) })),
  )

  itCompaction.instance("el umbral del PROYECTO se ignora (repo hostil con umbral 16000 no fuerza compactaciones)", () =>
    Effect.gen(function* () {
      expect(yield* pregunta(50_000)).toBe(false)
    }).pipe(withCompaction({ llm: llm().llmLayer, config: configuracion({ umbral: UMBRAL_MINIMO, por_modelo: { "test/test-model": { umbral: UMBRAL_MINIMO } } }, undefined) })),
  )

  itCompaction.instance("un umbral alto del proyecto tampoco desactiva el global", () =>
    Effect.gen(function* () {
      expect(yield* pregunta(45_000)).toBe(true)
    }).pipe(withCompaction({ llm: llm().llmLayer, config: configuracion({ umbral: "100%" }, { umbral: 30_000 }) })),
  )

  itCompaction.instance("por_modelo global gana al global", () =>
    Effect.gen(function* () {
      expect(yield* pregunta(45_000)).toBe(false) // 45 000 - 10 000 = 35 000 < 50 000
      expect(yield* pregunta(61_000)).toBe(true)
    }).pipe(withCompaction({ llm: llm().llmLayer, config: configuracion(undefined, { umbral: 30_000, por_modelo: { "test/test-model": { umbral: 50_000 } } }) })),
  )

  itCompaction.instance("sin mensajes (llamada antigua) y sin configuración: comportamiento de siempre", () =>
    Effect.gen(function* () {
      expect(yield* pregunta(50_000, false)).toBe(false)
      expect(yield* pregunta(68_000, false)).toBe(true)
    }).pipe(withCompaction({ llm: llm().llmLayer, config: configuracion(undefined, { umbral: 30_000 }) })),
  )

  itCompaction.instance("auto:false apaga también el umbral", () =>
    Effect.gen(function* () {
      expect(yield* pregunta(60_000)).toBe(false)
    }).pipe(withCompaction({ llm: llm().llmLayer, config: configuracion({ auto: false }, { umbral: 30_000 }) })),
  )
})
