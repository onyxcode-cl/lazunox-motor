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

- **Límites por defecto** (OpenCode no pone ninguno): 300 s, 200 llamadas y 1 MB de salida por script. Se cambian con `LAZUNOX_CODE_MODE_TIMEOUT_MS`, `LAZUNOX_CODE_MODE_MAX_TOOL_CALLS` y `LAZUNOX_CODE_MODE_MAX_OUTPUT_BYTES`. Al llegar a un límite lo ya ejecutado no se deshace y el error le dice al modelo qué obtuvo.
- **Pausa y espera** (idea de Codex): `execute` acepta `yield_ms` (30 s por defecto). Si el script tarda más, sigue vivo en segundo plano y `execute` devuelve un `cell_id`; la herramienta nueva `execute_wait` espera más, lee el resultado o lo termina (`terminate: true`). Hasta 3 celdas vivas a la vez (`LAZUNOX_CODE_MODE_MAX_CELLS`). Las llamadas internas usan una señal de cancelación propia (la del turno se dispara al terminar la respuesta del modelo).
- Pruebas: `packages/codemode/test/lazunox-limites.test.ts`, `packages/opencode/test/tool/code-mode.test.ts` (sección «pausa y espera») y las del `engine-probe` de Lazunox.

## Estado

- Paso 2 hecho: compila desde el código fuente, repetible, pasa el contrato de Lazunox.
- Paso 3.1 hecho: sin conexiones a servicios de OpenCode (ver arriba).
- Paso 4 en curso: Code Mode con límites y pausa/espera (arriba). Pendiente: shell nativo en segundo plano, `permission.ask`, renombrar el producto y mantenimiento mensual. Los flujos de GitHub Actions de OpenCode (`.github`) se eliminaron: eran de su publicación y no aplican aquí.
