// Ola 7, 7.5: sanitizador de secretos (núcleo puro). Los casos de cableado (tool parts, permisos, salida del modelo) están más abajo.
import { afterEach, describe, expect, test } from "bun:test"
import { MARCA, activo, activoParaElModelo, olvidarSecretos, registrarSecretos, sanitizar, sanitizarProfundo } from "@opencode-ai/core/sanitizar"

const sinEntorno = {} as Record<string, string | undefined>

afterEach(() => {
  olvidarSecretos()
  delete process.env.LAZUNOX_SANITIZAR
  delete process.env.LAZUNOX_SANITIZAR_MODELO
  delete process.env.LAZUNOX_SANITIZAR_EXTRA
})

// La misma forma que la clave falsa de la tarea T28 del banco: `sk-FALSA` + 40 alfanuméricos de relleno.
const FALSA = "sk-FALSAq1w2e3r4t5y6u7i8o9p0aAsSdDfFgGhHjJkKlL"

describe("7.5 formas que se tapan", () => {
  test("sk- + alfanuméricos (la clave falsa de T28), también con guiones y guiones bajos", () => {
    expect(sanitizar(`clave ${FALSA} fin`, sinEntorno)).toBe(`clave ${MARCA} fin`)
    expect(sanitizar("sk-proj-abc123_DEF456-ghi789JKL012mno", sinEntorno)).toBe(MARCA)
    expect(sanitizar("sk-ant-api03-AbCdEf0123456789xyzXYZ", sinEntorno)).toBe(MARCA)
  })
  test("AKIA + 16", () => {
    expect(sanitizar("id AKIAIOSFODNN7EXAMPLE listo", sinEntorno)).toBe(`id ${MARCA} listo`)
  })
  test("Bearer con token largo", () => {
    expect(sanitizar("Authorization: Bearer abcDEF0123456789xyz.tok", sinEntorno)).toBe(`Authorization: Bearer ${MARCA}`)
    expect(sanitizar("authorization: bearer abcdef0123456789abcdef", sinEntorno)).toContain(MARCA)
  })
  test("api_key / token / secret / password con : o =, también dentro de un nombre de variable y en JSON", () => {
    expect(sanitizar("api_key=abcd1234efgh", sinEntorno)).toBe(`api_key=${MARCA}`)
    expect(sanitizar("LAZUNOX_API_KEY=abcd1234efgh", sinEntorno)).toBe(`LAZUNOX_API_KEY=${MARCA}`)
    expect(sanitizar("export GITHUB_TOKEN='ghx-12345678'", sinEntorno)).toBe(`export GITHUB_TOKEN='${MARCA}'`)
    expect(sanitizar('{"password": "hunter2hunter2", "user": "ana"}', sinEntorno)).toBe(`{"password": "${MARCA}", "user": "ana"}`)
    expect(sanitizar("secret: correcthorsebattery", sinEntorno)).toBe(`secret: ${MARCA}`)
    // Como Codex: un valor de 8 o más se tapa aunque parezca una palabra (preferimos tapar de más que filtrar una frase de paso).
    expect(sanitizar("password: required", sinEntorno)).toBe(`password: ${MARCA}`)
    expect(sanitizar("DB_PASSWORD = s3cr3tvalue", sinEntorno)).toBe(`DB_PASSWORD = ${MARCA}`)
  })
  test("formas con prefijo propio: GitHub, Slack, Google, JWT y clave privada", () => {
    expect(sanitizar(`ghp_${"a1B2".repeat(9)}`, sinEntorno)).toBe(MARCA)
    expect(sanitizar("xoxb-1234567890-abcdefghij", sinEntorno)).toBe(MARCA)
    expect(sanitizar(`AIza${"x1Y2".repeat(8)}abc`, sinEntorno)).toBe(MARCA)
    expect(sanitizar("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r", sinEntorno)).toBe(MARCA)
    expect(sanitizar("a\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nxyz\n-----END RSA PRIVATE KEY-----\nb", sinEntorno)).toBe(`a\n${MARCA}\nb`)
  })
  test("literales registrados por la app o por el entorno", () => {
    registrarSecretos(["mi-clave-rara-de-la-sesion", "corta"])
    expect(sanitizar("usa mi-clave-rara-de-la-sesion ahora, corta", sinEntorno)).toBe(`usa ${MARCA} ahora, corta`)
    expect(sanitizar("otra-clave-literal-123", { LAZUNOX_SANITIZAR_EXTRA: '["otra-clave-literal-123"]' })).toBe(MARCA)
    expect(sanitizar("x linea-uno-secreta y", { LAZUNOX_SANITIZAR_EXTRA: "linea-uno-secreta\nlinea-dos-secreta" })).toBe(`x ${MARCA} y`)
    expect(sanitizar("zzz", { LAZUNOX_SANITIZAR_EXTRA: "[roto" })).toBe("zzz")
  })
  test("es idempotente y conserva el resto del texto", () => {
    const uno = sanitizar(`a=1\nLAZUNOX_API_KEY=${FALSA}\nb=2`, sinEntorno)
    expect(uno).toBe(`a=1\nLAZUNOX_API_KEY=${MARCA}\nb=2`)
    expect(sanitizar(uno, sinEntorno)).toBe(uno)
  })
})

