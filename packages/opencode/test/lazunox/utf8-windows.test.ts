import { describe, expect, test } from "bun:test"
import { utf8Command } from "../../src/tool/shell/utf8-windows"

describe("utf8Command (Windows)", () => {
  test("cmd no se toca (el cambio de página de códigos no funciona sin consola)", () => {
    expect(utf8Command("C:\\Windows\\System32\\cmd.exe", "echo áéíóú ñ", false, "win32")).toBe("echo áéíóú ñ")
  })
  test("PowerShell: fija la codificación de salida a UTF-8 sin BOM", () => {
    const out = utf8Command("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "Write-Output 'ñ'", true, "win32")
    expect(out).toContain("[Console]::OutputEncoding")
    expect(out).toContain("UTF8Encoding]::new($false)")
    expect(out.endsWith("Write-Output 'ñ'")).toBe(true)
  })
  test("Git Bash y otros shells no se tocan", () => {
    expect(utf8Command("C:\\Program Files\\Git\\bin\\bash.exe", "echo ñ", false, "win32")).toBe("echo ñ")
  })
  test("fuera de Windows nunca se toca nada", () => {
    expect(utf8Command("/bin/zsh", "echo ñ", false, "darwin")).toBe("echo ñ")
    expect(utf8Command("/bin/bash", "echo ñ", true, "linux")).toBe("echo ñ")
  })
})
