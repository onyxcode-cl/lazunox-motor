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

## Estado

- Paso 2 hecho: compila desde el código fuente, repetible, pasa el contrato de Lazunox.
- Paso 3.1 hecho: sin conexiones a servicios de OpenCode (ver arriba).
- Paso 4 en curso: Code Mode con límites y pausa/espera (arriba). Pendiente: shell nativo en segundo plano, `permission.ask`, renombrar el producto y mantenimiento mensual. Los flujos de GitHub Actions de OpenCode (`.github`) se eliminaron: eran de su publicación y no aplican aquí.
