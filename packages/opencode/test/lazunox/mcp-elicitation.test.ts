import { afterEach, describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Fiber } from "effect"
import { McpElicitation } from "../../src/mcp/elicitation"
import {
  detectarSecreto,
  elicitacionActiva,
  tiempoMaximoMs,
  validarEsquema,
  validarMensaje,
  validarRespuesta,
  TOPES,
  type Campo,
} from "../../src/mcp/elicitation-esquema"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { SessionID } from "../../src/session/schema"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { McpEvent } from "@opencode-ai/schema/mcp-event"
import { EventManifest as SchemaEventManifest } from "@opencode-ai/schema/event-manifest"

const props = (p: Record<string, unknown>, required?: string[]) => ({
  type: "object",
  properties: p,
  ...(required ? { required } : {}),
})

// ---------------------------------------------------------------------------------------------------------------------
// Funciones puras
// ---------------------------------------------------------------------------------------------------------------------

describe("esquema pedido por el servidor", () => {
  test("acepta los tipos permitidos y los normaliza", () => {
    const r = validarEsquema(
      props(
        {
          nombre: { type: "string", title: "Nombre", description: "Tu nombre", minLength: 1, maxLength: 50 },
          correo: { type: "string", format: "email" },
          web: { type: "string", format: "uri" },
          dia: { type: "string", format: "date" },
          cuando: { type: "string", format: "date-time" },
          edad: { type: "integer", minimum: 0, maximum: 120, default: 30 },
          precio: { type: "number", minimum: 0.5 },
          acepto: { type: "boolean", default: true },
          color: { type: "string", enum: ["r", "g"], enumNames: ["Rojo", "Verde"] },
          talla: { type: "string", oneOf: [{ const: "s", title: "Chica" }, { const: "l" }], default: "s" },
        },
        ["nombre", "edad"],
      ),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const por = Object.fromEntries(r.campos.map((c) => [c.name, c]))
    expect(r.campos).toHaveLength(10)
    expect(por.nombre).toMatchObject({ type: "string", required: true, minLength: 1, maxLength: 50 })
    expect(por.correo).toMatchObject({ type: "string", format: "email", required: false, maxLength: TOPES.maxLongitudTexto })
    expect(por.edad).toMatchObject({ type: "integer", required: true, minimum: 0, maximum: 120, default: 30 })
    expect(por.acepto).toMatchObject({ type: "boolean", default: true })
    expect(por.color).toMatchObject({ type: "enum", options: [{ value: "r", label: "Rojo" }, { value: "g", label: "Verde" }] })
    expect(por.talla).toMatchObject({ type: "enum", default: "s", options: [{ value: "s", label: "Chica" }, { value: "l", label: "l" }] })
  })

  test("acepta un formulario sin campos", () => {
    expect(validarEsquema(props({}))).toEqual({ ok: true, campos: [] })
  })

  const rechazados: Array<[string, unknown]> = [
    ["no es objeto", "hola"],
    ["type no es object", { type: "array", properties: {} }],
    ["sin properties", { type: "object" }],
    ["required mal formado", props({ a: { type: "string" } }, [1 as unknown as string])],
    ["campo anidado (object)", props({ a: { type: "object", properties: {} } })],
    ["arreglo (selección múltiple)", props({ a: { type: "array", items: { type: "string" } } })],
    ["tipo desconocido", props({ a: { type: "null" } })],
    ["sin tipo", props({ a: {} })],
    ["definición no es objeto", props({ a: "string" })],
    ["nombre prohibido", { type: "object", properties: JSON.parse('{"__proto__":{"type":"string"}}') }],
    ["nombre vacío", props({ "": { type: "string" } })],
    ["nombre largo", props({ ["x".repeat(TOPES.nombreCampo + 1)]: { type: "string" } })],
    ["format desconocido", props({ a: { type: "string", format: "hostname" } })],
    ["minLength > maxLength", props({ a: { type: "string", minLength: 5, maxLength: 2 } })],
    ["maxLength sobre el tope", props({ a: { type: "string", maxLength: TOPES.maxLongitudTexto + 1 } })],
    ["minLength negativo", props({ a: { type: "string", minLength: -1 } })],
    ["minimum > maximum", props({ a: { type: "number", minimum: 5, maximum: 1 } })],
    ["minimum no numérico", props({ a: { type: "number", minimum: "0" } })],
    ["default entero con decimales", props({ a: { type: "integer", default: 1.5 } })],
    ["default fuera de rango", props({ a: { type: "number", maximum: 1, default: 2 } })],
    ["default booleano mal", props({ a: { type: "boolean", default: "si" } })],
    ["enum vacío", props({ a: { type: "string", enum: [] } })],
    ["enum no texto", props({ a: { type: "string", enum: [1, 2] } })],
    ["enumNames de otro largo", props({ a: { type: "string", enum: ["a", "b"], enumNames: ["A"] } })],
    ["enum repetido", props({ a: { type: "string", enum: ["a", "a"] } })],
    ["enum y oneOf juntos", props({ a: { type: "string", enum: ["a"], oneOf: [{ const: "a" }] } })],
    ["oneOf sin const", props({ a: { type: "string", oneOf: [{ title: "x" }] } })],
    ["default fuera del enum", props({ a: { type: "string", enum: ["a"], default: "b" } })],
    ["default de texto demasiado largo", props({ a: { type: "string", maxLength: 3, default: "abcdef" } })],
    ["title largo", props({ a: { type: "string", title: "t".repeat(TOPES.titulo + 1) } })],
    ["description larga", props({ a: { type: "string", description: "d".repeat(TOPES.descripcion + 1) } })],
  ]
  for (const [nombre, esquema] of rechazados) {
    test(`rechaza: ${nombre}`, () => {
      const r = validarEsquema(esquema)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.motivo).toBe("schema")
    })
  }

  test("topes: 20 campos sí, 21 no", () => {
    const n = (k: number) => Object.fromEntries(Array.from({ length: k }, (_, i) => [`c${i}`, { type: "boolean" }]))
    expect(validarEsquema(props(n(TOPES.campos))).ok).toBe(true)
    expect(validarEsquema(props(n(TOPES.campos + 1))).ok).toBe(false)
  })

  test("topes: 50 opciones sí, 51 no", () => {
    const op = (k: number) => Array.from({ length: k }, (_, i) => `o${i}`)
    expect(validarEsquema(props({ a: { type: "string", enum: op(TOPES.opciones) } })).ok).toBe(true)
    expect(validarEsquema(props({ a: { type: "string", enum: op(TOPES.opciones + 1) } })).ok).toBe(false)
  })

  test("topes: título 120 y descripción 500 caben justo", () => {
    const r = validarEsquema(
      props({ a: { type: "string", title: "t".repeat(TOPES.titulo), description: "d".repeat(TOPES.descripcion) } }),
    )
    expect(r.ok).toBe(true)
  })

  test("topes: solicitud de más de 16 KB", () => {
    const lista = () => Array.from({ length: 50 }, (_, i) => `${i}`.padEnd(120, "x"))
    const grande = props({ a: { type: "string", enum: lista() }, b: { type: "string", enum: lista() }, c: { type: "string", enum: lista() } })
    const r = validarEsquema(grande)
    expect(JSON.stringify(grande).length).toBeGreaterThan(TOPES.solicitudBytes)
    expect(r.ok).toBe(false)
  })

  test("tope del mensaje: 2000 sí, 2001 no, y debe ser texto", () => {
    expect(validarMensaje("m".repeat(TOPES.mensaje)).ok).toBe(true)
    expect(validarMensaje("m".repeat(TOPES.mensaje + 1)).ok).toBe(false)
    expect(validarMensaje(42).ok).toBe(false)
  })

  test("las claves __proto__ no contaminan nada", () => {
    validarEsquema({ type: "object", properties: JSON.parse('{"__proto__":{"type":"string"}}') })
    expect(({} as Record<string, unknown>).type).toBeUndefined()
  })
})

