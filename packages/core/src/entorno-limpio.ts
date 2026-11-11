// Lazunox (motor-18, A): «entorno limpio» para TODOS los procesos hijos que lanza el motor.
//
// El `process.env` del motor lo arma la app y lleva secretos que solo el motor necesita: OPENCODE_SERVER_PASSWORD/USERNAME,
// OPENCODE_CONFIG_CONTENT (con URLs y tokens de las rutas del proxy MCP y del proxy de credenciales), OPENCODE_AUTH_CONTENT,
// LAZUNOX_GUARD_*, LAZUNOX_PLAN_GATE_URL… Antes solo el shell y el pty los veían vacíos (complemento `lazunox-env` de la app);
// LSP, formateadores, MCP locales, `!cmd`, ganchos, git, ripgrep y el guion del worktree heredaban TODO.
//
// Regla (lista NEGRA por familias, sobre un entorno que la app ya arma con lista BLANCA: `minimalEnv` en la app):
//  - fuera toda variable `OPENCODE_*` y `LAZUNOX_*`, salvo unas pocas rutas que la app pasa A PROPÓSITO para los comandos de la
//    persona y que no son secretas (`LAZUNOX_PYTHON`, `LAZUNOX_BIN_DIR`, `LAZUNOX_NODE`, `LAZUNOX_CHROMIUM`, las de ArtCraft);
//  - fuera las claves de servicios de IA conocidas y cualquier nombre con forma de credencial (`*_API_KEY`, `*_TOKEN`, `*_SECRET`,
//    `*PASSWORD*`, `*_ACCESS_KEY*`, `*_PRIVATE_KEY`, `*_CREDENTIALS`…);
//  - (H) también se quita una variable cuyo VALOR tiene forma de secreto (clave PEM, tokens de GitHub/GitLab/Google/AWS/Stripe/Slack,
//    claves sk-…, JWT, usuario:clave en una URL), salvo las exentas (PATH, HOME, SSH_AUTH_SOCK, GPG_TTY, proxies, certificados,
//    XDG_*) y las del proyecto que la app nombre en LAZUNOX_VARIABLES_PROYECTO;
//  - todo lo demás pasa (PATH, HOME, TMPDIR, LANG/LC_*, TERM, proxies HTTP(S)_PROXY/NO_PROXY/NODE_USE_ENV_PROXY, XDG_*, GIT_AUTHOR_*…).
// Por qué lista negra y no blanca: el motor también corre fuera de la app (desarrollo, pruebas, Windows/WSL) y sus hijos son herramientas
// generales (LSP, formateadores, compiladores) que necesitan variables que no se pueden enumerar (JAVA_HOME, GOPATH, CARGO_HOME,
// SystemRoot, PATHEXT…). Dentro de la app el entorno de partida ya es una lista blanca, así que la lista negra por familias deja, en la
// práctica, solo lo del sistema más lo que la app pasa a propósito.
//
// Lo que un llamador añade A PROPÓSITO encima (p. ej. `LAZUNOX_HOOK=1`, `OPENCODE_TERMINAL=1`, el `environment` de un MCP, lo que agrega
// el complemento `shell.env`) se respeta, SALVO que sea una variable secreta copiada tal cual del entorno del motor (mismo nombre y mismo
// valor): esa es la forma de `{...process.env, X: 1}` y se quita igual (red de seguridad para llamadores que copian el entorno entero).
//
// Interruptor: LAZUNOX_ENTORNO_LIMPIO=0|off|false vuelve al comportamiento de antes. Encendido por defecto.

/** Lista de la app (`HIDDEN_SHELL_ENV`, `src/main/tasks/hidden-env.ts`). Se conserva para la prueba de huella; ya la cubren las familias. */
export const OCULTAS_DEL_MOTOR = [
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_SERVER_USERNAME",
  "OPENCODE_AUTH_CONTENT",
  "OPENCODE_CONFIG_CONTENT",
  "LAZUNOX_PLAN_GATE_URL",
  "LAZUNOX_GUARD_URL",
  "LAZUNOX_GUARD_TOKEN",
] as const

