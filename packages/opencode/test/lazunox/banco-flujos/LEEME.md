# Tareas de banco para medir los flujos por script (7.17)

Condición de entrega de 7.17 (decisión D5): **T21 y una tarea de fan-out mejoran con el flujo sin subir los tokens**. Hasta medirlo,
`LAZUNOX_FLUJOS` queda apagado por defecto. Estas tareas son lo que falta para medirlo.

| Archivo | Id | Qué es |
|---|---|---|
| `T31-fanout-paquetes.mjs` | T31 | Fan-out: contar errores en 10 registros independientes y decir cuál tiene más. Un registro trae una orden escondida (no debe obedecerse). |
| `T32-migracion-3-juegos.mjs` | T32 | Adaptación de T21: tres juegos de datos independientes (`a/`, `b/`, `c/`), cada uno con la migración de 5 pasos con dependencias. |
| `autoprueba-local.mjs` | | Comprueba sin motor que cada verificador falla al inicio y pasa tras el guion. |

## Cómo integrarlas (en el repositorio de la app, `scripts/engine-bench/`)

1. Copiar `T31-*.mjs` y `T32-*.mjs` a `scripts/engine-bench/tareas/` (el registro `index.mjs` carga solo `T\d\d-*.mjs`; los imports
   `../lib.mjs` y `./_pasos.mjs` ya apuntan a donde corresponde allí).
2. Actualizar la cabecera de `run.mjs` ("23 tareas" pasa a 25) y correr `node scripts/engine-bench/run.mjs --autoprueba --tareas T31,T32`
   en el contenedor. Antes de integrar se puede comprobar aquí mismo: `node autoprueba-local.mjs <ruta de scripts/engine-bench>`.
3. Si se quiere medir T21 tal cual con flujos, no hace falta tocarla: T21 es secuencial; T32 es su versión repartible.

## Cómo medir (A/B, en el contenedor del VPS, nunca en el Mac)

Mismo motor, mismo modelo gratuito, n >= 5 por brazo, tareas `T21,T31,T32` (y las demás como control de que no se rompió nada):

- **Brazo A (sin flujos)**: `--env OPENCODE_EXPERIMENTAL_CODE_MODE=1 --env OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=1` (sin `LAZUNOX_FLUJOS`).
- **Brazo B (con flujos)**: lo mismo más `--env LAZUNOX_FLUJOS=1`, y `BENCH_PEDIDO_FLUJOS=1` en el entorno del EJECUTOR
  (añade al pedido de T31/T32 una frase que sugiere `tools.flujos.en_paralelo`; sin esa variable el pedido es idéntico en los dos brazos).
- Los permisos de la corrida deben dejar pasar `task` (el banco usa `--permisos ninguno`; hay que comprobar que un ayudante de fondo
  pueda lanzarse; si el banco lo deniega, la tarea mediría un error y no los flujos).
- Comparar con `run.mjs --comparar A.json B.json`.

**Criterio** (el de la decisión D5): en el brazo B, T21/T32 y T31 con el mismo o mejor éxito y **tokens enviados totales (los del padre más
los de todos sus ayudantes) no mayores** que en A; si el ahorro por aislar contexto no compensa los ayudantes, no se enciende. Atención:
el banco suma los `step_finish` de la sesión del padre; los ayudantes son sesiones hijas, así que hay que sumar también las suyas (o usar
`GET /session/:id/uso`, 7.18, que ya reporta tokens por ayudante) o el brazo B parecerá más barato de lo que es.

## Variables relacionadas

`LAZUNOX_FLUJOS=1` (enciende), `LAZUNOX_MAX_SUBAGENTS` (tope global de ayudantes, 8 por defecto), `LAZUNOX_FLUJOS_MAX_AYUDANTES` (por guion, 100),
`LAZUNOX_SUBAGENT_RESULT_MAX` (tamaño del informe), y los topes de Code Mode `LAZUNOX_CODE_MODE_*`.
