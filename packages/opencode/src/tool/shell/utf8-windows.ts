// Lazunox: en Windows PowerShell 5 escribe en la página de códigos del sistema (cp850/1252) y el motor lee UTF-8, así que «áéíóú ñ»
// llegaba como «�». Se antepone al comando lo mínimo para que escriba UTF-8 (probado en el PC de pruebas). Bash/zsh/Git Bash no cambian.
// Solo toca lo que se EJECUTA: el análisis de permisos sigue viendo el comando original.
// `cmd` NO se arregla así: sin consola, `chcp 65001` cambia la página pero `echo` sigue saliendo en cp850 (probado). El motor solo cae en
// `cmd` cuando no hay Git Bash ni PowerShell; queda como límite conocido.
const PS = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; "

export function utf8Command(_shell: string, command: string, isPowerShell: boolean, platform: NodeJS.Platform = process.platform) {
  if (platform !== "win32") return command
  if (isPowerShell) return PS + command
  return command
}
