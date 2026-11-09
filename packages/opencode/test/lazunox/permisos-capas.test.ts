// Lazunox (lazunox.16, B1): política única de permisos por capas (LAZUNOX_PERMISOS_CAPAS=1). Casos de la batería BATERIA.md, parte B1,
// a nivel de unidad (las funciones puras de `permission/capas.ts`); el motor real se prueba con /tmp/b1-permisos/b1-motor-real.mjs.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { PermisoCapas as C } from "../../src/permission/capas"
import { Permission } from "../../src/permission"
import { deriveSubagentSessionPermission } from "../../src/agent/subagent-permissions"
import { permisoDeHija } from "../../src/tool/task"
import { Politica } from "../../src/permission/politica"

type R = { permission: string; pattern: string; action: "allow" | "ask" | "deny" }
const r = (permission: string, pattern: string, action: R["action"]): R => ({ permission, pattern, action })

// Bloques del modo de la app 1.8.12 (lo esencial de `rulesetForMode`): lo que importa es el orden y las acciones.
const BLOQUE: Record<string, R[]> = {
  manual: [r("edit", "*", "ask"), r("write", "*", "ask"), r("bash", "*", "ask"), r("webfetch", "*", "ask"), r("websearch", "*", "ask"), r("external_directory", "*", "ask"), r("task", "*", "ask")],
  acceptEdits: [r("edit", "*", "allow"), r("write", "*", "allow"), r("bash", "*", "ask"), r("webfetch", "*", "ask"), r("websearch", "*", "ask"), r("external_directory", "*", "ask"), r("task", "*", "allow")],
  plan: [r("edit", "*", "deny"), r("edit", ".opencode/plans/*.md", "allow"), r("write", "*", "deny"), r("bash", "*", "ask"), r("webfetch", "*", "ask"), r("external_directory", "*", "ask"), r("task", "*", "ask"), r("task", "general", "deny")],
  auto: [r("edit", "*", "allow"), r("write", "*", "allow"), r("bash", "*", "ask"), r("webfetch", "*", "ask"), r("websearch", "*", "ask"), r("external_directory", "*", "ask"), r("task", "*", "allow")],
  bypass: [r("*", "*", "allow")],
}
const MODOS = Object.keys(BLOQUE)
const AGENTE_BUILD = { name: "build", permission: [r("*", "*", "allow"), r("doom_loop", "*", "ask"), r("external_directory", "*", "ask")] as R[] }

let dir: string
let previo: Record<string, string | undefined>
const ENV = ["LAZUNOX_PERMISOS_CAPAS", "OPENCODE_CONFIG_CONTENT", "OPENCODE_PERMISSION", "LAZUNOX_POLICY_FILE", "LAZUNOX_POLITICAS"]

beforeEach(() => {
  previo = Object.fromEntries(ENV.map((k) => [k, process.env[k]]))
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capas-"))
  process.env.LAZUNOX_PERMISOS_CAPAS = "1"
  delete process.env.OPENCODE_CONFIG_CONTENT
  delete process.env.OPENCODE_PERMISSION
  delete process.env.LAZUNOX_POLICY_FILE
  Politica.olvidar()
})
afterEach(() => {
  for (const k of ENV) previo[k] === undefined ? delete process.env[k] : (process.env[k] = previo[k])
  fs.rmSync(dir, { recursive: true, force: true })
  Politica.olvidar()
})

const escribir = (rel: string, json: unknown) => {
  const f = path.join(dir, rel)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, typeof json === "string" ? json : JSON.stringify(json))
}
/** Decisión del motor para (permiso, patrón) con la config puesta en `dir`, el modo dado y, si se pide, un agente/sesión propios. */
const decide = (permiso: string, modo: string | null, o: { patron?: string; sesion?: R[]; agente?: typeof AGENTE_BUILD; directorio?: string } = {}) => {
  const sesion = o.sesion ?? (modo ? [...BLOQUE[modo]!] : [])
  const e = C.efectivo({ agent: o.agente ?? AGENTE_BUILD, session: { permission: sesion, directory: o.directorio ?? dir } })
  return C.decidir(e, permiso, o.patron ?? "*").action
}
const inline = (permission: unknown, agent?: unknown) => (process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ permission, ...(agent ? { agent } : {}) }))

