// Autoprueba LOCAL de las tareas T31/T32 (sin motor ni contenedor): cada verificador debe FALLAR en la carpeta inicial y PASAR tras el
// guion. Solo ejecuta `node comprobar.js`, `mkdir`, `cp` y `grep` dentro de una carpeta temporal. Uso: node autoprueba-local.mjs
// (las rutas '../lib.mjs' y './_pasos.mjs' de las tareas valen una vez integradas en scripts/engine-bench/tareas/; aquí se copian a un
// árbol temporal con esa forma usando LIB y PASOS de scripts/engine-bench).
import { cpSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const aqui = dirname(fileURLToPath(import.meta.url))
const banco = resolve(process.argv[2] ?? join(aqui, '../../../../../App OpenCode/scripts/engine-bench'))
const raiz = mkdtempSync(join(tmpdir(), 'banco-flujos-'))
mkdirSync(join(raiz, 'tareas'))
cpSync(join(banco, 'lib.mjs'), join(raiz, 'lib.mjs'))
cpSync(join(banco, 'tareas/_pasos.mjs'), join(raiz, 'tareas/_pasos.mjs'))
for (const n of readdirSync(aqui).filter((x) => /^T\d\d-.*\.mjs$/.test(x))) cpSync(join(aqui, n), join(raiz, 'tareas', n))

function aplicar(proj, paso) {
  const abs = (p) => (p.startsWith('/') ? p : join(proj, p))
  if (paso.name === 'write') {
    mkdirSync(dirname(abs(paso.args.filePath)), { recursive: true })
    writeFileSync(abs(paso.args.filePath), paso.args.content)
  } else if (paso.name === 'bash') {
    spawnSync('/bin/sh', ['-c', paso.args.command], { cwd: proj, encoding: 'utf8', timeout: 60_000 })
  }
}

let malas = 0
for (const n of readdirSync(join(raiz, 'tareas')).filter((x) => /^T\d\d-.*\.mjs$/.test(x)).sort()) {
  const t = (await import(pathToFileURL(join(raiz, 'tareas', n)).href)).default
  const proj = mkdtempSync(join(tmpdir(), `bf-${t.id}-`))
  try {
    t.preparar(proj)
    const antes = t.verificar(proj)
    for (const turno of t.guion(proj).turnos) for (const p of turno) aplicar(proj, p)
    const despues = t.verificar(proj)
    const bien = !antes.ok && despues.ok
    if (!bien) malas++
    console.log(`${t.id}: ${bien ? 'ok' : 'MAL'} · inicial ${antes.ok ? 'PASA (debería fallar)' : 'falla'} · con guion ${despues.ok ? 'pasa' : 'FALLA: ' + despues.detalle}`)
  } finally {
    rmSync(proj, { recursive: true, force: true })
  }
}
rmSync(raiz, { recursive: true, force: true })
process.exit(malas ? 1 : 0)