/** Familias que nunca se reenvían a un hijo. */
export const PREFIJOS_OCULTOS = ["OPENCODE_", "LAZUNOX_"] as const

/**
 * Excepciones de las familias: rutas que la app pasa a propósito para los comandos de la persona (las skills de oficina las leen desde el
 * shell: `$LAZUNOX_PYTHON`, `$LAZUNOX_BIN_DIR`…). No son secretos: son rutas de programas incluidos.
 */
export const LAZUNOX_PARA_HIJOS = [
  "LAZUNOX_PYTHON",
  "LAZUNOX_BIN_DIR",
  "LAZUNOX_NODE",
  "LAZUNOX_CHROMIUM",
  "LAZUNOX_DECKCRAFT",
  "LAZUNOX_WORDCRAFT",
  "LAZUNOX_GRIDCRAFT",
] as const

/**
 * Nombres con forma de credencial: `X_API_KEY`, `X_APIKEY`, `X_TOKEN(S)`, `X_SECRET`, `X_PASSWORD`, `X_ACCESS_KEY_ID`, `X_PRIVATE_KEY`…
 * Cubre las claves de servicios de IA (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN,
 * AWS_BEARER_TOKEN_BEDROCK, GOOGLE_APPLICATION_CREDENTIALS, HF_TOKEN…) y tokens en general (GITHUB_TOKEN, NPM_TOKEN…).
 */
const FORMA_DE_CREDENCIAL =
  /(^|_)(API_?KEYS?|TOKENS?|SECRETS?|SECRET_KEY|PASSWORD|PASSWD|PASSPHRASE|ACCESS_KEY(_ID)?|PRIVATE_KEY|CREDENTIALS?|CREDS|AUTH|AUTH_CONTENT|SESSION_KEY|PRIVATE|KEY)($|_)|PASSWORD|PASSWD/

/**
 * Lazunox (motor-18, H; idea de Gemini CLI, services/environmentSanitization.ts: filtrar también por VALOR; listas y expresiones
 * propias, no copiadas). Valores con forma de secreto, aunque el nombre sea inocente.
 */
const VALORES_SECRETOS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // clave privada PEM
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/, // GitLab
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/, // AWS (fija y temporal)
  /\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}/, // Stripe
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/, // Slack
  /\bsk-(ant-|proj-)?[A-Za-z0-9_-]{20,}/, // claves estilo OpenAI/Anthropic
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // JWT
  /^[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i, // usuario:clave dentro de una URL
]

/**
 * Nunca se filtran por nombre ni por valor (sí por familia OPENCODE_/LAZUNOX_): lo que los programas necesitan para funcionar. Los proxies
 * llevan a propósito el token del proxy de salida de la jaula en la URL; los certificados son públicos.
 */
const EXENTAS = new Set([
  "PATH",
  "HOME",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GPG_TTY",
  "GPG_AGENT_INFO",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "NODE_USE_ENV_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "KEYTIMEOUT",
])

/** Variables del PROYECTO que la app pasa a propósito (nombres en LAZUNOX_VARIABLES_PROYECTO, separados por comas): no se filtran por forma. */
const delProyecto = (flags: NodeJS.ProcessEnv = process.env) =>
  new Set((flags.LAZUNOX_VARIABLES_PROYECTO ?? "").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean))

const exenta = (n: string, flags: NodeJS.ProcessEnv = process.env) => EXENTAS.has(n) || n.startsWith("XDG_") || delProyecto(flags).has(n)

/** ¿Es una variable que ningún hijo debe ver, por su NOMBRE? Sin distinguir mayúsculas (en Windows los nombres no las distinguen). */
export function nombreOculto(nombre: string, flags: NodeJS.ProcessEnv = process.env): boolean {
  const n = nombre.toUpperCase()
  if ((LAZUNOX_PARA_HIJOS as readonly string[]).includes(n)) return false
  if (PREFIJOS_OCULTOS.some((p) => n.startsWith(p))) return true
  if (exenta(n, flags)) return false
  return FORMA_DE_CREDENCIAL.test(n)
}