describe("bandera apagada = lazunox.15", () => {
  test("efectivo() es el merge de siempre y decidir() es evaluate(); la config no se lee", () => {
    process.env.LAZUNOX_PERMISOS_CAPAS = "0"
    inline({ bash: "deny" })
    const e = C.efectivo({ agent: AGENTE_BUILD, session: { permission: BLOQUE.bypass, directory: dir } })
    expect(e.piso).toEqual([])
    expect(e.ruleset).toEqual(Permission.merge(AGENTE_BUILD.permission, BLOQUE.bypass!))
    // en bypass el `*: allow` de la sesión tapa el deny: es la conducta de lazunox.15 (RI3-O1)
    expect(C.decidir(e, "bash", "*").action).toBe("allow")
  })
})

describe("B1-02/B1-12/B1-13 deny de la config gana a todo lo de menor rango", () => {
  for (const modo of MODOS) {
    test(`deny exacto en config [${modo}]`, () => {
      inline({ prueba_start: "deny", bash: "deny", edit: "deny", webfetch: "deny" })
      for (const p of ["prueba_start", "bash", "edit", "webfetch"]) expect(decide(p, modo)).toBe("deny")
      expect(decide("prueba_secret", modo)).not.toBe("deny")
    })
  }
  test("GLOBAL niega, CARPETA permite (D2): el deny entre fuentes gana", () => {
    inline({ prueba_start: "deny", bash: "deny" })
    escribir("opencode.json", { permission: { prueba_start: "allow", bash: "allow", "*": "allow" } })
    for (const modo of MODOS) {
      expect(decide("prueba_start", modo)).toBe("deny")
      expect(decide("bash", modo)).toBe("deny")
    }
  })
  test("GLOBAL permite, CARPETA niega", () => {
    inline({ "prueba_*": "allow", bash: "allow" })
    escribir("opencode.json", { permission: { prueba_start: "deny", bash: "deny" } })
    for (const modo of MODOS) {
      expect(decide("prueba_start", modo)).toBe("deny")
      expect(decide("bash", modo)).toBe("deny")
    }
  })
})

describe("B1-03 comodines", () => {
  const formas: Array<[string, string[]]> = [
    ["prueba_*", ["prueba_start", "prueba_secret"]],
    ["*start*", ["prueba_start"]],
    ["prueba_sta?t", ["prueba_start"]],
    ["*start* *", ["prueba_start"]],
    ["*_start", ["prueba_start"]],
    ["p*t", ["prueba_start", "prueba_secret"]],
    ["*", ["prueba_start", "prueba_secret"]],
  ]
  for (const [forma, negadas] of formas) {
    test(`deny ${forma}`, () => {
      inline({ [forma]: "deny" })
      for (const modo of ["manual", "bypass"]) {
        for (const p of ["prueba_start", "prueba_secret"]) {
          expect(decide(p, modo)).toBe(negadas.includes(p) ? "deny" : decide(p, modo))
          if (negadas.includes(p)) expect(decide(p, modo)).toBe("deny")
          else expect(decide(p, modo)).not.toBe("deny") // control: no se niega de más
        }
      }
    })
  }
})

describe("B1-04 mayúsculas (D3)", () => {
  test("la clave del deny se compara sin distinguir mayúsculas; un allow no abre un ask", () => {
    inline({ PRUEBA_START: "deny", Bash: "deny", EDIT: "deny", "Prueba_*": "deny" })
    for (const modo of ["manual", "bypass"]) for (const p of ["prueba_start", "bash", "edit"]) expect(decide(p, modo)).toBe("deny")
    inline({ PRUEBA_START: "allow" })
    expect(decide("prueba_start", "manual", { sesion: [r("prueba_start", "*", "ask")] })).toBe("ask")
  })
})

