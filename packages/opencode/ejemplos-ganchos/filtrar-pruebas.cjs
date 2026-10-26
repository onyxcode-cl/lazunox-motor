#!/usr/bin/env node
// EJEMPLO de gancho PostToolUse (6.8), APAGADO por defecto: el motor solo carga ganchos del archivo LAZUNOX_HOOKS_FILE de la app,
// y este script no está en ninguno. Para probarlo, la app (o una persona) lo añade a ese archivo:
//   { "hooks": { "PostToolUse": [ { "matcher": "shell|bash", "command": "node /ruta/a/filtrar-pruebas.cjs", "timeout": 10 } ] } }
//
// Qué hace: si la salida parece de un ejecutor de pruebas (Tests:/passed/failed/FAIL...) y es larga, deja solo las líneas con FAIL, Error o ✗
// (más 2 de contexto debajo de cada una) y el resumen final. El motor guarda la salida ORIGINAL completa en disco y pone su ruta en el texto,
// así que si este filtro se equivoca el modelo puede leer todo. Si la salida es corta o no parece de pruebas, no hace nada (código 0, sin JSON).
let b = ""
process.stdin.on("data", (d) => (b += d)).on("end", () => {
  let i
  try {
    i = JSON.parse(b)
  } catch {
    return
  }
  const out = String(i.output ?? "")
  const lineas = out.split("\n")
  if (lineas.length < 60 || !/\b(Tests?:|passed|failed|FAIL|PASS)\b/.test(out)) return
  const mantener = new Set()
  const malas = /FAIL|Error|✗|✘|×/
  lineas.forEach((l, n) => {
    if (malas.test(l)) for (let k = n; k <= Math.min(lineas.length - 1, n + 2); k++) mantener.add(k)
  })
  // Resumen final: las últimas líneas con cifras de pruebas.
  const resumen = new Set()
  for (let n = lineas.length - 1, vistas = 0; n >= 0 && vistas < 8; n--) {
    if (/Tests?:|Test Files|Suites?:|\d+ (pass|fail)|Ran \d+|Duration|Time:/.test(lineas[n])) {
      resumen.add(n)
      vistas++
    }
  }
  const salida = lineas.filter((_, n) => mantener.has(n) || resumen.has(n))
  if (salida.length === 0) return // no hay fallos que mostrar ni resumen reconocible: no se filtra, no se arriesga
  console.log(JSON.stringify({ updatedToolOutput: `${salida.join("\n")}\n(mostradas ${salida.length} de ${lineas.length} líneas)` }))
})
