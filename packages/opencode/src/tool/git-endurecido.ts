// Lazunox (lazunox.15, ronda 2): endurecimiento mínimo y reversible del entorno de git del shell del agente.
//
// Un repositorio «desnudo» falso (HEAD, config con `core.fsmonitor=<comando>`, objects/, refs/ escritos sin carpeta `.git`) hace que un
// `git status` aprobado ejecute ese comando. Con la configuración por entorno (la de mayor precedencia, por encima de la del repo):
//  - `safe.bareRepository=explicit`: git no trata una carpeta con pinta de repositorio desnudo como tal salvo que se le indique con --git-dir.
//  - `core.fsmonitor=false`: nunca ejecuta un monitor de archivos que declare la configuración del repo.
// NO se toca `core.hooksPath` (los hooks legítimos del usuario siguen funcionando). Se suma a un GIT_CONFIG_COUNT que ya exista.
// Costo conocido: `cd repo.git && git log` (repositorio desnudo legítimo sin --git-dir) deja de funcionar; y quien use fsmonitor propio
// lo pierde dentro del shell del agente. Apagable con LAZUNOX_GIT_ENDURECIDO=0.

export const activo = (env: NodeJS.ProcessEnv = process.env) => env.LAZUNOX_GIT_ENDURECIDO !== "0"

export function endurecer(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!activo()) return env
  const previo = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10)
  const n = Number.isFinite(previo) && previo >= 0 ? previo : 0
  return {
    ...env,
    GIT_CONFIG_COUNT: String(n + 2),
    [`GIT_CONFIG_KEY_${n}`]: "safe.bareRepository",
    [`GIT_CONFIG_VALUE_${n}`]: "explicit",
    [`GIT_CONFIG_KEY_${n + 1}`]: "core.fsmonitor",
    [`GIT_CONFIG_VALUE_${n + 1}`]: "false",
  }
}