describe("B1-05/B1-06 clave * y texto", () => {
  test("`*: deny` suelto, `{*:{*:deny}}` y permission:'deny' niegan todo menos lo propio de la app (D4)", () => {
    for (const cfg of [{ "*": "deny" }, { "*": { "*": "deny" } }, "deny"]) {
      inline(cfg)
      for (const modo of ["manual", "bypass"]) {
        for (const p of ["prueba_start", "bash", "edit", "webfetch", "read", "browser_start"]) expect(decide(p, modo)).toBe("deny")
        // D4: los comodines amplios no niegan las herramientas propias de la app
        expect(decide("bgshell_start", modo)).not.toBe("deny")
        expect(decide("documentos_crear", modo)).not.toBe("deny")
      }
    }
  })
  test("'ask' y 'allow' como texto no abren nada", () => {
    inline("ask")
    expect(decide("bash", "manual")).toBe("ask")
    expect(decide("bash", "bypass")).toBe("allow") // el bloque del modo manda donde no hay deny
    inline("allow")
    escribir("opencode.json", { permission: { bash: "deny" } })
    expect(decide("bash", "bypass")).toBe("deny")
    expect(decide("bash", "manual")).toBe("deny")
  })
})

describe("BL-1 (RI1): deny especifico ANTES de `*` en el mismo mapa (orden de la bateria)", () => {
  test("B1-07: rm * y *.env niegan aunque vayan antes del comodin", () => {
    inline({ bash: { "rm *": "deny", "*": "ask" }, edit: { "*.env": "deny", "*": "ask" } })
    for (const modo of MODOS) {
      expect(decide("bash", modo, { patron: "rm -rf x" }), modo).toBe("deny")
      expect(decide("edit", modo, { patron: "a.env" }), modo).toBe("deny")
    }
    expect(decide("bash", "manual", { patron: "echo hola" })).toBe("ask")
    expect(decide("bash", "bypass", { patron: "echo hola" })).toBe("allow")
  })
  test("B1-08: git push* antes de * allow niega las variantes que casan", () => {
    inline({ bash: { "git push*": "deny", "*": "allow" } })
    for (const modo of MODOS) {
      expect(decide("bash", modo, { patron: "git push origin x" }), modo).toBe("deny")
      expect(decide("bash", modo, { patron: "git status" }), modo).not.toBe("deny")
    }
  })
  test("B1-09: secreto/* antes de * allow niega edit", () => {
    inline({ edit: { "secreto/*": "deny", "*": "allow" } })
    for (const modo of MODOS) {
      expect(decide("edit", modo, { patron: "secreto/k.txt" }), modo).toBe("deny")
      if (modo !== "plan") expect(decide("edit", modo, { patron: "otro/k.txt" }), modo).not.toBe("deny")
    }
  })
  test("no cambia: `*: deny` primero con excepciones, y allow especifico despues de un deny especifico", () => {
    inline({ bash: { "*": "deny", "git status": "allow" } })
    expect(decide("bash", "bypass", { patron: "git status" })).toBe("allow")
    expect(decide("bash", "bypass", { patron: "rm x" })).toBe("deny")
    inline({ bash: { "git *": "deny", "git status": "allow" } })
    expect(decide("bash", "bypass", { patron: "git status" })).toBe("allow")
  })
})

describe("B1-07 mapas por patrón", () => {
  test("el deny vale por patrón, no por herramienta entera", () => {
    // OJO (B1-07 de la batería lo escribe al revés): con `"*": "ask"` DESPUÉS del deny por patrón, la última regla que casa es `ask` (posición dentro de la
    // misma fuente, D2), así que el catch-all va primero. Ver el informe.
    inline({ bash: { "*": "ask", "rm *": "deny" }, edit: { "*": "ask", "*.env": "deny" }, prueba_start: { "*": "deny" } })
    for (const modo of MODOS) {
      expect(decide("bash", modo, { patron: "rm -rf x" })).toBe("deny")
      expect(decide("edit", modo, { patron: "a.env" })).toBe("deny")
      expect(decide("prueba_start", modo)).toBe("deny")
    }
    expect(decide("bash", "manual", { patron: "echo hola" })).toBe("ask")
    expect(decide("bash", "bypass", { patron: "echo hola" })).toBe("allow")
    expect(decide("edit", "manual", { patron: "x.txt" })).toBe("ask")
    // «bash sigue ofrecida»: solo el patrón está negado
    const e = C.efectivo({ agent: AGENTE_BUILD, session: { permission: BLOQUE.bypass, directory: dir } })
    const ocultas = Permission.disabled(["bash", "edit", "prueba_start"], e)
    expect([...ocultas]).toEqual(["prueba_start"])
  })
})

