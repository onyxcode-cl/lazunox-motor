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

## Estado

- Paso 2 hecho: compila desde el código fuente, repetible, pasa el contrato de Lazunox.
- Pendiente: quitar las conexiones a servicios de OpenCode (actualización automática, compartir, proxy a `app.opencode.ai`, búsqueda web de ellos), renombrar el producto,
  funciones propias en el motor y compilar Windows. Los flujos de GitHub Actions de OpenCode (`.github`) se eliminaron: eran de su publicación y no aplican aquí.
