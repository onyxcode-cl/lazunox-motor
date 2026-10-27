import fs from "fs"
import path from "path"

// Lazunox (7.15): la definición de `cuaderno_editar` cuesta tokens en cada petición, así que (regla 7.2: nada que cambie el
// gasto se enciende sin número) solo se ofrece si el proyecto tiene algún .ipynb. LAZUNOX_CUADERNO=1 la fuerza; =0 la apaga.
// La búsqueda es acotada: profundidad 4, 3000 entradas, sin carpetas pesadas ni ocultas.

const OMITIR = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", "dist", "build", "target", ".next", ".cache"])
const MAX_PROFUNDIDAD = 4
const MAX_ENTRADAS = 3000

export function hayCuadernos(raiz: string): boolean {
  let vistas = 0
  const recorrer = (dir: string, nivel: number): boolean => {
    let entradas: fs.Dirent[]
    try {
      entradas = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return false
    }
    for (const e of entradas) {
      if (++vistas > MAX_ENTRADAS) return false
      if (e.isFile() && e.name.toLowerCase().endsWith(".ipynb")) return true
    }
    if (nivel >= MAX_PROFUNDIDAD) return false
    for (const e of entradas) {
      if (!e.isDirectory() || e.name.startsWith(".") || OMITIR.has(e.name)) continue
      if (vistas > MAX_ENTRADAS) return false
      if (recorrer(path.join(dir, e.name), nivel + 1)) return true
    }
    return false
  }
  return recorrer(raiz, 0)
}

export function cuadernoHabilitado(directorio: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.LAZUNOX_CUADERNO === "0") return false
  if (env.LAZUNOX_CUADERNO === "1") return true
  return hayCuadernos(directorio)
}