describe("B1-10/B1-11 agente y carpeta", () => {
  test("deny en agent.build vale con build; el de agent.plan no vale con build", () => {
    inline({}, { build: { permission: { prueba_start: "deny", bash: "deny" } } })
    for (const modo of MODOS) {
      expect(decide("prueba_start", modo)).toBe("deny")
      expect(decide("bash", modo)).toBe("deny")
    }
    inline({}, { plan: { permission: { prueba_start: "deny", bash: "deny" } } })
    expect(decide("prueba_start", "manual")).not.toBe("deny")
    expect(decide("bash", "bypass")).toBe("allow")
    expect(decide("bash", "plan", { agente: { name: "plan", permission: [r("*", "*", "allow")] } })).toBe("deny")
  })
  test("CARPETA: sus deny valen; su allow nunca abre lo que el modo pregunta", () => {
    escribir("opencode.json", { permission: { prueba_start: "deny", bash: { "rm *": "deny" } } })
    for (const modo of MODOS) {
      expect(decide("prueba_start", modo)).toBe("deny")
      expect(decide("bash", modo, { patron: "rm x" })).toBe("deny")
    }
    escribir("opencode.json", { permission: { "*": "allow" } })
    expect(decide("bash", "manual")).toBe("ask")
    expect(decide("edit", "manual")).toBe("ask")
  })
})

describe("B1-14/B1-15/B1-16", () => {
  test("contradicción cruzada por clave (N1 de RI2)", () => {
    inline({ "prueba_*": "deny", prueba_start: "allow" })
    escribir("opencode.json", { permission: { prueba_start: "deny", "prueba_*": "allow" } })
    for (const modo of ["manual", "bypass", ...MODOS]) {
      expect(decide("prueba_start", modo)).toBe("deny")
      expect(decide("prueba_secret", modo)).toBe("deny")
    }
  })
  test("carpeta + carpeta superior (repositorio): no depende del orden de escaneo", () => {
    fs.mkdirSync(path.join(dir, ".git"))
    escribir("opencode.json", { permission: { "prueba_*": "deny", prueba_start: "allow" } })
    escribir("sub/opencode.json", { permission: { prueba_start: "deny" } })
    const sub = path.join(dir, "sub")
    for (const modo of ["manual", "bypass"]) expect(decide("prueba_start", modo, { directorio: sub })).toBe("deny")
    escribir("opencode.json", { permission: { prueba_start: "deny" } })
    escribir("sub/opencode.json", { permission: { prueba_start: "allow" } })
    for (const modo of ["manual", "bypass"]) expect(decide("prueba_start", modo, { directorio: sub })).toBe("deny")
    escribir("opencode.json", { permission: { "prueba_*": "deny", prueba_start: "allow" } })
    fs.rmSync(path.join(sub, "opencode.json"))
    for (const modo of ["manual", "bypass"]) {
      expect(decide("prueba_start", modo, { directorio: sub })).not.toBe("deny") // misma fuente: la posición manda
      expect(decide("prueba_secret", modo, { directorio: sub })).toBe("deny")
    }
  })
  test("«negar todo menos X» sigue funcionando dentro de una misma fuente", () => {
    inline({ "prueba_*": "deny", prueba_start: "allow" })
    for (const modo of MODOS) {
      expect(decide("prueba_start", modo)).not.toBe("deny")
      expect(decide("prueba_secret", modo)).toBe("deny")
    }
    // b) deny en una fuente y allow en otra: ambas denegadas
    inline({ "prueba_*": "deny" })
    escribir("opencode.json", { permission: { prueba_start: "allow" } })
    expect(decide("prueba_start", "manual")).toBe("deny")
    expect(decide("prueba_secret", "manual")).toBe("deny")
    // c) `*: deny` con excepciones en la misma fuente
    fs.rmSync(path.join(dir, "opencode.json"))
    inline({ "*": "deny", glob: "allow", grep: "allow", list: "allow", skill: "allow", todowrite: "allow" })
    for (const p of ["glob", "grep", "list", "skill", "todowrite"]) expect(decide(p, "manual", { sesion: [] })).not.toBe("deny")
    for (const p of ["bash", "edit", "webfetch", "read"]) expect(decide(p, "manual", { sesion: [] })).toBe("deny")
  })
})