describe("campos secretos", () => {
  const secretos = [
    "password",
    "Password",
    "contraseña",
    "contrasena",
    "Contraseña de la cuenta",
    "user_password",
    "userPassword",
    "passcode",
    "clave",
    "clave de acceso",
    "clave_secreta",
    "token",
    "access_token",
    "accessToken",
    "api_key",
    "apiKey",
    "API key",
    "api-key",
    "secret",
    "client_secret",
    "pin",
    "PIN de tu tarjeta",
    "cvv",
    "cvc",
    "tarjeta",
    "número de tarjeta",
    "card_number",
    "credit card",
    "iban",
    "otp",
    "one-time otp",
    "2fa",
    "código de verificación",
    "codigo de verificacion",
    "verification code",
    "Introduce tu contraseña actual",
  ]
  for (const s of secretos) {
    test(`detecta «${s}» como nombre de campo`, () => {
      expect(detectarSecreto(s)).toBe(true)
      const r = validarEsquema(props({ [s]: { type: "string" } }))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.motivo).toBe("secret")
    })
  }

  test("detecta el secreto en el título, en la descripción y en format=password", () => {
    const t = validarEsquema(props({ campo1: { type: "string", title: "Tu contraseña" } }))
    const d = validarEsquema(props({ campo1: { type: "string", description: "Enter your API key here" } }))
    const f = validarEsquema(props({ campo1: { type: "string", format: "password" } }))
    for (const r of [t, d, f]) {
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.motivo).toBe("secret")
        expect(r.campo).toBe("campo1")
      }
    }
  })

  test("un campo secreto entre otros inocentes invalida todo el formulario", () => {
    const r = validarEsquema(props({ nombre: { type: "string" }, clave: { type: "string" }, edad: { type: "integer" } }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.campo).toBe("clave")
  })

  const inocentes = [
    "nombre",
    "email",
    "name",
    "title",
    "pinned",
    "shipping_address",
    "spinning",
    "dashboard",
    "palabra clave",
    "palabras_clave",
    "keyword",
    "Cupón",
    "cardinal",
    "descripción",
    "color favorito",
  ]
  for (const s of inocentes) {
    test(`no marca «${s}»`, () => {
      expect(detectarSecreto(s)).toBe(false)
    })
  }
})

