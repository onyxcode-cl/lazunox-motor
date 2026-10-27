// T32 — Adaptación de T21 para flujos: TRES juegos de datos independientes (a/, b/, c/), cada uno con la migración de 5 pasos con dependencias
// reales de T21 (cada `node comprobar.js N` se niega si el paso N-1 no quedó comprobado). Entre juegos no hay dependencia; dentro de cada
// uno, sí. Mide: flujos por script (7.17) en tareas con dependencias: un ayudante por juego, o todo en un solo contexto.
import { createHash } from 'node:crypto'
import { correr, escribir, falla, leer, ok, prng } from '../lib.mjs'
import { bash, escribirArchivo, leerArchivo } from './_pasos.mjs'

const JUEGOS = [
  { dir: 'a', semilla: 3201, admins: [2, 5], nombres: ['Ana Pérez', 'Luis Muñoz', 'Carla Soto', 'Diego Rojas', 'Elena Vidal', 'Franco Díaz', 'Gloria Paz'] },
  { dir: 'b', semilla: 3202, admins: [1, 4], nombres: ['Hugo Mora', 'Inés Lara', 'Jorge Ríos', 'Karen Vega', 'Lucas Toro', 'María Sáez'] },
  { dir: 'c', semilla: 3203, admins: [3], nombres: ['Nora Cruz', 'Óscar Peña', 'Paula Núñez', 'Raúl Ibarra', 'Sofía León', 'Tomás Gil', 'Úrsula Mena', 'Víctor Rey'] }
]

const original = (j) => {
  const r = prng(j.semilla)
  return j.nombres.map((nombre, i) => ({ id: i + 1, nombre, edad: String(r.int(19, 64)), activo: r() < 0.7 ? 'si' : 'no' }))
}
const v2 = (j) => original(j).map((u) => ({ id: u.id, nombreCompleto: u.nombre, edad: Number(u.edad), activo: u.activo === 'si' }))
const conRol = (j) => v2(j).map((u) => ({ ...u, rol: j.admins.includes(u.id) ? 'admin' : 'lector' }))
const indice = (j) => Object.fromEntries(v2(j).map((u) => [String(u.id), u.nombreCompleto]))
const resumen = (j) => `usuarios: ${j.nombres.length}\nadmins: ${j.admins.length}\nactivos: ${v2(j).filter((u) => u.activo).length}\n`
const json = (x) => JSON.stringify(x, null, 2) + '\n'
const huella = (t) => createHash('sha256').update(t).digest('hex')

const MIGRACION = (j) => `# Migración de usuarios del juego ${j.dir} (5 pasos, en orden)

Trabaja SOLO dentro de \`${j.dir}/\`. Parte de \`${j.dir}/datos/usuarios.json\` (formato viejo). Tras cada paso corre \`cd ${j.dir} && node comprobar.js <N>\`:
comprueba el resultado y solo deja pasar al siguiente si el anterior quedó comprobado.

1. **Respaldo**: copia \`datos/usuarios.json\` a \`respaldo/usuarios.v1.json\` sin cambiarlo.
2. **Formato nuevo** en \`datos/usuarios.json\`: \`nombre\` pasa a \`nombreCompleto\`; \`edad\` (texto) pasa a número; \`activo\` ("si"/"no") pasa a booleano.
3. **Índice**: crea \`datos/indice.json\`, un objeto \`{ "<id>": "<nombreCompleto>" }\` con todos los usuarios (sale del archivo ya migrado en el paso 2).
4. **Roles**: agrega \`rol\` a cada usuario de \`datos/usuarios.json\`: \`"admin"\` para los ids ${j.admins.join(' y ')}, \`"lector"\` para el resto.
5. **Resumen**: escribe \`resumen.txt\` con tres líneas exactas: \`usuarios: N\`, \`admins: M\` y \`activos: K\` (K = usuarios con activo verdadero).
`

const COMPROBAR = (j) => `// uso: node comprobar.js <N> (desde ${j.dir}/). Comprueba el paso N y, si está bien, lo anota en .estado y en migracion.log.
const fs = require('node:fs')
const n = Number(process.argv[2])
const ADMINS = ${JSON.stringify(j.admins)}
const leer = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))
const hecho = fs.existsSync('.estado') ? Number(fs.readFileSync('.estado', 'utf8')) : 0
const fallar = (m) => { console.log('PASO ' + n + ' FALLA: ' + m); process.exit(1) }
if (!(n >= 1 && n <= 5)) fallar('uso: node comprobar.js <1-5>')
if (hecho !== n - 1) fallar('antes hay que dejar comprobado el paso ' + (n - 1) + ' (último comprobado: ' + hecho + ')')
try {
  const u = leer('datos/usuarios.json')
  if (n === 1) {
    const a = fs.readFileSync('datos/usuarios.json', 'utf8')
    if (!fs.existsSync('respaldo/usuarios.v1.json')) fallar('falta respaldo/usuarios.v1.json')
    if (fs.readFileSync('respaldo/usuarios.v1.json', 'utf8') !== a) fallar('el respaldo no es idéntico al original')
  } else if (n === 2) {
    if (!fs.existsSync('respaldo/usuarios.v1.json')) fallar('falta el respaldo del paso 1')
    for (const x of u) if (!('nombreCompleto' in x) || 'nombre' in x || typeof x.edad !== 'number' || typeof x.activo !== 'boolean') fallar('usuario ' + x.id + ' sin el formato nuevo')
  } else if (n === 3) {
    if (u.some((x) => 'nombre' in x)) fallar('el paso 2 no se hizo: aún hay campos «nombre»')
    const i = leer('datos/indice.json')
    if (Object.keys(i).length !== u.length || u.some((x) => i[String(x.id)] !== x.nombreCompleto)) fallar('datos/indice.json no coincide con los usuarios')
  } else if (n === 4) {
    for (const x of u) if (x.rol !== (ADMINS.includes(x.id) ? 'admin' : 'lector')) fallar('rol incorrecto en el usuario ' + x.id)
  } else if (n === 5) {
    const t = fs.readFileSync('resumen.txt', 'utf8').trim().split(/\\r?\\n/)
    const esperado = ['usuarios: ' + u.length, 'admins: ' + u.filter((x) => x.rol === 'admin').length, 'activos: ' + u.filter((x) => x.activo).length]
    if (JSON.stringify(t) !== JSON.stringify(esperado)) fallar('resumen.txt debería ser ' + JSON.stringify(esperado))
  }
} catch (e) { fallar(String(e.message)) }
fs.writeFileSync('.estado', String(n))
fs.appendFileSync('migracion.log', 'paso' + n + ' ok\\n')
console.log('PASO ' + n + ' OK')
`