describe("B1-17 una sesión hostil no reabre nada", () => {
  test("`*: allow` de la sesión, y PATCH con otros allow, no abren lo negado por config o política", () => {
    inline({ bash: "deny", edit: "deny", prueba_start: "deny" })
    const politica = path.join(dir, "politica.json")
    fs.writeFileSync(politica, JSON.stringify({ version: 1, deny: { tools: ["webfetch"] } }))
    process.env.LAZUNOX_POLICY_FILE = politica
    Politica.olvidar()
    const hostil = [r("*", "*", "allow")]
    const tras = [...C.reemplazarBloqueModo(hostil, [r("bash", "*", "allow"), r("edit", "*", "allow"), r("prueba_*", "*", "allow"), r("webfetch", "*", "allow")])]
    for (const sesion of [hostil, tras, [...hostil, r("bash", "*", "allow")]])
      for (const p of ["bash", "edit", "prueba_start", "webfetch"]) expect(decide(p, null, { sesion })).toBe("deny")
  })
})

describe("B1-01 política de empresa", () => {
  test("niega aunque haya bypass; una política rota niega TODO (falla cerrado)", () => {
    const politica = path.join(dir, "politica.json")
    fs.writeFileSync(politica, JSON.stringify({ version: 1, deny: { tools: ["prueba_*", "webfetch"] } }))
    process.env.LAZUNOX_POLICY_FILE = politica
    Politica.olvidar()
    inline({ "prueba_*": "allow" })
    for (const modo of MODOS) {
      expect(decide("prueba_start", modo)).toBe("deny")
      expect(decide("webfetch", modo)).toBe("deny")
    }
    fs.writeFileSync(politica, "{roto")
    Politica.olvidar()
    for (const modo of MODOS) for (const p of ["read", "bash", "edit", "prueba_secret"]) expect(decide(p, modo)).toBe("deny")
    expect(Politica.descripcion()).toContain("no se pudo aplicar")
  })
})

describe("B1-18/B1-20 el bloque del modo se reemplaza", () => {
  test("plan → auto: no quedan reglas de plan; la lista no crece", () => {
    let s: R[] = [...C.reemplazarBloqueModo([], BLOQUE.plan!)]
    expect(s.some((x) => x.permission === "edit" && x.action === "deny")).toBe(true)
    s = [...C.reemplazarBloqueModo(s, BLOQUE.auto!)]
    expect(s.some((x) => x.action === "deny")).toBe(false)
    expect(s.some((x) => x.permission === "task" && x.pattern === "general")).toBe(false)
    const tam = s.length
    for (let i = 0; i < 40; i++) s = [...C.reemplazarBloqueModo(s, BLOQUE[MODOS[i % MODOS.length]!]!)]
    expect(s.length).toBeLessThanOrEqual(Math.max(...MODOS.map((m) => BLOQUE[m]!.length)) + 1)
    expect(tam).toBe(BLOQUE.auto!.length + 1)
  })
  test("sesión sin marca (contrato 1.8.12): replace descarta lo acumulado y deja los bloques de skill", () => {
    const viejo = [...BLOQUE.plan!, ...BLOQUE.manual!, r("lazunox_skill_inicio", "s", "allow"), r("bash", "*", "deny"), r("lazunox_skill_fin", "s", "allow")]
    const s = C.reemplazarBloqueModo(viejo, BLOQUE.auto!)
    expect(s.filter((x) => x.permission === "edit")).toEqual([r("edit", "*", "allow")])
    expect(s.some((x) => x.permission === "lazunox_skill_inicio")).toBe(true)
    // el bloque del modo queda ANTES de la skill
    expect(s.findIndex((x) => x.permission === C.MARCA_MODO)).toBeLessThan(s.findIndex((x) => x.permission === "lazunox_skill_inicio"))
  })
  test("sin permissionMode el PATCH anexa como siempre (Permission.merge)", () => {
    expect(Permission.merge(BLOQUE.plan!, BLOQUE.auto!)).toHaveLength(BLOQUE.plan!.length + BLOQUE.auto!.length)
  })
})

