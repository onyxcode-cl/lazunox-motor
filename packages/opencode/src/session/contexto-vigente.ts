// Lazunox: bloque `<contexto-vigente>` que se reinyecta tras un resumen correcto (funciones puras, sin servicios).
//
// Qué NO se reinyecta: lo que ya viaja en el sistema de cada petición (AGENTS.md/CLAUDE.md raíz y global, instrucciones de la
// configuración, lista de habilidades y de conectores). Aquí solo va lo que el resumen puede perder: la lista de tareas, el contenido de
// las habilidades cargadas, las instrucciones de subcarpetas que se adjuntaron al leer, los ayudantes vivos y la salida de `PostCompact`.

/** Tope absoluto del bloque (el plan: 16 KB o el 10 % de lo usable, lo menor). */
export const BLOQUE_MAX_BYTES = 16 * 1024

/** `id` y `depende_de` (6.6) son opcionales; se muestran sin tocar el estado para que las dependencias sobrevivan a la compactación. */
export type Tarea = { status: string; content: string; id?: string; depende_de?: ReadonlyArray<string> }

// Los ids vienen del modelo: solo se muestran si tienen la forma segura (sin saltos de línea ni marcas) y como mucho 10 dependencias.
const ID_SEGURO = /^[A-Za-z0-9_.-]{1,40}$/
export const marcaDependencias = (t: Tarea): string => {
  const partes: string[] = []
  if (t.id && ID_SEGURO.test(t.id)) partes.push(`id ${t.id}`)
  const deps = (t.depende_de ?? []).filter((d) => ID_SEGURO.test(d)).slice(0, 10)
  if (deps.length) partes.push(`depende de ${deps.join(", ")}`)
  return partes.length ? `(${partes.join("; ")}) ` : ""
}
export type Documento = { nombre: string; contenido: string }
export type Ayudante = { id: string; titulo: string; estado: string }

export type EntradaBloque = {
  tareas: ReadonlyArray<Tarea>
  habilidades: ReadonlyArray<Documento>
  instrucciones: ReadonlyArray<Documento>
  ayudantes: ReadonlyArray<Ayudante>
  /** Salida de los plugins `experimental.session.compacted` (ya marcada, p. ej. «[Gancho PostCompact]»). */
  ganchos: ReadonlyArray<string>
  /** Lazunox (6.4): cuántos mensajes antiguos no entraron en el resumen (0 o ausente = ninguno). */
  descartados?: number
  /** Presupuesto en bytes; se limita a BLOQUE_MAX_BYTES. */
  presupuestoBytes: number
}

export type Bloque = {
  texto: string
  /** Etiquetas para el aviso (cifras, nunca contenido): `plan:5`, `habilidades:2`, `instrucciones:1`, `ayudantes:1`, `gancho:1`. */
  etiquetas: string[]
  /** Nombres de habilidades y rutas que se guardan en los metadatos del bloque para la compactación siguiente. */
  habilidades: string[]
  instrucciones: string[]
}

const bytes = (s: string) => Buffer.byteLength(s, "utf-8")

/** Recorta por bytes sin partir un carácter. */
export const recortarBytes = (texto: string, max: number) => {
  if (max <= 0) return ""
  if (bytes(texto) <= max) return texto
  let fin = Math.min(texto.length, max)
  while (fin > 0 && bytes(texto.slice(0, fin)) > max) fin = Math.floor(fin * 0.9)
  // Afina hacia arriba sin pasarse.
  while (fin < texto.length && bytes(texto.slice(0, fin + 1)) <= max) fin++
  return texto.slice(0, fin)
}

const CABECERA =
  "<contexto-vigente>\nEstado que sigue vigente tras compactar la conversación. No es un mensaje de la persona: es información de la sesión para que no se pierda.\n"
const PIE = "</contexto-vigente>"
const AVISO_RECARGA = "(no cupo: vuelve a cargarla si la necesitas)"

/**
 * Arma el bloque. Orden: tareas, habilidades, instrucciones de carpeta, ayudantes, ganchos. Los documentos largos se incluyen en orden
 * mientras quepan; el que no cabe sale solo con su nombre. Si no hay nada que decir devuelve `undefined`.
 */
