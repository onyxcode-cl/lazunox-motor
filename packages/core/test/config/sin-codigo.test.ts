import { expect, test } from "bun:test"
import { ConfigSinCodigo } from "@opencode-ai/core/config/sin-codigo"

test("solo conserva texto de agentes y comandos de ambos formatos", () => {
  expect(
    ConfigSinCodigo.limpiarInfo({
      agent: { viejo: { prompt: "Texto", permission: "allow", tools: { bash: true }, model: "x/y", options: {} } },
      agents: {
        nuevo: {
          system: "Texto",
          permissions: [{ action: "*", resource: "*", effect: "allow" }],
          request: {},
          model: "x/y",
        },
      },
      mode: { modo: { prompt: "Texto", permission: "allow" } },
      command: { viejo: { template: "Texto !`echo hola`", model: "x/y", agent: "build", subtask: true } },
      commands: { nuevo: { template: "Texto", model: "x/y", variant: "alta" } },
      model: "x/y",
      plugins: ["./p.js"],
      tools: { bash: true },
      mcp: {},
      providers: {},
      experimental: {},
      references: {},
    }),
  ).toEqual({
    agent: { viejo: { prompt: "Texto" } },
    agents: { nuevo: { system: "Texto" } },
    mode: { modo: { prompt: "Texto" } },
    command: { viejo: { template: "Texto `echo hola`" } },
    commands: { nuevo: { template: "Texto" } },
  })
})

test("descarta permisos restrictivos también: de la carpeta solo entra texto", () => {
  expect(
    ConfigSinCodigo.limpiarAgente({
      description: "Texto",
      permissions: [],
      permission: "deny",
      tools: { bash: false },
      mode: "primary",
      disabled: true,
    }),
  ).toEqual({ description: "Texto" })
})

test("conserva rutas de texto sin resolver interpolaciones", () => {
  expect(
    ConfigSinCodigo.limpiarInfo({
      instructions: ["{env:MARCADOR}", "{file:nota}", 1],
      skills: { paths: ["texto", false], urls: ["https://example.test"] },
    }),
  ).toEqual({ instructions: ["{env:MARCADOR}", "{file:nota}"], skills: { paths: ["texto"] } })
})

test("ignora entradas que no son objetos", () => {
  expect(ConfigSinCodigo.limpiarInfo(null)).toEqual({})
  expect(ConfigSinCodigo.limpiarInfo([])).toEqual({})
  expect(ConfigSinCodigo.limpiarAgente("allow")).toEqual({})
})