describe("B1-19 nada queda más abierto que una sesión nueva (25 transiciones)", () => {
  const sonda: Array<[string, string]> = [["edit", "x.txt"], ["write", "n.txt"], ["bash", "echo"], ["bash", "rm x"], ["webfetch", "*"], ["websearch", "*"], ["external_directory", "/fuera/*"], ["task", "general"], ["prueba_start", "*"], ["bgshell_start", "*"], ["documentos_crear", "*"]]
  for (const a of MODOS)
    for (const b of MODOS)
      test(`${a} -> ${b}`, () => {
        const nueva = C.reemplazarBloqueModo([], BLOQUE[b]!)
        const cambiada = C.reemplazarBloqueModo(C.reemplazarBloqueModo([], BLOQUE[a]!), BLOQUE[b]!)
        for (const [p, pat] of sonda) expect(decide(p, null, { sesion: [...cambiada], patron: pat })).toBe(decide(p, null, { sesion: [...nueva], patron: pat }))
      })
})

describe("B1-21/B1-22 bash y external_directory negados en «Todo sin preguntar»", () => {
  test("bash: deny global en bypass; bgshell_start lo sigue (D4); external_directory", () => {
    inline({ bash: "deny", external_directory: { "/tmp/fuera/*": "deny" } })
    for (const modo of MODOS) {
      expect(decide("bash", modo)).toBe("deny")
      expect(decide("bgshell_start", modo)).toBe("deny")
      expect(decide("external_directory", modo, { patron: "/tmp/fuera/f.txt" })).toBe("deny")
    }
    expect(decide("external_directory", "bypass", { patron: "/tmp/otro/f.txt" })).toBe("allow") // control
    expect(decide("external_directory", "auto", { patron: "/tmp/otro/f.txt" })).toBe("ask")
  })
})

describe("B1-26 herramientas propias de la app (D4)", () => {
  test("amplios no las niegan; explícitos sí", () => {
    for (const amplio of ["*", "*_*", "*start*", "?gshell_start"]) {
      inline({ [amplio]: "deny" })
      for (const modo of ["manual", "bypass"]) {
        for (const p of ["bgshell_start", "bgshell_status", "documentos_crear", "documentos_renderizar"]) expect(decide(p, modo)).not.toBe("deny")
      }
    }
    for (const exacto of ["bgshell_start", "bgshell_*", "documentos_*"]) {
      inline({ [exacto]: "deny" })
      expect(decide(exacto.startsWith("doc") ? "documentos_crear" : "bgshell_start", "bypass")).toBe("deny")
    }
    inline({ "bgshell_*": "deny" })
    expect(decide("bgshell_status", "manual")).toBe("deny")
    inline({ bgshell_start: "deny" })
    expect(decide("bgshell_status", "manual")).not.toBe("deny")
    inline({ write: "deny" })
    expect(decide("documentos_crear", "bypass")).toBe("deny")
    expect(decide("documentos_renderizar", "bypass")).not.toBe("deny")
    inline({ bash: "deny" })
    expect(decide("bgshell_start", "bypass")).toBe("deny")
    expect(decide("bgshell_status", "bypass")).not.toBe("deny")
  })
})