export const construirBloque = (input: EntradaBloque): Bloque | undefined => {
  const presupuesto = Math.min(BLOQUE_MAX_BYTES, Math.max(0, Math.floor(input.presupuestoBytes)))
  const tareas = input.tareas.filter((t) => t.content.trim())
  const ayudantes = input.ayudantes
  const ganchos = input.ganchos.map((g) => g.trim()).filter(Boolean)
  const descartados = Number.isFinite(input.descartados) ? Math.max(0, Math.floor(input.descartados ?? 0)) : 0
  if (!descartados && !tareas.length && !input.habilidades.length && !input.instrucciones.length && !ayudantes.length && !ganchos.length) return undefined

  const secciones: string[] = []
  const etiquetas: string[] = []
  let usado = bytes(CABECERA) + bytes(PIE) + 2

  // Pequeñas y siempre presentes (recortadas si ni así caben).
  const fijas: Array<{ titulo: string; lineas: string[]; etiqueta: string }> = []
  if (tareas.length)
    fijas.push({
      titulo: "## Lista de tareas",
      lineas: tareas.map((t) => `- [${t.status}] ${marcaDependencias(t)}${t.content.replace(/\s+/g, " ").trim().slice(0, 300)}`),
      etiqueta: `plan:${tareas.length}`,
    })
  // Nota fija (sin texto de la conversación): solo la cifra.
  if (descartados)
    fijas.push({
      titulo: "## Mensajes antiguos fuera del resumen",
      lineas: [`- ${descartados} mensajes antiguos no entraron en este resumen; si necesitas algo de esa parte, pídeselo a la persona.`],
      etiqueta: `descartados:${descartados}`,
    })
  if (ayudantes.length)
    fijas.push({
      titulo: "## Ayudantes y trabajos en segundo plano que siguen vivos",
      lineas: ayudantes.map((a) => `- ${a.id} · ${a.titulo.replace(/\s+/g, " ").trim().slice(0, 200)} · ${a.estado}`),
      etiqueta: `ayudantes:${ayudantes.length}`,
    })
  const texto = (titulo: string, lineas: string[], tope: number) => {
    const cuerpo = `${titulo}\n${lineas.join("\n")}`
    return recortarBytes(cuerpo, tope)
  }
  const seccion: Record<string, string> = {}
  // Reserva para ganchos (hasta 1/4 del presupuesto) antes de repartir lo demás.
  const reservaGanchos = ganchos.length ? Math.min(Math.floor(presupuesto / 4), ganchos.reduce((n, g) => n + bytes(g) + 1, 0) + 64) : 0
  const disponibleFijas = presupuesto - usado - reservaGanchos
  let restoFijas = Math.max(0, disponibleFijas)
  for (const f of fijas) {
    const t = texto(f.titulo, f.lineas, Math.max(0, restoFijas - 1))
    if (!t) continue
    seccion[f.etiqueta.split(":")[0]!] = t
    restoFijas -= bytes(t) + 1
    usado += bytes(t) + 1
    etiquetas.push(f.etiqueta)
  }

  // Documentos grandes (habilidades e instrucciones): en orden, completos mientras quepan.
  const restoDocs = presupuesto - usado - reservaGanchos
  let libre = restoDocs
  const documentos = (titulo: string, lista: ReadonlyArray<Documento>, etiquetaBase: string) => {
    if (!lista.length) return { texto: "", incluidos: [] as string[] }
    const lineas: string[] = [titulo]
    const incluidos: string[] = []
    libre -= bytes(titulo) + 1
    for (const doc of lista) {
      const nombreBase = `### ${doc.nombre}`
      const completo = `${nombreBase}\n${doc.contenido.trim()}`
      const soloNombre = `${nombreBase}\n${AVISO_RECARGA}`
      if (bytes(completo) + 1 <= libre) {
        lineas.push(completo)
        libre -= bytes(completo) + 1
      } else if (bytes(soloNombre) + 1 <= libre) {
        lineas.push(soloNombre)
        libre -= bytes(soloNombre) + 1
      } else continue
      incluidos.push(doc.nombre)
    }
    if (!incluidos.length) return { texto: "", incluidos }
    etiquetas.push(`${etiquetaBase}:${incluidos.length}`)
    return { texto: lineas.join("\n"), incluidos }
  }
  const hab = documentos("## Habilidades cargadas antes de compactar", input.habilidades, "habilidades")
  const ins = documentos("## Instrucciones de carpeta que se habían adjuntado", input.instrucciones, "instrucciones")
  if (hab.texto) seccion["habilidades"] = hab.texto
  if (ins.texto) seccion["instrucciones"] = ins.texto

  // Ganchos con lo que quede (la reserva más lo no usado).
  let ganchosTexto = ""
  if (ganchos.length) {
    const tope = Math.max(0, presupuesto - usado - (hab.texto ? bytes(hab.texto) + 1 : 0) - (ins.texto ? bytes(ins.texto) + 1 : 0))
    ganchosTexto = recortarBytes(ganchos.join("\n"), tope)
    if (ganchosTexto) etiquetas.push(`gancho:${ganchos.length}`)
  }

  for (const clave of ["plan", "descartados", "habilidades", "instrucciones", "ayudantes"]) {
    const t = seccion[clave]
    if (t) secciones.push(t)
  }
  if (ganchosTexto) secciones.push(ganchosTexto)
  if (!secciones.length) return undefined
  // El orden de `secciones` es el de lectura; `etiquetas` sigue el mismo orden lógico.
  const orden = ["plan", "descartados", "habilidades", "instrucciones", "ayudantes", "gancho"]
  etiquetas.sort((a, b) => orden.indexOf(a.split(":")[0]!) - orden.indexOf(b.split(":")[0]!))

  const final = `${CABECERA}\n${secciones.join("\n\n")}\n${PIE}`
  // Garantía final (nunca debería pasar): si por la cabecera se pasó, se recorta el cuerpo.
  const texto2 = bytes(final) <= presupuesto ? final : `${recortarBytes(final, Math.max(0, presupuesto - bytes(PIE) - 1))}\n${PIE}`
  return { texto: texto2, etiquetas, habilidades: input.habilidades.map((d) => d.nombre), instrucciones: input.instrucciones.map((d) => d.nombre) }
}

/** Presupuesto en bytes: lo menor entre 16 KB y el 10 % de lo usable (tokens * 4 caracteres por token). */
export const presupuestoBloque = (usableTokens: number) => Math.min(BLOQUE_MAX_BYTES, Math.floor(Math.max(0, usableTokens) * 0.1 * 4))

export const reinyectarActivo = () => process.env.LAZUNOX_COMPACT_REINYECTAR !== "0"