describe("respuesta de la persona", () => {
  const esq = validarEsquema(
    props(
      {
        nombre: { type: "string", minLength: 2, maxLength: 10 },
        correo: { type: "string", format: "email" },
        web: { type: "string", format: "uri" },
        dia: { type: "string", format: "date" },
        cuando: { type: "string", format: "date-time" },
        edad: { type: "integer", minimum: 18, maximum: 99 },
        peso: { type: "number", minimum: 0 },
        acepto: { type: "boolean" },
        color: { type: "string", enum: ["r", "g"] },
      },
      ["nombre", "edad"],
    ),
  )
  if (!esq.ok) throw new Error("esquema de prueba inválido")
  const campos: Campo[] = esq.campos
  const bien = { nombre: "Ana", edad: 30 }

  test("acepta una respuesta válida y descarta claves extra", () => {
    const r = validarRespuesta(campos, { ...bien, correo: "a@b.cl", acepto: false, color: "g", intruso: "x", __proto__: { x: 1 } })
    expect(r).toEqual({ ok: true, content: { nombre: "Ana", edad: 30, correo: "a@b.cl", acepto: false, color: "g" } })
  })

  test("los opcionales ausentes o null se omiten", () => {
    expect(validarRespuesta(campos, { ...bien, correo: null })).toEqual({ ok: true, content: bien })
  })

  const malas: Array<[string, unknown, string]> = [
    ["falta un obligatorio", { nombre: "Ana" }, "edad"],
    ["texto vacío en obligatorio", { nombre: "", edad: 30 }, "nombre"],
    ["demasiado corto", { nombre: "A", edad: 30 }, "nombre"],
    ["demasiado largo", { nombre: "A".repeat(11), edad: 30 }, "nombre"],
    ["tipo equivocado (texto)", { nombre: 5, edad: 30 }, "nombre"],
    ["entero con decimales", { ...bien, edad: 30.5 }, "edad"],
    ["número en texto", { ...bien, edad: "30" }, "edad"],
    ["bajo el mínimo", { ...bien, edad: 17 }, "edad"],
    ["sobre el máximo", { ...bien, edad: 100 }, "edad"],
    ["NaN", { ...bien, peso: Number.NaN }, "peso"],
    ["Infinity", { ...bien, peso: Number.POSITIVE_INFINITY }, "peso"],
    ["booleano en texto", { ...bien, acepto: "true" }, "acepto"],
    ["opción fuera de enum", { ...bien, color: "azul" }, "color"],
    ["correo mal", { ...bien, correo: "no-es-correo" }, "correo"],
    ["uri mal", { ...bien, web: "no es uri" }, "web"],
    ["fecha inexistente", { ...bien, dia: "2026-02-30" }, "dia"],
    ["fecha en otro formato", { ...bien, dia: "30/01/2026" }, "dia"],
    ["fecha-hora mal", { ...bien, cuando: "ayer" }, "cuando"],
  ]
  for (const [nombre, contenido, campo] of malas) {
    test(`rechaza: ${nombre}`, () => {
      const r = validarRespuesta(campos, contenido)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.errores.map((e) => e.campo)).toContain(campo)
    })
  }

  test("formatos válidos", () => {
    const r = validarRespuesta(campos, { ...bien, web: "https://ejemplo.cl/a?b=1", dia: "2026-10-25", cuando: "2026-10-25T10:30:00Z" })
    expect(r.ok).toBe(true)
  })

  test("content que no es objeto", () => {
    expect(validarRespuesta(campos, "hola").ok).toBe(false)
    expect(validarRespuesta(campos, [1, 2]).ok).toBe(false)
  })

  test("los errores nunca llevan valores", () => {
    const r = validarRespuesta(campos, { nombre: "SECRETO-SUPER-LARGO-XYZ", edad: 1 })
    expect(JSON.stringify(r)).not.toContain("SECRETO-SUPER")
  })
})