describe("B1-27/B1-28 la hija", () => {
  const general = { name: "general", native: true, mode: "subagent" as const, options: {}, permission: [r("*", "*", "allow"), r("external_directory", "*", "ask")] as R[] }
  const hijaPerm = (modo: string, parentAgent = { name: "build", permission: AGENTE_BUILD.permission }) => {
    const padre = { permission: [...C.reemplazarBloqueModo([], BLOQUE[modo]!)] }
    return permisoDeHija({ cfg: {} as never, parent: padre as never, parentAgent: parentAgent as never, next: general as never }) as R[]
  }
  const decideHija = (modo: string, permiso: string, patron = "*") => {
    const e = C.efectivo({ agent: general, session: { permission: hijaPerm(modo), directory: dir } })
    return C.decidir(e, permiso, patron).action
  }
  test("manual: la hija pregunta (nunca allow) bash/edit/webfetch; plan: edit y task general denegados; bypass igual al padre", () => {
    for (const p of ["bash", "edit", "webfetch"]) expect(decideHija("manual", p)).toBe("ask")
    expect(decideHija("plan", "edit", "x.txt")).toBe("deny")
    expect(decideHija("plan", "task", "general")).toBe("deny")
    expect(decideHija("bypass", "bash")).toBe("allow")
    expect(decideHija("acceptEdits", "edit")).toBe("allow")
    expect(decideHija("manual", "task", "x")).toBe("deny") // la nieta: task negado en hijas
  })
  test("tras «Solo explorar» el ayudante edita al pasar a Automático (sin restos de plan)", () => {
    // la sesión del padre pasó por plan y luego por auto con el contrato nuevo
    const padre = C.reemplazarBloqueModo(C.reemplazarBloqueModo([], BLOQUE.plan!), BLOQUE.auto!)
    const h = permisoDeHija({ cfg: {} as never, parent: { permission: padre } as never, parentAgent: AGENTE_BUILD as never, next: general as never }) as R[]
    const e = C.efectivo({ agent: general, session: { permission: h, directory: dir } })
    expect(C.decidir(e, "edit", "x.txt").action).toBe("allow")
    // con el contrato 1.8.12 (sin marca; anexa) la conducta de lazunox.15 se conserva (D5), también con la bandera encendida: el deny de plan se hereda
    const sinMarca = [...BLOQUE.plan!, ...BLOQUE.auto!]
    const h12 = permisoDeHija({ cfg: {} as never, parent: { permission: sinMarca } as never, parentAgent: AGENTE_BUILD as never, next: general as never }) as R[]
    expect(h12.some((x) => x.permission === "edit" && x.action === "deny")).toBe(true)
    // ...y la bandera apagada tampoco cambia nada
    process.env.LAZUNOX_PERMISOS_CAPAS = "0"
    const viejo = [...BLOQUE.plan!, ...BLOQUE.auto!]
    const h15 = deriveSubagentSessionPermission({ parentSessionPermission: viejo, subagent: general as never }) as R[]
    expect(h15.some((x) => x.permission === "edit" && x.action === "deny")).toBe(true)
  })
  test("la hija hereda los deny de la capa agente del padre y de la config", () => {
    inline({ bash: { "rm *": "deny" }, prueba_secret: "deny" }, { build: { permission: { prueba_start: "deny" } } })
    for (const modo of ["manual", "bypass"]) {
      expect(decideHija(modo, "prueba_start")).toBe("deny")
      expect(decideHija(modo, "bash", "rm x")).toBe("deny")
      expect(decideHija(modo, "prueba_secret")).toBe("deny")
    }
  })
  test("agente de usuario con allow total sigue topado por el padre", () => {
    const fuerte = { ...general, name: "fuerte", native: false, permission: [r("*", "*", "allow"), r("bash", "*", "allow"), r("edit", "*", "allow")] as R[] }
    const padre = { permission: [...C.reemplazarBloqueModo([], BLOQUE.manual!)] }
    const h = permisoDeHija({ cfg: {} as never, parent: padre as never, parentAgent: AGENTE_BUILD as never, next: fuerte as never }) as R[]
    const e = C.efectivo({ agent: fuerte, session: { permission: h, directory: dir } })
    expect(C.decidir(e, "bash", "echo").action).toBe("ask")
    expect(C.decidir(e, "edit", "x.txt").action).toBe("ask")
  })
})