/** ¿Tiene el VALOR forma de secreto? */
export function valorSecreto(valor: string): boolean {
  return VALORES_SECRETOS.some((r) => r.test(valor))
}

/** Nombre o valor: ¿se oculta? */
export function oculta(nombre: string, valor: string | undefined, flags: NodeJS.ProcessEnv = process.env): boolean {
  if (nombreOculto(nombre, flags)) return true
  const n = nombre.toUpperCase()
  if ((LAZUNOX_PARA_HIJOS as readonly string[]).includes(n) || exenta(n, flags)) return false
  return valor !== undefined && valorSecreto(valor)
}

/** Interruptor `LAZUNOX_ENTORNO_LIMPIO`: ausente o cualquier valor = encendido; apagan "0", "off" y "false". */
export function entornoLimpioActivo(flags: NodeJS.ProcessEnv = process.env): boolean {
  const v = flags.LAZUNOX_ENTORNO_LIMPIO?.trim().toLowerCase()
  return !(v === "0" || v === "off" || v === "false")
}

/** Copia de `base` sin las variables ocultas (apagado: copia exacta). Los valores `undefined` se descartan. */
export function entornoLimpio(
  base: NodeJS.ProcessEnv = process.env,
  flags: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const activo = entornoLimpioActivo(flags)
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (v !== undefined && (!activo || !oculta(k, v, flags))) env[k] = v
  return env
}

/** Valor de `nombre` en `base` sin distinguir mayúsculas en Windows. */
function valorEn(base: NodeJS.ProcessEnv, nombre: string): string | undefined {
  if (process.platform !== "win32") return base[nombre]
  const k = Object.keys(base).find((x) => x.toUpperCase() === nombre.toUpperCase())
  return k === undefined ? undefined : base[k]
}

/**
 * Lo que el llamador pasa a propósito, sin las variables secretas copiadas tal cual del entorno del motor (mismo nombre y mismo valor).
 * Un valor distinto (p. ej. `''` del complemento `lazunox-env`, `LAZUNOX_HOOK=1`) se respeta.
 */
export function extraSinCopias(
  extra: NodeJS.ProcessEnv | undefined,
  base: NodeJS.ProcessEnv = process.env,
  flags: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {}
  if (!extra) return env
  const activo = entornoLimpioActivo(flags)
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) continue
    if (activo && oculta(k, v, flags) && v !== "" && valorEn(base, k) === v) continue
    env[k] = v
  }
  return env
}

/**
 * Entorno FINAL para un hijo, en el formato de Node (`spawn(..., { env })`):
 * - `heredar` (equivale a `extendEnv: true`, o a no pasar `env`): entorno limpio del motor + extras.
 * - sin heredar: solo los extras (que ya traen su base), sin las copias secretas.
 * Apagado: exactamente lo de antes (`{...process.env, ...extra}` o `extra`).
 */
export function entornoParaHijo(
  extra: NodeJS.ProcessEnv | undefined,
  heredar: boolean,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (!entornoLimpioActivo(base)) {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(heredar ? { ...base, ...extra } : (extra ?? {}))) if (v !== undefined) env[k] = v
    return env
  }
  return { ...(heredar ? entornoLimpio(base, base) : {}), ...extraSinCopias(extra, base, base) }
}

/**
 * Opciones `{ env, extendEnv }` para `ChildProcess.make` ya resueltas: entorno limpio + `extra`, con `extendEnv: false`.
 * (El spawner de core ya filtra; esto sirve a quien quiera el entorno armado de antemano.)
 */
export function opcionesDeEntorno(
  extra: Record<string, string> | undefined,
  base: NodeJS.ProcessEnv = process.env,
): { env: Record<string, string>; extendEnv: false } {
  return { env: entornoParaHijo(extra, true, base), extendEnv: false }
}
