import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Global } from "@opencode-ai/core/global"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Config } from "@/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Instruction } from "../../src/session/instruction"
import { activo, esSensible, expandir } from "../../src/session/imports"
import { provideTmpdirInstance } from "../fixture/fixture"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"

// Ola 7, 7.9: `@imports` en AGENTS.md / CLAUDE.md.
let base: string
let proyecto: string
let fuera: string

const w = (rel: string, contenido: string, raiz = proyecto) => {
  const f = path.join(raiz, rel)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, contenido)
  return f
}
const exp = async (texto: string, opciones = {}) => expandir(texto, path.join(proyecto, "AGENTS.md"), proyecto, opciones)

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lzx-imports-")))
  proyecto = path.join(base, "proyecto")
  fuera = path.join(base, "fuera")
  fs.mkdirSync(proyecto)
  fs.mkdirSync(fuera)
  w("AGENTS.md", "")
})
afterAll(() => fs.rmSync(base, { recursive: true, force: true }))

describe("@imports", () => {
  test("incluye el archivo, relativo al que lo importa, y deja el resto del texto", async () => {
    w("docs/a.md", "ALFA\n@sub/b.md\nFIN-A")
    w("docs/sub/b.md", "BETA")
    const r = await exp("# Titulo\n@docs/a.md\npie")
    expect(r.texto).toBe("# Titulo\nALFA\nBETA\nFIN-A\npie")
    expect(r.notas).toEqual([])
  })

  test("ciclo: se corta con una nota y no se cuelga", async () => {
    w("c1.md", "uno\n@c2.md")
    w("c2.md", "dos\n@c1.md")
    w("auto.md", "yo\n@auto.md")
    const r = await exp("@c1.md\n@auto.md")
    expect(r.texto).toContain("uno\ndos\n[@import omitido: c1.md (ciclo)]")
    expect(r.texto).toContain("yo\n[@import omitido: auto.md (ciclo)]")
    expect(r.notas).toHaveLength(2)
    // Importar el propio archivo de partida también es un ciclo.
    expect((await exp("@AGENTS.md")).notas[0]).toContain("ciclo")
  })

  test("tope de 4 niveles: el 4.º entra y el 5.º se omite", async () => {
    w("n1.md", "N1\n@n2.md")
    w("n2.md", "N2\n@n3.md")
    w("n3.md", "N3\n@n4.md")
    w("n4.md", "N4\n@n5.md")
    w("n5.md", "N5")
    const r = await exp("@n1.md")
    expect(r.texto).toBe("N1\nN2\nN3\nN4\n[@import omitido: n5.md (más de 4 niveles)]")
    expect(r.texto).not.toContain("N5")
    // Con un tope menor se corta antes.
    expect((await exp("@n1.md", { niveles: 2 })).texto).toBe("N1\nN2\n[@import omitido: n3.md (más de 2 niveles)]")
  })

  test("fuera del proyecto: ruta con .., absoluta fuera y ~ se rechazan", async () => {
    w("secreto.md", "NO DEBE SALIR", fuera)
    const r = await exp(`@../fuera/secreto.md\n@${path.join(fuera, "secreto.md")}\n@~/algo.md\n@${os.homedir()}/.zshrc`)
    expect(r.texto).not.toContain("NO DEBE SALIR")
    expect(r.notas).toHaveLength(4)
    expect(r.notas[0]).toContain("fuera del proyecto")
    expect(r.notas[1]).toContain("fuera del proyecto")
    expect(r.notas[2]).toContain("ruta no permitida")
    // Una absoluta DENTRO del proyecto sí vale.
    w("dentro.md", "DENTRO")
    expect((await exp(`@${path.join(proyecto, "dentro.md")}`)).texto).toBe("DENTRO")
  })

  test("symlink que escapa del proyecto se rechaza (archivo y carpeta); uno interno vale", async () => {
    w("real-fuera.md", "FUGA", fuera)
    fs.symlinkSync(path.join(fuera, "real-fuera.md"), path.join(proyecto, "enlace.md"))
    fs.symlinkSync(fuera, path.join(proyecto, "carpeta-enlace"))
    w("interno.md", "INTERNO")
    fs.symlinkSync(path.join(proyecto, "interno.md"), path.join(proyecto, "enlace-interno.md"))
    const r = await exp("@enlace.md\n@carpeta-enlace/real-fuera.md\n@enlace-interno.md")
    expect(r.texto).not.toContain("FUGA")
    expect(r.texto).toContain("INTERNO")
    expect(r.notas.filter((n) => n.includes("fuera del proyecto"))).toHaveLength(2)
  })

  test("archivos sensibles: .env, llaves, auth.json, *.pem, aunque estén dentro o sean enlaces", async () => {
    w(".env", "TOKEN=abc")
    w(".env.local", "TOKEN=def")
    w("auth.json", '{"k":"v"}')
    w("cert.pem", "-----BEGIN-----")
    w("id_rsa", "llave")
    w("sub/clave.key", "llave2")
    w(".ssh/config", "Host x")
    fs.symlinkSync(path.join(proyecto, ".env"), path.join(proyecto, "inocente.md"))
    const r = await exp("@.env\n@.env.local\n@auth.json\n@cert.pem\n@./id_rsa\n@sub/clave.key\n@.ssh/config\n@inocente.md")
    for (const x of ["abc", "def", "llave", "BEGIN", "Host x", '"k"']) expect(r.texto).not.toContain(x)
    expect(r.notas).toHaveLength(8)
    expect(r.notas.every((n) => n.includes("sensible"))).toBe(true)
    expect(esSensible("README.md")).toBe(false)
    expect(esSensible("docs/guia.md")).toBe(false)
    expect(esSensible("environment.md")).toBe(false)
  })

  test("un import dentro de un bloque de código no se expande (``` y ~~~), y fuera sí", async () => {
    w("x.md", "EQUIS")
    const texto = "```md\n@x.md\n```\n@x.md\n~~~\n@x.md\n~~~\n````\n```\n@x.md\n````\n@x.md"
    const r = await exp(texto)
    expect(r.texto).toBe("```md\n@x.md\n```\nEQUIS\n~~~\n@x.md\n~~~\n````\n```\n@x.md\n````\nEQUIS")
    // Un bloque sin cerrar dentro de un archivo importado no se «escapa» al archivo que lo importa.
    w("abierto.md", "```\n@x.md")
    expect((await exp("@abierto.md\n@x.md")).texto).toBe("```\n@x.md\nEQUIS")
  })

  test("topes de bytes: por archivo y total; un fallo no impide el resto", async () => {
    w("grande.md", "g".repeat(200))
    w("p1.md", "1".repeat(60))
    w("p2.md", "2".repeat(60))
    const r = await exp("@grande.md\n@p1.md\n@p2.md\n@p1.md", { archivoMaxBytes: 100, totalMaxBytes: 130 })
    expect(r.texto).toContain("[@import omitido: grande.md (archivo demasiado grande)]")
    expect(r.texto).toContain("1".repeat(60))
    expect(r.texto).toContain("2".repeat(60))
    expect(r.texto).toContain("[@import omitido: p1.md (tope total de imports)]")
    expect(r.texto).not.toContain("g".repeat(10))
  })

  test("fallos varios: no existe, carpeta, binario; menciones sueltas no cuentan", async () => {
    fs.mkdirSync(path.join(proyecto, "carpeta"), { recursive: true })
    fs.writeFileSync(path.join(proyecto, "bin.md"), Buffer.from([65, 0, 66]))
    const r = await exp("@no-existe.md\n@carpeta/\n@bin.md\n@todo\nhola @alguien en medio\n  @sub/../dentro.md  ")
    expect(r.notas.map((n) => n.replace(/^.*\(|\)\]$/g, ""))).toEqual(["no existe", "no es un archivo", "no es texto"])
    expect(r.texto).toContain("@todo\nhola @alguien en medio\nDENTRO")
  })

  test("un archivo de partida fuera del proyecto no expande nada (AGENTS.md global)", async () => {
    w("g.md", "G", proyecto)
    const f = w("AGENTS.md", "@../proyecto/g.md", fuera)
    const r = await expandir("@../proyecto/g.md", f, proyecto)
    expect(r.texto).toBe("@../proyecto/g.md")
  })

  test("LAZUNOX_IMPORTS=0 apaga el interruptor (por defecto está encendido)", () => {
    expect(activo({} as NodeJS.ProcessEnv)).toBe(true)
    expect(activo({ LAZUNOX_IMPORTS: "1" } as NodeJS.ProcessEnv)).toBe(true)
    expect(activo({ LAZUNOX_IMPORTS: "0" } as NodeJS.ProcessEnv)).toBe(false)
  })
})