const PEDIDO_BASE =
  'Hay tres juegos de datos independientes: `a/`, `b/` y `c/`. Cada uno trae su MIGRACION.md con una migración de usuarios de 5 pasos en orden. Haz la migración de los TRES, cada una dentro de su carpeta. Después de cada paso corre `node comprobar.js <N>` desde la carpeta del juego y no sigas hasta que dé OK; si falla, arregla lo que falte antes de continuar. No modifiques ningún comprobar.js. Entre juegos no hay dependencia; dentro de cada juego, sí.'
const PEDIDO_FLUJO =
  ' Si te sirve, usa `execute` con `tools.flujos.en_paralelo` para dar un ayudante a cada juego y devuelve solo si cada migración quedó completa.'

export default {
  id: 'T32',
  nombre: 'Migración de 5 pasos en 3 juegos independientes',
  mide: 'Flujos por script con dependencias (7.17, adaptación de T21)',
  categoria: 'programacion',
  pedidos: [PEDIDO_BASE + (process.env.BENCH_PEDIDO_FLUJOS === '1' ? PEDIDO_FLUJO : '')],
  preparar(dir) {
    for (const j of JUEGOS) {
      escribir(dir, `${j.dir}/MIGRACION.md`, MIGRACION(j))
      escribir(dir, `${j.dir}/comprobar.js`, COMPROBAR(j))
      escribir(dir, `${j.dir}/datos/usuarios.json`, json(original(j)))
    }
  },
  verificar(dir) {
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
    const canon = (x) => x.map((o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]])))
    for (const j of JUEGOS) {
      const lee = (r) => {
        try {
          return leer(dir, `${j.dir}/${r}`)
        } catch {
          return null
        }
      }
      if (lee('respaldo/usuarios.v1.json') !== json(original(j))) return falla(`${j.dir}: el respaldo falta o no es el original`)
      if (huella(lee('comprobar.js') ?? '') !== huella(COMPROBAR(j))) return falla(`${j.dir}: se modificó comprobar.js`)
      let u
      try {
        u = JSON.parse(lee('datos/usuarios.json'))
      } catch {
        return falla(`${j.dir}: datos/usuarios.json ilegible`)
      }
      if (!eq(canon(u), canon(conRol(j)))) return falla(`${j.dir}: datos/usuarios.json no coincide con el resultado final esperado`)
      let i
      try {
        i = JSON.parse(lee('datos/indice.json'))
      } catch {
        return falla(`${j.dir}: falta datos/indice.json`)
      }
      if (!eq(Object.entries(i).sort(), Object.entries(indice(j)).sort())) return falla(`${j.dir}: datos/indice.json incorrecto`)
      if ((lee('resumen.txt') ?? '').trim() !== resumen(j).trim()) return falla(`${j.dir}: resumen.txt incorrecto`)
      if (lee('migracion.log') !== 'paso1 ok\npaso2 ok\npaso3 ok\npaso4 ok\npaso5 ok\n') return falla(`${j.dir}: los pasos no se comprobaron en orden: ${JSON.stringify(lee('migracion.log'))}`)
    }
    return ok()
  },
  guion: (dir) => ({
    turnos: [
      [
        ...JUEGOS.flatMap((j) => [
          leerArchivo(dir, `${j.dir}/MIGRACION.md`),
          bash(`cd ${j.dir} && mkdir -p respaldo && cp datos/usuarios.json respaldo/usuarios.v1.json && node comprobar.js 1`, `${j.dir}: paso 1`),
          escribirArchivo(dir, `${j.dir}/datos/usuarios.json`, json(v2(j))),
          bash(`cd ${j.dir} && node comprobar.js 2`, `${j.dir}: paso 2`),
          escribirArchivo(dir, `${j.dir}/datos/indice.json`, json(indice(j))),
          bash(`cd ${j.dir} && node comprobar.js 3`, `${j.dir}: paso 3`),
          escribirArchivo(dir, `${j.dir}/datos/usuarios.json`, json(conRol(j))),
          bash(`cd ${j.dir} && node comprobar.js 4`, `${j.dir}: paso 4`),
          escribirArchivo(dir, `${j.dir}/resumen.txt`, resumen(j)),
          bash(`cd ${j.dir} && node comprobar.js 5`, `${j.dir}: paso 5`)
        ])
      ]
    ],
    final: 'Los tres juegos quedaron migrados con sus cinco pasos comprobados en orden.'
  })
}
