// Lazunox lazunox.15: tope de 32 KiB a AGENTS.md / CLAUDE.md / CONTEXT.md (después de expandir los `@imports`).
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Global } from "@opencode-ai/core/global"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Config } from "@/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Instruction } from "../../src/session/instruction"
import { AVISO, TOPE_BYTES, activo, aplicar } from "../../src/session/tope-instrucciones"
import { provideTmpdirInstance } from "../fixture/fixture"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"

const E = {} as NodeJS.ProcessEnv
const bytes = (t: string) => Buffer.byteLength(t, "utf-8")
const lineas = (n: number, ancho = 79) => Array.from({ length: n }, (_, i) => `L${String(i).padStart(5, "0")} ${"x".repeat(ancho)}`).join("\n")

describe("tope de instrucciones (puro)", () => {
  test("no toca lo que cabe: justo en el tope, vacío o con el tope apagado", () => {
    expect(aplicar("hola", E)).toBe("hola")
    expect(aplicar("", E)).toBe("")
    const justo = "a".repeat(TOPE_BYTES)
    expect(aplicar(justo, E)).toBe(justo)
    const grande = lineas(1000)
    expect(aplicar(grande, { LAZUNOX_TOPE_INSTRUCCIONES: "0" } as NodeJS.ProcessEnv)).toBe(grande)
    expect(activo(E)).toBe(true)
    expect(activo({ LAZUNOX_TOPE_INSTRUCCIONES: "0" } as NodeJS.ProcessEnv)).toBe(false)
    expect(activo({ LAZUNOX_TOPE_INSTRUCCIONES: "1" } as NodeJS.ProcessEnv)).toBe(true)
  })

  test("al pasarse corta en un límite de línea y añade la línea fija", () => {
    const texto = lineas(1000)
    const r = aplicar(texto, E)
    expect(r.endsWith(`\n${AVISO}`)).toBe(true)
    expect(AVISO).toBe("[Lazunox: este archivo de instrucciones se recortó a 32 KB; el resto no se cargó]")
    const cuerpo = r.slice(0, r.length - AVISO.length - 1)
    expect(bytes(cuerpo)).toBeLessThanOrEqual(TOPE_BYTES)
    // todas las líneas que quedaron están completas y son las primeras, en orden
    const ls = cuerpo.split("\n")
    ls.forEach((l, i) => expect(l).toBe(texto.split("\n")[i]!))
    expect(ls.length).toBeLessThan(1000)
    expect(r).not.toContain("L00999")
  })

  test("no parte un carácter de varios bytes ni deja caracteres de reemplazo", () => {
    const r = aplicar("é".repeat(40000), E) // 2 bytes cada uno, sin saltos de línea
    expect(r).not.toContain("\uFFFD")
    expect(bytes(r.slice(0, r.length - AVISO.length - 1))).toBeLessThanOrEqual(TOPE_BYTES)
    const e = aplicar("日本語\n".repeat(8000), E) // 3 bytes por letra
    expect(e).not.toContain("\uFFFD")
    expect(e.endsWith(AVISO)).toBe(true)
  })

  test("saltos de línea de Windows (CRLF) y un archivo sin ningún salto", () => {
    const crlf = Array.from({ length: 1000 }, (_, i) => `linea ${i} ${"y".repeat(60)}`).join("\r\n")
    const r = aplicar(crlf, E)
    expect(r.endsWith(`\n${AVISO}`)).toBe(true)
    expect(r).not.toMatch(/\r\n\n/)
    const sin = aplicar("z".repeat(TOPE_BYTES + 10), E)
    expect(bytes(sin)).toBe(TOPE_BYTES + 1 + bytes(AVISO))
  })
})

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([CrossSpawnSpawner.node, LayerNodePlatform.filesystem, InstanceStore.node]), [
    [InstanceBootstrap.node, Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))],
  ]),
)
const capa = (home: string, config: string) =>
  AppNodeBuilder.build(Instruction.node, [
    [Config.node, Layer.succeed(Config.Service, TestConfig.make())],
    [Global.node, Global.layerWith({ home, config })],
    [RuntimeFlags.node, RuntimeFlags.layer({})],
  ])
const sistema = () =>
  Effect.gen(function* () {
    return yield* (yield* Instruction.Service).system()
  })

describe("tope de instrucciones en Instruction.system", () => {
  it.live("recorta AGENTS.md del proyecto, cuenta DESPUÉS de expandir @imports, y LAZUNOX_TOPE_INSTRUCCIONES=0 lo apaga", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        // AGENTS.md pequeño en disco, pero con tres imports de ~20 KiB (cada uno bajo su tope de 32 KiB): lo que llega pasa del tope
        fs.mkdirSync(path.join(dir, "docs"))
        for (const n of ["a", "b", "c"]) fs.writeFileSync(path.join(dir, `docs/${n}.md`), lineas(250).replaceAll("L0", `${n.toUpperCase()}0`))
        fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Reglas\n@docs/a.md\n@docs/b.md\n@docs/c.md\n")
        const antes = process.env.LAZUNOX_TOPE_INSTRUCCIONES
        try {
          const [recortado] = yield* sistema().pipe(Effect.provide(capa(dir, path.join(dir, "cfg"))))
          expect(recortado).toContain(AVISO)
          expect(recortado).toContain("# Reglas\nA0")
          expect(recortado).not.toContain("C0")
          expect(bytes(recortado!)).toBeLessThan(TOPE_BYTES + 1000)
          process.env.LAZUNOX_TOPE_INSTRUCCIONES = "0"
          const [entero] = yield* sistema().pipe(Effect.provide(capa(dir, path.join(dir, "cfg"))))
          expect(entero).not.toContain(AVISO)
          expect(entero).toContain("C0")
        } finally {
          if (antes === undefined) delete process.env.LAZUNOX_TOPE_INSTRUCCIONES
          else process.env.LAZUNOX_TOPE_INSTRUCCIONES = antes
        }
      }),
    ),
  )

  it.live("también recorta la global (AGENTS.md de la carpeta de configuración) y deja intacto un archivo que cabe", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const cfg = path.join(dir, "cfg")
        fs.mkdirSync(cfg)
        fs.writeFileSync(path.join(cfg, "AGENTS.md"), lineas(700))
        fs.writeFileSync(path.join(dir, "AGENTS.md"), "corto y completo")
        const todo = yield* sistema().pipe(Effect.provide(capa(dir, cfg)))
        const global = todo.find((t) => t.includes(path.join(cfg, "AGENTS.md")))!
        expect(global).toContain(AVISO)
        expect(global).not.toContain("L00699")
        const proyecto = todo.find((t) => t.includes("corto y completo"))!
        expect(proyecto).not.toContain(AVISO)
      }),
    ),
  )
})