// --- Integración con Instruction.system ---
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([CrossSpawnSpawner.node, LayerNodePlatform.filesystem, InstanceStore.node]), [
    [InstanceBootstrap.node, Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))],
  ]),
)
const capa = (dir: string) =>
  AppNodeBuilder.build(Instruction.node, [
    [Config.node, Layer.succeed(Config.Service, TestConfig.make())],
    [Global.node, Global.layerWith({ home: dir, config: dir })],
    [RuntimeFlags.node, RuntimeFlags.layer({})],
  ])
const sistema = () =>
  Effect.gen(function* () {
    return yield* (yield* Instruction.Service).system()
  })

describe("@imports en Instruction.system", () => {
  it.live("expande en AGENTS.md del proyecto; con LAZUNOX_IMPORTS=0 queda como antes", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Reglas\n@docs/extra.md\n@.env")
        fs.mkdirSync(path.join(dir, "docs"))
        fs.writeFileSync(path.join(dir, "docs/extra.md"), "EXTRA")
        fs.writeFileSync(path.join(dir, ".env"), "SECRETO=1")
        const antes = process.env.LAZUNOX_IMPORTS
        try {
          const conImports = yield* sistema().pipe(Effect.provide(capa(dir)))
          expect(conImports.join("\n")).toContain("# Reglas\nEXTRA\n[@import omitido: .env (archivo sensible)]")
          expect(conImports.join("\n")).not.toContain("SECRETO")
          process.env.LAZUNOX_IMPORTS = "0"
          const sin = yield* sistema().pipe(Effect.provide(capa(dir)))
          expect(sin[0]).toBe(`Instructions from: ${path.join(dir, "AGENTS.md")}\n# Reglas\n@docs/extra.md\n@.env`)
        } finally {
          if (antes === undefined) delete process.env.LAZUNOX_IMPORTS
          else process.env.LAZUNOX_IMPORTS = antes
        }
      }),
    ),
  )
})