describe("7.5 falsos positivos: no se tapa", () => {
  const intactos = [
    "Bearer of good news",
    "the bearer of this letter",
    "Bearer authentication-mechanism",
    "ask-for-the-long-slug-name-here-please",
    "risk-assessment-and-mitigation-plan",
    "task-runner-configuration-v2",
    "sk-short",
    "max_tokens=16384",
    "max_tokens: 100000000",
    "total_tokens=1234567890",
    "token_count=12345678",
    "input_tokens: 123456789",
    "tokens=999999999",
    "password=",
    "password=********",
    "password=${DB_PASSWORD}",
    "token: ${{ secrets.GITHUB_TOKEN }}",
    "secret=<tu-clave-aqui>",
    "api_key=process.env.OPENAI_API_KEY",
    "secret_key = os.environ['X']",
    "token=12345678",
    "secret=true",
    "git commit 9fceb02d0ae598e95dc970b74767f19372d61af8",
    "sha256: 5c963a819f43ec0f005f98395afa45cc7937a132085842cb3ef9687d12b110ba",
    "id ses_0a1b2c3d4e5f6a7b8c9d0e1f2a3b",
    "550e8400-e29b-41d4-a716-446655440000",
    "AKIA corto",
    "const secretos = 5; el secreto es la constancia",
    "tokenizer.encode(text)",
    "authToken?: string",
  ]
  for (const t of intactos) test(JSON.stringify(t), () => expect(sanitizar(t, sinEntorno)).toBe(t))
})

describe("7.5 interruptores y utilidades", () => {
  test("LAZUNOX_SANITIZAR=0 lo apaga; el modo del modelo es otra cosa y viene apagado", () => {
    expect(activo({})).toBe(true)
    expect(activo({ LAZUNOX_SANITIZAR: "0" })).toBe(false)
    expect(sanitizar(FALSA, { LAZUNOX_SANITIZAR: "0" })).toBe(FALSA)
    expect(activoParaElModelo({})).toBe(false)
    expect(activoParaElModelo({ LAZUNOX_SANITIZAR_MODELO: "1" })).toBe(true)
    expect(activoParaElModelo({ LAZUNOX_SANITIZAR_MODELO: "1", LAZUNOX_SANITIZAR: "0" })).toBe(false)
  })
  test("sanitizarProfundo copia, no muta el original y respeta objetos no planos", () => {
    const f = new Date(0)
    const original = { cmd: `curl -H "Authorization: Bearer abcDEF0123456789xyzXYZ"`, n: 3, lista: [FALSA, { k: "api_key=abcd1234efgh" }], f }
    const copia = sanitizarProfundo(original, sinEntorno)
    expect(copia.cmd).toContain(MARCA)
    expect(copia.lista[0]).toBe(MARCA)
    expect((copia.lista[1] as { k: string }).k).toBe(`api_key=${MARCA}`)
    expect(copia.n).toBe(3)
    expect(copia.f).toBe(f)
    expect(original.lista[0]).toBe(FALSA)
  })
  test("entrada grande sin secretos: rápida (sin retroceso exponencial)", () => {
    const grande = ("a".repeat(120) + " ").repeat(8000) + "x".repeat(200_000) + "\n" + "tokentokentoken".repeat(20_000)
    const t0 = performance.now()
    expect(sanitizar(grande, sinEntorno)).toBe(grande)
    expect(performance.now() - t0).toBeLessThan(3000)
  })
})

describe("7.5 registros del motor", () => {
  test("una línea de registro con una credencial sale tapada", async () => {
    const { Effect, Layer, Logger } = await import("effect")
    const { NodeFileSystem } = await import("@effect/platform-node")
    const { Logging } = await import("@opencode-ai/core/observability/logging")
    const os = await import("os")
    const fs = await import("fs")
    const path = await import("path")
    const archivo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lzx-log-")), "t.log")
    await Effect.runPromise(
      Effect.logInfo("prueba", { cmd: `curl -H "Authorization: Bearer abcDEF0123456789xyzXYZ" -d api_key=abcd1234efgh`, ok: "visible" }).pipe(
        Effect.provide(Logger.layer([Logging.fileLogger(archivo, "t")]).pipe(Layer.provide(NodeFileSystem.layer))),
      ),
    )
    await new Promise((r) => setTimeout(r, 1800))
    const t = fs.readFileSync(archivo, "utf-8")
    expect(t).toContain("visible")
    expect(t).toContain(MARCA)
    expect(t).not.toContain("abcDEF0123456789xyzXYZ")
    expect(t).not.toContain("abcd1234efgh")
  })
})
