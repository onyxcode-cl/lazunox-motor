# Motor de Lazunox (base congelada de OpenCode 1.19.0)

Este repositorio es el **motor de [Lazunox](https://github.com/onyxcode-cl/onyxcode-desktop)**: una copia de [OpenCode](https://github.com/anomalyco/opencode) en su versión
`v1.19.0` (commit `733b2c627e5aec39cb33cc22373bdce33053ef2c`) con cambios propios encima. Proyecto independiente, **no afiliado a OpenCode ni a Anthropic**.

## Licencia

OpenCode es software libre bajo licencia **MIT** (`LICENSE`, «Copyright (c) 2025 opencode»). Ese aviso y ese texto se conservan intactos, como exige la licencia.
Nuestros cambios se publican bajo la misma licencia. Las marcas «OpenCode» y «opencode» pertenecen a sus titulares.

## Cómo está organizado

- La rama `main` empieza en el commit **sin modificar** de OpenCode (etiqueta `upstream-v1.19.0`). Todo lo nuestro va **encima**, en commits propios, para que se pueda ver y revisar
  qué cambiamos respecto al original (`git diff upstream-v1.19.0..main`).
- **Base congelada.** No se sigue automáticamente a OpenCode. Los arreglos de seguridad y de proveedores que publiquen se portan a mano, **commit por commit**, con revisión.
- Compilación (Bun 1.3.14, `python3` y `build-essential` para el módulo nativo `tree-sitter-powershell`) y pruebas: ver `docs/FORK-MOTOR-PASO-2.md` en el repositorio de Lazunox
  (compilación repetible byte a byte, test de contrato de la app y 27 comprobaciones de seguridad contra el motor real).

## Conexiones a internet (paso 3.1, hecho)

Quitado o apagado por defecto (la prueba `packages/opencode/test/lazunox/sin-red-de-opencode.test.ts` falla si vuelve a aparecer un servidor de OpenCode):

| Antes | Ahora |
|---|---|
| `Installation.latest/upgrade/upgradeMajor` consultaban `opencode.ai`, GitHub, npm, brew, choco, scoop y ejecutaban el instalador | No consultan nada; `latest` devuelve la versión instalada y `upgrade*` se niegan. El motor se actualiza con la app |
| `share-next` subía sesiones a `opncd.ai` | Compartir desactivado siempre |
| Sin interfaz web embebida, el servidor reenviaba a `app.opencode.ai` | Responde 404, sin petición saliente |
| Catálogo de modelos desde `models.opencode.ai` | Desde `models.dev` (catálogo público; la app además usa su copia local) |
| Descarga automática de servidores LSP | Apagada por defecto (`OPENCODE_DISABLE_LSP_DOWNLOAD=0` la enciende) |
| Cabeceras `HTTP-Referer: https://opencode.ai/` a OpenRouter, Kilo, Vercel… | Apuntan a este repositorio |

Se conserva a propósito: el proveedor **OpenCode Zen** (modelos gratuitos, `plugin/provider/opencode.ts`), la búsqueda web de Exa/Parallel (la gobierna el proxy de Lazunox),
los comandos de la CLI que el motor embebido nunca ejecuta (`github`, `account`, `import`) y los textos `$schema` (ayuda del editor; el motor no los descarga).

## Code Mode (paso 4)

- **Límites por defecto** (OpenCode no pone ninguno): 10 min, 1000 llamadas y 5 MB de salida por script. Se cambian con `LAZUNOX_CODE_MODE_TIMEOUT_MS`, `LAZUNOX_CODE_MODE_MAX_TOOL_CALLS` y `LAZUNOX_CODE_MODE_MAX_OUTPUT_BYTES`. Al llegar a un límite lo ya ejecutado no se deshace y el error le dice al modelo qué obtuvo.
- **Pausa y espera** (idea de Codex): `execute` acepta `yield_ms` (30 s por defecto, máximo 50 s; `execute_wait` hasta 5 min). Si el script tarda más, sigue vivo en segundo plano y `execute` devuelve un `cell_id`; la herramienta nueva `execute_wait` espera más, lee el resultado o lo termina (`terminate: true`). Hasta 3 celdas vivas a la vez (`LAZUNOX_CODE_MODE_MAX_CELLS`). Las llamadas internas usan una señal de cancelación propia (la del turno se dispara al terminar la respuesta del modelo).
- Pruebas: `packages/codemode/test/lazunox-limites.test.ts`, `packages/opencode/test/tool/code-mode.test.ts` (sección «pausa y espera») y las del `engine-probe` de Lazunox.

## Búsqueda diferida de herramientas MCP (`tool_search` + `mcp_call`)

- **Qué hace**: con muchos conectores, las definiciones MCP (descripción + esquema) ya no viajan en cada petición. Salen de la lista y entran dos herramientas fijas: `tool_search { query, limit? }` (texto libre o `select:a,b`; devuelve nombre, descripción y esquema, tope 16 KB, máx. 10; su descripción lleva el índice `servidor (N): nombres`) y `mcp_call { tool, arguments }`. La lista de herramientas no cambia entre pasos, así que el caché del prompt se conserva. Con Code Mode encendido no se activa (ya tiene su propia búsqueda).
- **Variables**: `LAZUNOX_TOOL_SEARCH=auto|on|off` (**ausente = `off`**: la app envía `auto` explícitamente solo en Chat y Code; con `auto` se activa si las definiciones diferibles visibles suman >= `LAZUNOX_TOOL_SEARCH_MIN_TOKENS`, 4000, caracteres/4); `LAZUNOX_TOOL_SEARCH_KEEP` (servidores que nunca se difieren, p. ej. `browser,computer,bgshell`). Interruptor de emergencia: `LAZUNOX_TOOL_SEARCH=off`.
- **Un solo camino** (`mcp/invocar.ts`, `McpInvocar.run`): la llamada directa y `mcp_call` ejecutan igual: gancho `tool.execute.before` con la clave REAL `servidor_herramienta` y el MISMO objeto `args` que va a `callTool` (los ganchos lo mutan en sitio), `ctx.ask({ permission: <clave real> })`, ejecución, `tool.execute.after`. `mcp_call` no dispara ganchos con su propio nombre. `run` acepta `onCall(fase, llamada)` opcional (no-op; lo usarán los formularios MCP).
- **`mcp_call` no puede saltarse nada**: en cada llamada recalcula el catálogo con las reglas del agente y de la sesión (`Permission.visibleTools`) y `user.tools` del mensaje (`SessionTools.resolve` recibe `userTools`); coincidencia exacta y sensible a mayúsculas; si el nombre no está, no se ejecuta y se sugieren parecidos. Una herramienta con regla `deny` propia, oculta por `user.tools=false` o por `*: deny` no aparece en `tool_search` ni se llama. Los servidores de `KEEP` siguen directos y `mcp_call` los rechaza. Comprueba `required` y tipos de primer nivel (el servidor sigue validando).
- **`Permission.disabled`**: `tool_search` y `mcp_call` no se ocultan por un `*: deny` genérico (su contenido ya viene filtrado); solo por una regla con su nombre exacto. Si el catálogo diferido queda vacío no se añaden.
- **Reparación** (`session/llm.ts`): si el modelo llama directo a una herramienta que no está en la lista y `mcp_call` existe, la llamada se reescribe a `mcp_call` (`ToolSearch.rewriteDirectCall`), que vuelve a comprobar todo.
- **Interfaz**: el resultado de `mcp_call` lleva `title = <clave real>` y `metadata.lazunoxMcp = { tool, server }`; el de `tool_search`, `metadata = { query, matches, total }`.
- Puntuación léxica copiada de `packages/codemode/src/tool-runtime.ts` (mismo repositorio, MIT). Pruebas: `test/lazunox/mcp-invocar.test.ts`, `test/lazunox/tool-search.test.ts`.

## Formularios MCP (`elicitation/create`, modo formulario) - fase B1

Base interna, **todavía sin conectar** al cliente MCP (no hay cambio observable; la conexión es la fase B2, tras `mcp/invocar.ts`). Plan: `docs/PLAN-HERRAMIENTAS-DIFERIDAS-Y-FORMULARIOS-MCP.md` de la app.

- `mcp/elicitation-esquema.ts` (funciones puras): valida el esquema pedido por el servidor (subconjunto plano: texto con `format` email/uri/date/date-time, número, entero, booleano, `enum`/`oneOf`; <= 20 campos, título 120, descripción 500, mensaje 2000, solicitud 16 KB, <= 50 opciones, texto <= 4000), detecta campos secretos (contraseña, clave, token, API key, PIN, CVV, tarjeta, IBAN, OTP, 2FA, código de verificación; español e inglés; `format: password`) y valida la respuesta. Los errores solo llevan nombres de campo, nunca valores. Variables: `LAZUNOX_MCP_ELICITATION=1` (`elicitacionActiva`) y `LAZUNOX_ELICITATION_TIMEOUT_MS` (defecto 600000, tope 3600000).
- `mcp/elicitation.ts` (`McpElicitation`): `ask` (nunca falla; devuelve `accept`/`decline`/`cancel` para el servidor), `reply`, `cancelSession`, `finishCall`, `list`. A diferencia de `Question`, **todo cierre que no es una respuesta publica `mcp.elicitation.rejected`** (tiempo, aborto de la llamada, cancelación del servidor, fibra interrumpida, cierre de la instancia, esquema o secreto rechazados). Un pendiente por servidor y sesión; 5 formularios por llamada. Ni registros ni eventos llevan valores.
- Eventos en `packages/schema/src/mcp-event.ts`: `mcp.elicitation.asked|replied|rejected` (3 más en el inventario público; `event-manifest.test.ts` pasa de 88 a 91). Los archivos generados del SDK (`packages/sdk`) no se regeneraron: la app usa `fetch` crudo.
- Pruebas: `packages/opencode/test/lazunox/mcp-elicitation.test.ts`.

## Formularios MCP - fase B2 (conectados al cliente MCP)

Con `LAZUNOX_MCP_ELICITATION=1` los formularios de los conectores llegan a la app; **sin la variable no cambia nada** (el servidor no ve la capacidad, el `timeout` de las llamadas lo corta el SDK como antes). Interruptor de emergencia: quitar la variable.

- **Capacidad** (`mcp/index.ts`): se anuncia `elicitation: { form: {} }` solo con la variable (el modo `url` no se anuncia; si llegara una solicitud `url` se responde `decline`). El manejador `ElicitRequestSchema` se registra por cliente en `watch`.
- **Atribución** (`mcp/en-curso.ts`): registro de llamadas MCP vivas **por cliente** (servidor y carpeta). Lo alimentan `McpInvocar.run` (llamada directa y `mcp_call`) y `invokeChildTool` de Code Mode mediante `conLlamadaViva` (entrar/salir siempre, también con error o aborto). Una solicitud se atribuye a la sesión de las llamadas vivas de ESE cliente; con 0 llamadas vivas, o llamadas de sesiones distintas, se responde `decline` sin preguntar (con varias sesiones se publica `rejected/ambiguous` en cada una; sin llamada viva no hay sesión a quien avisar y solo queda el registro). `callID` solo se manda si hay una única llamada viva.
- **Respuestas al servidor**: `accept` con los valores validados por el motor, `decline` (rechazado por la persona, secreto, esquema, ambiguo) o `cancel` (tiempo, Detener, cancelación del servidor). `notifications/cancelled` del servidor cierra el formulario (`rejected/server-cancel`). Al terminar la llamada se llama a `McpElicitation.finishCall`.
- **Temporizador pausable**: con la variable, `McpInvocar.run` e `invokeChildTool` pasan al SDK un tope de 1 h y miden el `timeout` real con un temporizador propio (`crearTemporizador`) que se **pausa** mientras haya un formulario abierto de la llamada (se reanuda completo al contestar) y se reinicia con el progreso (`onprogress`, como `resetTimeoutOnProgress`). El error al agotarse es `MCP request timed out after N ms`.
- **Detener**: `SessionPrompt.cancel` llama a `McpElicitation.cancelSession(sessionID, "abort")` antes de cancelar el turno: `rejected/abort` y el servidor recibe `cancel`. Abortar la llamada (señal del turno o de la celda) hace lo mismo.
- **Rutas HTTP nuevas** (`server/routes/instance/httpapi/groups/mcp.ts` + `handlers/mcp.ts`): `GET /mcp/elicitation` (operationId `mcp.elicitation.list`, lista de `McpElicitationRequest`) y `POST /mcp/elicitation/{requestID}/reply` (`mcp.elicitation.reply`, cuerpo `{ action: accept|decline|cancel, content? }`, respuesta `true`; `404 McpElicitationNotFoundError`, `400 McpElicitationInvalidReplyError` con `errors: [{ campo, motivo }]`, nunca valores). **El contrato de rutas de la app (`resources/opencode-bin/api-routes.json`) debe regenerarse con este motor.**
- Pruebas: `packages/opencode/test/lazunox/mcp-elicitation-b2.test.ts` (servidor real por stdio: `test/fixture/mcp-elicitation-stdio.ts`), ampliación de `test/server/httpapi-exercise/index.ts` y `httpapi-public-openapi.test.ts`.

## Rebobinar por turno (R0-R2)

Plan: `docs/PLAN-REBOBINAR-Y-COMPACTACION.md` de la app (2.A). Todo vive en el motor; el interruptor de emergencia es `LAZUNOX_REBOBINAR=0` (las rutas nuevas responden 404 y no se crean puntos de control; el `Revertir` de siempre sigue).

**R0 - arreglos de seguridad de las instantáneas** (`snapshot/index.ts`, `session/revert.ts`; prueba `test/lazunox/snapshot-seguro.test.ts`, las 5 pruebas fallaban antes del arreglo):
- Fallo que había: las instantáneas son árboles sin commit ni ref y `git gc --prune=7.days` se los llevaba. Al revertir, `ls-tree` fallaba y el código lo tomaba como «el archivo no existía» y **lo borraba**. Además `remove` seguía enlaces simbólicos y rutas con `..`/absolutas (borraba archivos fuera del proyecto y hasta `.git/HEAD`) y `unrevert` reescribía **toda** la carpeta (`checkout-index -a -f`).
- Ahora: `Snapshot.revert`/`restoreFiles` primero comprueban que TODOS los árboles existen (`cat-file -e`); si falta uno, `Snapshot.ExpiredError` (409; en `/session/revert` y `/unrevert` es un 404 con mensaje) y no se toca nada. Un fallo de git nunca se interpreta como «no existía» (`ls-tree` + confirmación con `cat-file`). Guardia de rutas en toda escritura o borrado: dentro de la carpeta del proyecto, nunca `.git`, ningún componente del camino puede ser un enlace simbólico (`lstat`), los enlaces del árbol solo se restauran si apuntan dentro, y se borra solo el archivo exacto con `unlink` (nunca recursivo ni carpetas). Los hashes se validan (40/64 hex) antes de llegar a git.
- `SessionRevert.unrevert` ya no usa `restore` completo: guarda en `Storage` (`lazunox_revert/<sesión>`) los archivos que el revert tocó y el árbol de justo después, y deshace SOLO esos; lo que la persona cambió después se salta. `Snapshot.restore` (árbol entero) queda solo por compatibilidad y también falla si el árbol no existe.

**R1 - puntos de control duraderos y turnos** (`session/turnos.ts`, `session/summary.ts`, `session/session.ts`; prueba `test/lazunox/turnos.test.ts`):
- Al resumir cada turno (`SessionSummary.summarize`, que corre al empezar y tras cada paso) se crean refs `refs/lazunox/<sesión>/<mensaje>/<árbol>` en el repositorio de instantáneas para todos los árboles del turno (inicio, fin y los de cada `patch`): `git gc` los respeta. Tope **100 turnos por sesión** (`LAZUNOX_CHECKPOINTS_MAX`): al pasarlo se borran las refs del turno más viejo y ese turno queda `restaurable:false, motivo:"caducado"` (solo conversación). `Session.remove` borra las refs de la sesión. Crece el repo de instantáneas; si pasa de ~1 GB por proyecto, bajar el tope.
- `GET /experimental/session/{sessionID}/turnos?antesDe=&limite=` (`experimental.session.turnos`) responde un **arreglo** (más antiguo primero, máx. 100 turnos antes de `antesDe`): `[{ messageID, time, files: [{ file, status: added|deleted|modified, additions, deletions, origen: herramienta|comando|otro }], truncated, restaurable, motivo? }]`. `files` máx. 500 (`truncated`). Calculado con `git diff --numstat` entre árboles (sin escanear la carpeta ni parches); caché en memoria por turno. `origen`: `herramienta` si una parte `edit`/`write`/`apply_patch` del turno nombra el archivo; `comando` si el turno corrió `bash`/`execute`; si no, `otro` (la persona, un ayudante de fondo, otro proceso). `motivo` de `restaurable:false`: `sin-git`, `sin-instantaneas`, `caducado`.
- `GET /experimental/session/{sessionID}/turnos/{messageID}/diff?file=` (`experimental.session.turnos.diff`): `{ file, status, additions, deletions, patch, binary, truncated }`, contexto 3, tope 1 MB. 404 si el turno no cambió ese archivo; 409 `caducado` si el punto ya no existe.

**R2 - rebobinar con modos, revisión previa y deshacer** (`session/rebobinar.ts`, `session/revert.ts`, `session/prompt.ts`; pruebas `test/lazunox/rebobinar.test.ts` y `rebobinar-http.test.ts`):
- `GET /experimental/session/{sessionID}/rebobinar/{messageID}` (`experimental.session.rebobinar.revision`, solo lectura): `{ archivos: [TurnoArchivo], conflictos: [ruta], protegidos: [ruta], comandos: boolean, commitsDespues: [{ hash(12), asunto }], ayudantesActivos: [{ tipo: sesion|ayudante|shell|celda, id, titulo }], mensajes, restaurable, motivo?, bloqueado? }`. `archivos` = los de los `patch` de ese turno y los siguientes que HOY difieren. `conflictos` = archivos a restaurar que cambiaron **después** del último `step-finish` de la sesión (los tocó la persona u otro proceso). `protegidos` = `permission/rutas-protegidas.ts`. `bloqueado` dice por qué un rebobinado se negaría ahora (`ocupada`, `hija-ocupada`, `trabajo-vivo`, `pendiente`).
- `POST /experimental/session/{sessionID}/rebobinar { messageID, modo: "todo"|"conversacion"|"codigo", sobrescribir?: [ruta] }` (`experimental.session.rebobinar`) -> `{ modo, restaurados, borrados, omitidos: [{ file, motivo }], mensajesOcultos, puedeDeshacer }`. `todo` = Revertir de hoy endurecido (archivos + mensajes ocultos hasta el siguiente prompt); `conversacion` = solo oculta mensajes (`RevertOptions.files:false`), no toca ningún archivo; `codigo` = restaura archivos y deja los mensajes (`RevertOptions.soloCodigo`), y el siguiente mensaje de la persona lleva UNA vez una parte de texto sintética «La persona restauró estos archivos a como estaban antes del turno N: …» (`consumirNota` en `SessionPrompt.prompt`). Conflictos y protegidos se **saltan** (`omitidos` con motivo `conflicto`/`protegido`) salvo que vengan en `sobrescribir`. Otros `motivo` de omitido: `enlace-simbolico`, `fuera-del-proyecto`, `git`, `enlace-fuera-del-proyecto`, `era-una-carpeta`, `no-se-pudo-restaurar`.
- `POST /experimental/session/{sessionID}/rebobinar/deshacer { sobrescribir?: [ruta] }` (`experimental.session.rebobinar.deshacer`) -> `{ restaurados, borrados, omitidos, conflictos }`: vuelve al árbol tomado justo antes de rebobinar **solo en los archivos tocados**.
- Errores: **404** (`NotFoundError`) sesión o mensaje inexistente, archivo que el turno no cambió, o interruptor apagado; **400** (`InvalidRequestError`, `kind: "rebobinar"`) el mensaje no es de la persona, y 400 de esquema si `modo` no es válido; **409** (`RebobinarConflicto { motivo, message }`) con `motivo`: `ocupada`, `hija-ocupada`, `trabajo-vivo`, `pendiente` (permiso, pregunta o formulario MCP), `caducado`, `sin-git`, `sin-instantaneas`, `revert-pendiente` (solo `codigo`), `nada-que-deshacer`. `sin-git`/`sin-instantaneas`/`caducado` bloquean `todo` y `codigo` pero **no** `conversacion`.
- No se hace `reset`, `stash`, `commit` ni `checkout` de ramas; `.git` solo se lee (`git log` para `commitsDespues`, fecha del inicio del turno; un commit con fecha falsa puede escapar, es solo un aviso). Los cambios mezclados (la persona, otro proceso, un ayudante en segundo plano) salen como `otro`/`comando`; los conflictos se detectan solo si ocurren **después** del último paso de la sesión.
- Pruebas del contrato HTTP en `test/server/httpapi-exercise/index.ts` (5 rutas nuevas en `--mode coverage` y `--mode auth`). **El contrato de rutas de la app (`resources/opencode-bin/api-routes.json`) debe regenerarse con este motor.**

## Compactación mejor (C1 y C2 del plan «rebobinar y compactación» de la app)

Plan: `docs/PLAN-REBOBINAR-Y-COMPACTACION.md` de la app (sección 2.B y fases C1-C2). Pruebas: `test/lazunox/compactacion-parcial.test.ts`, `compactacion-ruta.test.ts`, `compactacion-reinyeccion.test.ts`, `contexto-vigente.test.ts` y la ampliación de `ganchos-usuario.test.ts`.

**C1 - momento seguro, modelo y «compactar hasta aquí»**
- `POST /session/{id}/summarize { providerID?, modelID?, auto?, upTo? }`. **`providerID`/`modelID` ahora son opcionales** (van juntos o ninguno): sin ellos se usa el modelo del último mensaje de la persona, y si no hay, el predeterminado. Antes el cuerpo sin modelo daba 400 y el «Compactar historial» de Code (`store.ts` llamaba sin modelo) no funcionaba; el de Chat sí lo mandaba.
- **409 `CompactionConflictError { sessionID, motivo, message }`** con `motivo`: `ocupada` (la sesión está en marcha), `pendiente` (permiso, pregunta o formulario MCP esperando respuesta, de la sesión o de sus hijas) o `revert` (hay un revert pendiente; **ya no se consolida en silencio**: antes `summarize` llamaba a `SessionRevert.cleanup` y borraba los mensajes ocultos). Orden de las comprobaciones: ocupada, pendiente, revert. Las celdas de Code Mode y los shells de fondo vivos no bloquean; salen en el bloque de reinyección.
- `upTo` = id de un mensaje **de la persona** visible. Todo lo anterior se resume y desde él se conserva íntegro: `create` guarda `tail_start_id = upTo` y `manual_tail: true` en la parte `compaction`; `process` no llama a `select`. `filterCompacted` no cambia. Error 400 `InvalidRequestError { field: "upTo", kind }`: `kind: "invalido"` (no existe, no es de la persona, es el primero o ya se resumió) o `kind: "cola-grande"` (lo conservado pasa del 60 % de lo usable: «Lo que quieres conservar ya no cabe; elige un mensaje más reciente.»). Sin `upTo` el comportamiento es el de siempre.
- Métricas: el evento `session.compacted` gana campos **opcionales** `{ auto, parcial, mensajes, tokensAntes, tokensDespues, reinyectado }` y se guardan igual en `compaction.lazunox` de la parte (para verlas al recargar). Solo cifras y etiquetas, nunca contenido. `tokensAntes` = tokens reales de la última respuesta; `tokensDespues` = **estimación** (resumen + cola + bloque reinyectado; la app debe mostrarla con «≈»). `mensajes` = mensajes resumidos.

**C2 - reinyección y `PostCompact`**
- Tras un resumen correcto se añade al mensaje `compaction` una parte de texto sintética `<contexto-vigente>` (`session/contexto-vigente.ts`, funciones puras) con: (a) lista de tareas y su estado, (b) contenido de las habilidades cargadas en la parte resumida (releído con el servicio de habilidades), (c) AGENTS.md/CLAUDE.md de subcarpetas que se adjuntaron al leer (rutas de `metadata.loaded`; solo si están dentro del proyecto tras `realpath`, el archivo es el de instrucciones que devuelve `Instruction.find` y no va ya en el sistema; tope 64 KB por archivo), (d) ayudantes y trabajos de fondo vivos (id, título, estado) y (e) la salida de los ganchos `PostCompact`. No se reinyecta lo que ya va en el sistema (AGENTS.md raíz y global, instrucciones de la configuración, lista de habilidades y de MCP).
- **Presupuesto: lo menor entre 16 KB y el 10 % de lo usable** (tokens × 4). Lo que no cabe de (b)/(c) sale solo con el nombre y «vuelve a cargarla si la necesitas». Sin nada que decir no se añade ninguna parte. Etiquetas del evento: `plan:N`, `habilidades:N`, `instrucciones:N`, `ayudantes:N`, `gancho:N`.
- La segunda compactación no pierde habilidades ni instrucciones: el bloque guarda sus nombres en `metadata.lazunoxContextoVigente` de la parte y la compactación siguiente los relee (el bloque viejo se oculta con su compactación).
- **Interruptor: `LAZUNOX_COMPACT_REINYECTAR=0`** apaga el bloque (el disparador de plugin se sigue avisando, pero su salida no entra).
- Disparador de plugin nuevo `experimental.session.compacted` (`packages/plugin`): entrada `{ sessionID, trigger: "auto"|"manual", parcial, tokensAntes?, tokensDespues? }` (`tokensDespues` aquí es el estimado **sin** el bloque), salida `{ context: string[] }`.
- Gancho de usuario **`PostCompact`** en `plugin/lazunox-ganchos.ts` (mismo archivo de la app que `PreCompact`, `LAZUNOX_HOOKS_FILE`; un proyecto no puede traer el suyo): el comando recibe por stdin `{ event: "PostCompact", sessionID, cwd, trigger, parcial, tokensAntes, tokensDespues }`; su stdout con código 0 (hasta 4000 caracteres) va al bloque marcado `[Gancho PostCompact]`.
- Ni la reinyección ni las métricas pueden hacer fallar una compactación que ya salió bien (se registra un aviso y se sigue).

## Caché estable (P02, Ola 1E)

- **Orden del sistema** (`session/prompt.ts` + `SystemPrompt.assemble` en `session/system.ts`): instrucciones, MCP, skills y **entorno al final** (antes iba primero). El contenido de cada parte no cambia; solo el orden. Así lo que más cambia (el día) queda al final del bloque de sistema.
- **Fecha estable** (`SystemPrompt.stableDate`): solo el día (`toDateString`, sin hora ni segundos); cambia una vez al día, no en cada paso.
- **Herramientas deterministas** (`LLMRequestPrep.ordenarHerramientas`): orden por nombre en puntos de código (antes `localeCompare`, que depende del idioma del sistema); vale también para las MCP.
- **Marcas de caché** (`provider/transform.ts` `applyCaching`, solo proveedores tipo Anthropic/Bedrock/OpenRouter/etc., sin cambios para OpenAI): primer y **último** bloque de sistema (antes los 2 primeros: con 3 o más bloques el último quedaba sin marca) y los 2 últimos mensajes. `promptCacheKey` intacto.
- Lo que añadieron otras ramas no rompe el prefijo: `<contexto-vigente>` y la nota de rebobinar son mensajes persistidos (estables entre pasos); las herramientas diferidas cambian el conjunto de herramientas solo cuando el modelo las pide (cambio esperado, un fallo de caché por cambio).
- Pruebas: `test/lazunox/prefijo-estable.test.ts`. Comprobación con motor real (`PROBE_ONLY=cache` en el arnés): ver la entrega de la tarea 1E (compara los cuerpos de las peticiones 1 y 2: `system` y `tools` byte a byte y el prefijo de `messages`).

## Estado

- Paso 2 hecho: compila desde el código fuente, repetible, pasa el contrato de Lazunox.
- Paso 3.1 hecho: sin conexiones a servicios de OpenCode (ver arriba).
- Paso 4 en curso: Code Mode con límites y pausa/espera (arriba). Pendiente: shell nativo en segundo plano, `permission.ask`, renombrar el producto y mantenimiento mensual. Los flujos de GitHub Actions de OpenCode (`.github`) se eliminaron: eran de su publicación y no aplican aquí.
