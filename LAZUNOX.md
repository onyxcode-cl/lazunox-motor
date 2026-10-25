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

## Formularios MCP (`elicitation/create`, modo formulario) - fase B1

Base interna, **todavía sin conectar** al cliente MCP (no hay cambio observable; la conexión es la fase B2, tras `mcp/invocar.ts`). Plan: `docs/PLAN-HERRAMIENTAS-DIFERIDAS-Y-FORMULARIOS-MCP.md` de la app.

- `mcp/elicitation-esquema.ts` (funciones puras): valida el esquema pedido por el servidor (subconjunto plano: texto con `format` email/uri/date/date-time, número, entero, booleano, `enum`/`oneOf`; <= 20 campos, título 120, descripción 500, mensaje 2000, solicitud 16 KB, <= 50 opciones, texto <= 4000), detecta campos secretos (contraseña, clave, token, API key, PIN, CVV, tarjeta, IBAN, OTP, 2FA, código de verificación; español e inglés; `format: password`) y valida la respuesta. Los errores solo llevan nombres de campo, nunca valores. Variables: `LAZUNOX_MCP_ELICITATION=1` (`elicitacionActiva`) y `LAZUNOX_ELICITATION_TIMEOUT_MS` (defecto 600000, tope 3600000).
- `mcp/elicitation.ts` (`McpElicitation`): `ask` (nunca falla; devuelve `accept`/`decline`/`cancel` para el servidor), `reply`, `cancelSession`, `finishCall`, `list`. A diferencia de `Question`, **todo cierre que no es una respuesta publica `mcp.elicitation.rejected`** (tiempo, aborto de la llamada, cancelación del servidor, fibra interrumpida, cierre de la instancia, esquema o secreto rechazados). Un pendiente por servidor y sesión; 5 formularios por llamada. Ni registros ni eventos llevan valores.
- Eventos en `packages/schema/src/mcp-event.ts`: `mcp.elicitation.asked|replied|rejected` (3 más en el inventario público; `event-manifest.test.ts` pasa de 88 a 91). Los archivos generados del SDK (`packages/sdk`) no se regeneraron: la app usa `fetch` crudo.
- Pruebas: `packages/opencode/test/lazunox/mcp-elicitation.test.ts`.

## Estado

- Paso 2 hecho: compila desde el código fuente, repetible, pasa el contrato de Lazunox.
- Paso 3.1 hecho: sin conexiones a servicios de OpenCode (ver arriba).
- Paso 4 en curso: Code Mode con límites y pausa/espera (arriba). Pendiente: shell nativo en segundo plano, `permission.ask`, renombrar el producto y mantenimiento mensual. Los flujos de GitHub Actions de OpenCode (`.github`) se eliminaron: eran de su publicación y no aplican aquí.