describe("B1-26 disabled()", () => {
  test("el piso oculta la herramienta; un allow de otra fuente no la devuelve", () => {
    inline({ prueba_start: "deny" })
    escribir("opencode.json", { permission: { prueba_start: "allow" } })
    const e = C.efectivo({ agent: AGENTE_BUILD, session: { permission: BLOQUE.bypass, directory: dir } })
    expect(Permission.disabled(["prueba_start", "prueba_secret", "bash"], e).has("prueba_start")).toBe(true)
    expect(Permission.disabled(["prueba_secret"], e).size).toBe(0)
    // con ruleset plano (sin capas) todo sigue igual que antes
    expect(Permission.disabled(["prueba_start"], Permission.merge(AGENTE_BUILD.permission, BLOQUE.bypass!)).size).toBe(0)
  })
})

// B1-33: propiedad con semilla fija. Oráculo independiente de capas.ts (D1+D2+D3+D4); la propiedad dura (si hay un `deny` de config que casa, es deny)
// se comprueba además sin oráculo, mirando solo la configuración generada.
describe("B1-33 propiedad con semilla fija", () => {
  const SEMILLA = Number(process.env.PROBE_SEED ?? 20261109)
  test(`200 configuraciones (semilla ${SEMILLA})`, () => {
    let s = SEMILLA >>> 0
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296)
    const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)]!
    const HERR = ["prueba_start", "bash", "edit", "webfetch", "bgshell_start"]
    const CLAVES = [...HERR, "prueba_*", "*", "*start*", "BASH", "bgshell_*", "write"]
    const ACC = ["allow", "ask", "deny"] as const
    const rx = (k: string, flags = "") => new RegExp("^" + k.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", flags)
    const literal = (k: string) => k.toLowerCase().split(/[*?]/)[0]!
    for (let caso = 0; caso < 200; caso++) {
      const g: R[] = [], c: R[] = [], a: R[] = []
      for (const lista of [g, c, a]) for (let i = 0, n = Math.floor(rnd() * 3); i < n; i++) lista.push(r(pick(CLAVES), "*", pick([...ACC])))
      const modo = pick(MODOS)
      const aj = (rs: R[]) => Object.entries(Object.fromEntries(rs.map((x) => [x.permission, x.action]))) as Array<[string, string]>
      fs.rmSync(path.join(dir, "opencode.json"), { force: true })
      process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ permission: Object.fromEntries(aj(g)), agent: { build: { permission: Object.fromEntries(aj(a)) } } })
      if (c.length) escribir("opencode.json", { permission: Object.fromEntries(aj(c)) })
      // capas: cada fuente (la del agente con su bloque) y la config mezclada como el motor (cada clave: primer lugar, último valor)
      const mezcla = new Map<string, string>()
      for (const [k, v] of [...aj(g), ...aj(c)]) mezcla.set(k, v)
      const mezclaAgente = [...mezcla, ...aj(a)] // el bloque del agente va DESPUÉS de lo general, sin fundirse con sus claves
      const capas = [[...aj(g), ...aj(a)], ...(c.length ? [aj(c)] : []), ...((g.length || a.length) && c.length ? [mezclaAgente] : [])]
      const niegaConfig = (h: string) =>
        capas.some((capa) => {
          const propia = /^(bgshell_|documentos_)/.test(h)
          const ult = (p: string, nombrada: boolean) =>
            capa.filter(([k]) => rx(k.toLowerCase()).test(p) && (nombrada ? literal(k) === p : propia ? literal(k).startsWith("bgshell_") : true)).at(-1)?.[1]
          return ult(h, false) === "deny" || (h === "bgshell_start" && ult("bash", true) === "deny")
        })
      const e = C.efectivo({ agent: AGENTE_BUILD, session: { permission: BLOQUE[modo]!, directory: dir } })
      for (const h of HERR) {
        const real = C.decidir(e, h, "*").action
        const plano = [...AGENTE_BUILD.permission, ...BLOQUE[modo]!].findLast((x) => rx(x.permission).test(h) && rx(x.pattern).test("*"))?.action ?? "ask"
        if (niegaConfig(h)) expect(real, `semilla ${SEMILLA} caso ${caso} ${h} modo ${modo} g=${JSON.stringify(g)} c=${JSON.stringify(c)} a=${JSON.stringify(a)}`).toBe("deny")
        else expect(real, `semilla ${SEMILLA} caso ${caso} ${h} modo ${modo}`).toBe(plano)
      }
    }
  })
})
