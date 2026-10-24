import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { TrabajosDisco } from "../../src/tool/shell/trabajos-disco"

// Lazunox: un marcador es un archivo en disco y se puede forjar (p. ej. desde un comando dentro del sandbox).
// `puedeMatarse` es la última barrera antes de `kill(-pid)`: estos casos NUNCA deben pasar.
const base = { enginePid: 999_999, cmdline: "/bin/zsh -c sleep 1000" }

describe("barrido de huérfanos: marcadores forjados", () => {
  test("el proceso 1, el propio motor y su padre nunca se matan", () => {
    expect(TrabajosDisco.puedeMatarse({ ...base, pid: 1 })).toBe(false)
    expect(TrabajosDisco.puedeMatarse({ ...base, pid: 0 })).toBe(false)
    expect(TrabajosDisco.puedeMatarse({ ...base, pid: -1 })).toBe(false)
    expect(TrabajosDisco.puedeMatarse({ ...base, pid: process.pid })).toBe(false)
    expect(TrabajosDisco.puedeMatarse({ ...base, pid: process.ppid })).toBe(false)
  })

  test("valores que no son enteros o sin línea de comandos se rechazan", () => {
    expect(TrabajosDisco.puedeMatarse({ ...base, pid: 1.5 })).toBe(false)
    expect(TrabajosDisco.puedeMatarse({ ...base, pid: Number.NaN })).toBe(false)
    expect(TrabajosDisco.puedeMatarse({ ...base, pid: 12345, cmdline: "" })).toBe(false)
    expect(TrabajosDisco.puedeMatarse({ ...base, pid: 12345, enginePid: 1 })).toBe(false)
  })

  test("una aplicación de escritorio (.app/Contents) no se mata aunque la línea coincida", () => {
    const hijo = spawn("sleep", ["303"], { detached: true, stdio: "ignore" })
    try {
      expect(TrabajosDisco.puedeMatarse({ ...base, pid: hijo.pid!, cmdline: "/Applications/Lazunox.app/Contents/MacOS/Lazunox" })).toBe(false)
    } finally {
      hijo.kill("SIGKILL")
    }
  })

  test("un proceso que NO es líder de su grupo no se mata; uno que sí lo es, sí puede", () => {
    const lider = spawn("sleep", ["304"], { detached: true, stdio: "ignore" })
    const noLider = spawn("sleep", ["305"], { stdio: "ignore" })
    try {
      expect(TrabajosDisco.puedeMatarse({ ...base, pid: lider.pid!, cmdline: TrabajosDisco.cmdlineOf(lider.pid!) })).toBe(true)
      expect(TrabajosDisco.puedeMatarse({ ...base, pid: noLider.pid!, cmdline: TrabajosDisco.cmdlineOf(noLider.pid!) })).toBe(false)
    } finally {
      lider.kill("SIGKILL")
      noLider.kill("SIGKILL")
    }
  })
})