describe("variables de entorno", () => {
  const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv
  test("LAZUNOX_MCP_ELICITATION solo con «1»", () => {
    expect(elicitacionActiva(env({}))).toBe(false)
    expect(elicitacionActiva(env({ LAZUNOX_MCP_ELICITATION: "0" }))).toBe(false)
    expect(elicitacionActiva(env({ LAZUNOX_MCP_ELICITATION: "true" }))).toBe(false)
    expect(elicitacionActiva(env({ LAZUNOX_MCP_ELICITATION: "1" }))).toBe(true)
  })
  test("LAZUNOX_ELICITATION_TIMEOUT_MS: defecto 600000, válido y acotado", () => {
    expect(tiempoMaximoMs(env({}))).toBe(600_000)
    expect(tiempoMaximoMs(env({ LAZUNOX_ELICITATION_TIMEOUT_MS: "abc" }))).toBe(600_000)
    expect(tiempoMaximoMs(env({ LAZUNOX_ELICITATION_TIMEOUT_MS: "-5" }))).toBe(600_000)
    expect(tiempoMaximoMs(env({ LAZUNOX_ELICITATION_TIMEOUT_MS: "45000" }))).toBe(45_000)
    expect(tiempoMaximoMs(env({ LAZUNOX_ELICITATION_TIMEOUT_MS: "99999999999" }))).toBe(3_600_000)
  })
})

