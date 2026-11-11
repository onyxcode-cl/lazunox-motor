// Lazunox (motor-18, E): la orden de shell de la sesión y `!cmd` dan lo mismo que ejecutar el comando directamente en esa shell
// (antes la shell exterior expandía `$(…)`, comillas invertidas y `$var` antes del eval).
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Shell } from "@opencode-ai/core/shell"

const COMANDOS = [
  "echo $(echo hola)",
  "echo `echo comillas-invertidas`",
  'echo "$HOME"',
  "d=$(mktemp -d); test -d \"$d\" && echo existe; rm -rf \"$d\"",
  `echo 'simples "dobles dentro"' "dobles 'simples dentro'"`,
  "echo uno; echo dos",
  "echo linea1\necho linea2",
  `printf '%s\\n' "it's" 'di "hola"' "mezcla '\\"' fin"`,
  "x=5; echo $((x + 1)) ${x}",
]

const shells = ["/bin/bash", "/bin/zsh"].filter((s) => process.platform !== "win32" && fs.existsSync(s))

describe("Shell.args: eval del comando sin expansión previa", () => {
  for (const sh of shells) {
    test(`${path.basename(sh)}: mismo resultado que ejecutarlo directamente`, () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "lzx-m18-e-home-"))
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lzx-m18-e-cwd-"))
      const env = { PATH: process.env.PATH!, HOME: home, ZDOTDIR: home, LANG: "C" }
      for (const cmd of COMANDOS) {
        const via = Bun.spawnSync({ cmd: [sh, ...Shell.args(sh, cmd, cwd)], cwd: os.tmpdir(), env })
        const directo = Bun.spawnSync({ cmd: [sh, "-c", cmd], cwd, env })
        expect([cmd, via.stdout.toString()]).toEqual([cmd, directo.stdout.toString()])
        expect(via.exitCode).toBe(0)
      }
      expect(Bun.spawnSync({ cmd: [sh, ...Shell.args(sh, "echo $(echo hola)", cwd)], env }).stdout.toString()).toBe("hola\n")
      expect(Bun.spawnSync({ cmd: [sh, ...Shell.args(sh, "pwd -P", cwd)], env }).stdout.toString().trim()).toBe(fs.realpathSync(cwd))
      fs.rmSync(home, { recursive: true, force: true })
      fs.rmSync(cwd, { recursive: true, force: true })
    })
  }
  test("fish, nu, sh, cmd y PowerShell no cambian", () => {
    expect(Shell.args("/usr/bin/fish", "echo $(x)", "/tmp")).toEqual(["-c", "echo $(x)"])
    expect(Shell.args("/bin/sh", "echo hi", "/tmp")).toEqual(["-c", "echo hi"])
  })
})
