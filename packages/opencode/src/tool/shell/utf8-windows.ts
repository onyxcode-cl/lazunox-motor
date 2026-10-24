import path from "node:path"

// Lazunox: en Windows `cmd` y Windows PowerShell 5 escriben en la página de códigos del sistema (cp850/1252) y el motor lee UTF-8,
// así que «áéíóú ñ» llegaba como «�». Se antepone al comando lo mínimo para que ese shell escriba UTF-8. Bash/zsh/Git Bash no cambian.
// Solo toca lo que se EJECUTA: el análisis de permisos sigue viendo el comando original.
const PS = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; "
const CMD = "chcp 65001>nul & "

export function utf8Command(shell: string, command: string, isPowerShell: boolean, platform: NodeJS.Platform = process.platform) {
  if (platform !== "win32") return command
  if (isPowerShell) return PS + command
  if (path.win32.parse(shell).name.toLowerCase() === "cmd") return CMD + command
  return command
}