describe("eventos del contrato", () => {
  test("los tres eventos existen con su nombre fijo y están en el inventario", () => {
    expect(McpEvent.ElicitationAsked.type).toBe("mcp.elicitation.asked")
    expect(McpEvent.ElicitationReplied.type).toBe("mcp.elicitation.replied")
    expect(McpEvent.ElicitationRejected.type).toBe("mcp.elicitation.rejected")
    const tipos = McpEvent.Definitions.map((d: { type: string }) => d.type)
    expect(tipos).toContain("mcp.elicitation.asked")
    expect(tipos).toContain("mcp.elicitation.replied")
    expect(tipos).toContain("mcp.elicitation.rejected")
    const global = SchemaEventManifest.Definitions.map((d: { type: string }) => d.type)
    for (const t of ["asked", "replied", "rejected"]) expect(global).toContain(`mcp.elicitation.${t}`)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------------------------------------------------

const layer = LayerNode.compile(LayerNode.group([McpElicitation.node, EventV2Bridge.node, CrossSpawnSpawner.node]))
const it = testEffect(layer)

afterEach(async () => {
  await disposeAllInstances()
})

const S1 = SessionID.make("ses_uno")
const S2 = SessionID.make("ses_dos")
const FORM = props({ nombre: { type: "string", title: "Nombre" }, edad: { type: "integer", minimum: 0 } }, ["nombre"])

const capturar = Effect.gen(function* () {
  const events = yield* EventV2Bridge.Service
  const log: Array<{ type: string; data: Record<string, unknown> }> = []
  const off = yield* events.listen((e) => {
    if (e.type.startsWith("mcp.elicitation.")) log.push({ type: e.type, data: e.data as Record<string, unknown> })
    return Effect.void
  })
  yield* Effect.addFinalizer(() => off)
  return log
})

const esperarPendientes = (n: number) =>
  Effect.gen(function* () {
    const svc = yield* McpElicitation.Service
    for (let i = 0; i < 400; i++) {
      const l = yield* svc.list()
      if (l.length === n) return l
      yield* Effect.sleep("5 millis")
    }
    throw new Error(`no llegaron ${n} pendientes`)
  })

const ask = (o: Partial<McpElicitation.AskInput> = {}) =>
  McpElicitation.Service.use((s) =>
    s.ask({ sessionID: S1, server: "srv", message: "¿Quién eres?", requestedSchema: FORM, timeoutMs: 5000, ...o }),
  )

const tipos = (log: Array<{ type: string }>) => log.map((e) => e.type)

it.instance(
  "preguntar publica asked con los campos y responder acepta con los valores",
  () =>
    Effect.gen(function* () {
      const log = yield* capturar
      const svc = yield* McpElicitation.Service
      const fiber = yield* ask({ callID: "call_1" }).pipe(Effect.forkScoped)
      const [p] = yield* esperarPendientes(1)
      expect(p).toMatchObject({ sessionID: S1, server: "srv", callID: "call_1", message: "¿Quién eres?" })
      expect(p.fields.map((f) => f.name)).toEqual(["nombre", "edad"])
      expect(p.expiresAt).toBeGreaterThan(Date.now())
      yield* svc.reply({ requestID: p.id, action: "accept", content: { nombre: "Ana", edad: 5, otro: "x" } })
      expect(yield* Fiber.join(fiber)).toEqual({ action: "accept", content: { nombre: "Ana", edad: 5 } })
      expect(tipos(log)).toEqual(["mcp.elicitation.asked", "mcp.elicitation.replied"])
      expect(log[1].data).toMatchObject({ id: p.id, sessionID: S1, action: "accept" })
      expect(yield* svc.list()).toHaveLength(0)
    }),
  { git: true },
)

it.instance(
  "los valores escritos no viajan en ningún evento",
  () =>
    Effect.gen(function* () {
      const log = yield* capturar
      const svc = yield* McpElicitation.Service
      const fiber = yield* ask().pipe(Effect.forkScoped)
      const [p] = yield* esperarPendientes(1)
      yield* svc.reply({ requestID: p.id, action: "accept", content: { nombre: "VALOR-PRIVADO-123" } })
      yield* Fiber.join(fiber)
      expect(JSON.stringify(log)).not.toContain("VALOR-PRIVADO-123")
    }),
  { git: true },
)

it.instance(
  "decline y cancel del usuario son respuestas (replied), no rejected",
  () =>
    Effect.gen(function* () {
      const log = yield* capturar
      const svc = yield* McpElicitation.Service
      for (const action of ["decline", "cancel"] as const) {
        const fiber = yield* ask({ server: action }).pipe(Effect.forkScoped)
        const [p] = yield* esperarPendientes(1)
        yield* svc.reply({ requestID: p.id, action })
        expect(yield* Fiber.join(fiber)).toEqual({ action })
      }
      expect(tipos(log)).toEqual([
        "mcp.elicitation.asked",
        "mcp.elicitation.replied",
        "mcp.elicitation.asked",
        "mcp.elicitation.replied",
      ])
    }),
  { git: true },
)

it.instance(
  "una respuesta inválida se rechaza sin cerrar el formulario",
  () =>
    Effect.gen(function* () {
      const log = yield* capturar
      const svc = yield* McpElicitation.Service
      const fiber = yield* ask().pipe(Effect.forkScoped)
      const [p] = yield* esperarPendientes(1)
      const err = yield* svc.reply({ requestID: p.id, action: "accept", content: { edad: -1 } }).pipe(Effect.flip)
      expect(err._tag).toBe("McpElicitation.InvalidReplyError")
      if (err._tag === "McpElicitation.InvalidReplyError")
        expect(err.errors.map((e) => e.campo).sort()).toEqual(["edad", "nombre"])
      expect(yield* svc.list()).toHaveLength(1)
      expect(tipos(log)).toEqual(["mcp.elicitation.asked"])
      yield* svc.reply({ requestID: p.id, action: "accept", content: { nombre: "Ana" } })
      expect((yield* Fiber.join(fiber)).action).toBe("accept")
    }),
  { git: true },
)

it.instance(
  "responder a un id desconocido o ya cerrado falla con NotFound",
  () =>
    Effect.gen(function* () {
      const svc = yield* McpElicitation.Service
      const err = yield* svc
        .reply({ requestID: McpElicitation.ElicitationID.ascending(), action: "decline" })
        .pipe(Effect.flip)
      expect(err._tag).toBe("McpElicitation.NotFoundError")
      const fiber = yield* ask().pipe(Effect.forkScoped)
      const [p] = yield* esperarPendientes(1)
      yield* svc.reply({ requestID: p.id, action: "decline" })
      yield* Fiber.join(fiber)
      expect((yield* svc.reply({ requestID: p.id, action: "decline" }).pipe(Effect.flip))._tag).toBe(
        "McpElicitation.NotFoundError",
      )
    }),
  { git: true },
)

it.instance(
  "tiempo agotado: contesta cancel y publica rejected/timeout",
  () =>
    Effect.gen(function* () {
      const log = yield* capturar
      const svc = yield* McpElicitation.Service
      const r = yield* ask({ timeoutMs: 40 })
      expect(r).toEqual({ action: "cancel" })
      expect(tipos(log)).toEqual(["mcp.elicitation.asked", "mcp.elicitation.rejected"])
      expect(log[1].data).toMatchObject({ reason: "timeout", sessionID: S1 })
      expect(log[1].data.id).toBe(log[0].data.id)
      expect(yield* svc.list()).toHaveLength(0)
    }),
  { git: true },
)

it.instance(
  "aborto de la llamada (señal): cancel y rejected/abort",
  () =>
    Effect.gen(function* () {
      const log = yield* capturar
      const svc = yield* McpElicitation.Service
      const ctl = new AbortController()
      const fiber = yield* ask({ callSignal: ctl.signal }).pipe(Effect.forkScoped)
      yield* esperarPendientes(1)
      ctl.abort()
      expect(yield* Fiber.join(fiber)).toEqual({ action: "cancel" })
      expect(tipos(log)).toEqual(["mcp.elicitation.asked", "mcp.elicitation.rejected"])
      expect(log[1].data.reason).toBe("abort")
      expect(yield* svc.list()).toHaveLength(0)
    }),
  { git: true },
)

it.instance(
  "señal ya abortada antes de preguntar: no se muestra y se publica rejected",
  () =>
    Effect.gen(function* () {
      const log = yield* capturar
      const ctl = new AbortController()
      ctl.abort()
      expect(yield* ask({ callSignal: ctl.signal })).toEqual({ action: "decline" })
      expect(tipos(log)).toEqual(["mcp.elicitation.rejected"])
      expect(log[0].data.reason).toBe("abort")
      const ctl2 = new AbortController()
      ctl2.abort()
      yield* ask({ serverSignal: ctl2.signal })
      expect(log[1].data.reason).toBe("server-cancel")
    }),
  { git: true },
)

it.instance(
  "cancelación del servidor: cancel y rejected/server-cancel",
  () =>
    Effect.gen(function* () {
      const log = yield* capturar
      const ctl = new AbortController()
      const fiber = yield* ask({ serverSignal: ctl.signal }).pipe(Effect.forkScoped)
      yield* esperarPendientes(1)
      ctl.abort()
      expect(yield* Fiber.join(fiber)).toEqual({ action: "cancel" })
      expect(log.map((e) => e.data.reason).filter(Boolean)).toEqual(["server-cancel"])
    }),
  { git: true },
)

it.instance(
  "fibra interrumpida: también publica rejected/abort (lo que Question no hace)",
  () =>
    Effect.gen(function* () {
      const log = yield* capturar
      const svc = yield* McpElicitation.Service
      const fiber = yield* ask().pipe(Effect.forkScoped)
      yield* esperarPendientes(1)
      yield* Fiber.interrupt(fiber)
      expect(tipos(log)).toEqual(["mcp.elicitation.asked", "mcp.elicitation.rejected"])
      expect(log[1].data.reason).toBe("abort")
      expect(yield* svc.list()).toHaveLength(0)
    }),
  { git: true },
)

it.instance(
  "cancelSession cierra solo los formularios de esa sesión, con rejected",
  () =>
    Effect.gen(function* () {
      const log = yield* capturar
      const svc = yield* McpElicitation.Service
      const f1 = yield* ask({ sessionID: S1 }).pipe(Effect.forkScoped)
      const f2 = yield* ask({ sessionID: S2 }).pipe(Effect.forkScoped)
      yield* esperarPendientes(2)
      expect(yield* svc.cancelSession(S1)).toBe(1)
      expect(yield* Fiber.join(f1)).toEqual({ action: "cancel" })
      const [resto] = yield* esperarPendientes(1)
      expect(resto.sessionID).toBe(S2)
      expect(log.filter((e) => e.type === "mcp.elicitation.rejected")).toHaveLength(1)
      yield* svc.reply({ requestID: resto.id, action: "decline" })
      yield* Fiber.join(f2)
      expect(yield* svc.cancelSession(S1)).toBe(0)
    }),
  { git: true },
)

it.instance(
  "esquema inválido: decline inmediato, sin asked y con rejected/schema",
  () =>
    Effect.gen(function* () {
      const log = yield* capturar
      const svc = yield* McpElicitation.Service
      const r = yield* ask({ requestedSchema: props({ a: { type: "array", items: { type: "string" } } }) })
      expect(r).toEqual({ action: "decline" })
      expect(tipos(log)).toEqual(["mcp.elicitation.rejected"])
      expect(log[0].data.reason).toBe("schema")
      expect(yield* svc.list()).toHaveLength(0)
      yield* ask({ message: "m".repeat(TOPES.mensaje + 1) })
      expect(log[1].data.reason).toBe("schema")
    }),
  { git: true },
)

it.instance(
  "campo secreto: decline, sin asked, rejected/secret, para cualquier servidor",
  () =>
    Effect.gen(function* () {
      const log = yield* capturar
      for (const server of ["github", "servidor-de-confianza", "otro"]) {
        const r = yield* ask({ server, requestedSchema: props({ contraseña: { type: "string" } }) })
        expect(r).toEqual({ action: "decline" })
      }
      expect(tipos(log)).toEqual(Array(3).fill("mcp.elicitation.rejected"))
      expect(log.every((e) => e.data.reason === "secret")).toBe(true)
    }),
  { git: true },
)

it.instance(
  "un solo pendiente por servidor y sesión; otro servidor u otra sesión sí",
  () =>
    Effect.gen(function* () {
      const log = yield* capturar
      const svc = yield* McpElicitation.Service
      const f1 = yield* ask({ server: "a", sessionID: S1 }).pipe(Effect.forkScoped)
      yield* esperarPendientes(1)
      expect(yield* ask({ server: "a", sessionID: S1 })).toEqual({ action: "decline" })
      expect(log.at(-1)).toMatchObject({ type: "mcp.elicitation.rejected", data: { reason: "ambiguous" } })
      const f2 = yield* ask({ server: "b", sessionID: S1 }).pipe(Effect.forkScoped)
      const f3 = yield* ask({ server: "a", sessionID: S2 }).pipe(Effect.forkScoped)
      const pend = yield* esperarPendientes(3)
      for (const p of pend) yield* svc.reply({ requestID: p.id, action: "decline" })
      yield* Fiber.join(f1)
      yield* Fiber.join(f2)
      yield* Fiber.join(f3)
      // liberado: ahora vuelve a poder preguntar
      const f4 = yield* ask({ server: "a", sessionID: S1 }).pipe(Effect.forkScoped)
      const [p] = yield* esperarPendientes(1)
      yield* svc.reply({ requestID: p.id, action: "decline" })
      yield* Fiber.join(f4)
    }),
  { git: true },
)

it.instance(
  "como mucho 5 formularios por llamada; finishCall reinicia la cuenta",
  () =>
    Effect.gen(function* () {
      const log = yield* capturar
      const svc = yield* McpElicitation.Service
      for (let i = 0; i < McpElicitation.MAX_POR_LLAMADA; i++) {
        const f = yield* ask({ callID: "c" }).pipe(Effect.forkScoped)
        const [p] = yield* esperarPendientes(1)
        yield* svc.reply({ requestID: p.id, action: "decline" })
        yield* Fiber.join(f)
      }
      expect(yield* ask({ callID: "c" })).toEqual({ action: "decline" })
      expect(log.at(-1)).toMatchObject({ type: "mcp.elicitation.rejected", data: { reason: "ambiguous" } })
      // otra llamada no se ve afectada
      const g = yield* ask({ callID: "otra" }).pipe(Effect.forkScoped)
      const [p2] = yield* esperarPendientes(1)
      yield* svc.reply({ requestID: p2.id, action: "decline" })
      yield* Fiber.join(g)
      yield* svc.finishCall(S1, "c")
      const h = yield* ask({ callID: "c" }).pipe(Effect.forkScoped)
      const [p3] = yield* esperarPendientes(1)
      yield* svc.reply({ requestID: p3.id, action: "decline" })
      yield* Fiber.join(h)
    }),
  { git: true },
)
