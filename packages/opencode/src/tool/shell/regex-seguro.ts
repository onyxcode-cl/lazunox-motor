// Lazunox (3E, P24): motor de expresiones regulares SIN retroceso para `avisar_si`.
// El patrón lo escribe el modelo y se ejecuta contra la salida de un comando (texto ajeno): `RegExp` de JS retrocede y un
// patrón como `(a+)+$` se vuelve exponencial (ReDoS) y congelaría el motor entero. Aquí se compila a un autómata (NFA) y se
// simula en tiempo O(longitud de la línea x tamaño del autómata), sin retroceso, para cualquier patrón aceptado.
//
// Subconjunto admitido: literales, `.`, clases `[...]` (con rangos, negación y \d \w \s), `\d \D \w \W \s \S`, anclas `^ $`,
// `\b \B`, grupos `( )` y `(?: )`, alternancia `|`, cuantificadores `* + ? {n} {n,} {n,m}` (la versión perezosa `*?` se
// acepta y se trata igual: solo importa SI hay coincidencia), y la marca `(?i)` al principio. SE RECHAZAN (con mensaje claro)
// las referencias hacia atrás (\1, \k), las anticipaciones y los grupos con nombre, que no se pueden simular sin retroceso.

export const MAX_PATTERN = 200
export const MAX_LINE_MATCHED = 4096
const MAX_STATES = 3000
const MAX_REPEAT = 100
const MAX_DEPTH = 40

export class PatternError extends Error {}

type Test = (cp: number) => boolean
type Node =
  | { t: "empty" }
  | { t: "char"; test: Test }
  | { t: "assert"; kind: "^" | "$" | "b" | "B" }
  | { t: "cat"; items: Node[] }
  | { t: "alt"; items: Node[] }
  | { t: "rep"; item: Node; min: number; max: number } // max = Infinity: sin tope

const isWord = (cp: number) =>
  (cp >= 48 && cp <= 57) || (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122) || cp === 95
const isDigit = (cp: number) => cp >= 48 && cp <= 57
const isSpace = (cp: number) =>
  cp === 32 || (cp >= 9 && cp <= 13) || cp === 0xa0 || cp === 0xfeff || cp === 0x2028 || cp === 0x2029 || (cp >= 0x2000 && cp <= 0x200a) || cp === 0x1680 || cp === 0x202f || cp === 0x205f || cp === 0x3000
const not = (f: Test): Test => (cp) => !f(cp)

const parse = (pattern: string): { node: Node; ignoreCase: boolean } => {
  let src = pattern
  let ignoreCase = false
  if (src.startsWith("(?i)")) {
    ignoreCase = true
    src = src.slice(4)
  }
  const cps = Array.from(src)
  let i = 0
  const fail = (msg: string): never => {
    throw new PatternError(msg)
  }
  const peek = () => cps[i]

  const escapeClass = (c: string): Test | undefined => {
    if (c === "d") return isDigit
    if (c === "D") return not(isDigit)
    if (c === "w") return isWord
    if (c === "W") return not(isWord)
    if (c === "s") return isSpace
    if (c === "S") return not(isSpace)
    return undefined
  }
  const escapeLiteral = (c: string): number => {
    if (c === "t") return 9
    if (c === "n") return 10
    if (c === "r") return 13
    if (c === "f") return 12
    if (c === "v") return 11
    if (c === "0") return 0
    if (c === "x" || c === "u") {
      const len = c === "x" ? 2 : 4
      const hex = cps.slice(i, i + len).join("")
      if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(hex)) fail(`Escape \\${c} inválido.`)
      i += len
      return parseInt(hex, 16)
    }
    if (/[A-Za-z0-9]/.test(c)) {
      if (/[1-9]/.test(c) || c === "k") fail("No se admiten referencias hacia atrás (\\1, \\k).")
      fail(`Escape \\${c} no admitido.`)
    }
    return c.codePointAt(0)!
  }

  const parseClass = (): Node => {
    // `[` ya consumido
    let negate = false
    if (peek() === "^") {
      negate = true
      i++
    }
    const ranges: Array<[number, number]> = []
    const tests: Test[] = []
    let first = true
    for (;;) {
      const c = peek()
      if (c === undefined) return fail("Falta cerrar la clase con ].")
      if (c === "]" && !first) {
        i++
        break
      }
      first = false
      i++
      let lo: number
      if (c === "\\") {
        const e = cps[i++]
        if (e === undefined) return fail("Escape incompleto.")
        const cls = escapeClass(e)
        if (cls) {
          tests.push(cls)
          continue
        }
        if (e === "b") lo = 8
        else lo = escapeLiteral(e)
      } else lo = c.codePointAt(0)!
      let hi = lo
      if (peek() === "-" && cps[i + 1] !== undefined && cps[i + 1] !== "]") {
        i++
        const d = cps[i++]!
        if (d === "\\") {
          const e = cps[i++]
          if (e === undefined) return fail("Escape incompleto.")
          if (escapeClass(e)) return fail("Rango inválido en la clase.")
          hi = e === "b" ? 8 : escapeLiteral(e)
        } else hi = d.codePointAt(0)!
        if (hi < lo) return fail("Rango invertido en la clase.")
      }
      ranges.push([lo, hi])
    }
    const base: Test = (cp) => ranges.some(([a, b]) => cp >= a && cp <= b) || tests.some((f) => f(cp))
    return { t: "char", test: negate ? not(base) : base }
  }

  const parseAtom = (depth: number): Node | undefined => {
    const c = peek()
    if (c === undefined || c === "|" || c === ")") return undefined
    i++
    if (c === "(") {
      if (depth >= MAX_DEPTH) return fail("Demasiado anidado.")
      if (peek() === "?") {
        if (cps[i + 1] === ":") i += 2
        else if (cps[i + 1] === "=" || cps[i + 1] === "!") return fail("No se admiten anticipaciones (?=, ?!).")
        else if (cps[i + 1] === "<") return fail("No se admiten grupos con nombre ni mirada atrás.")
        else return fail("Construcción (?...) no admitida (solo (?:...) y (?i) al inicio).")
      }
      const inner = parseAlt(depth + 1)
      if (peek() !== ")") return fail("Falta cerrar el paréntesis.")
      i++
      return inner
    }
    if (c === "[") return parseClass()
    if (c === ".") return { t: "char", test: (cp) => cp !== 10 && cp !== 13 && cp !== 0x2028 && cp !== 0x2029 }
    if (c === "^") return { t: "assert", kind: "^" }
    if (c === "$") return { t: "assert", kind: "$" }
    if (c === "*" || c === "+" || c === "?") return fail(`Cuantificador «${c}» sin nada que repetir.`)
    if (c === "{") return fail("Llave sin cuantificador válido (escápala como \\{).")
    if (c === "\\") {
      const e = cps[i++]
      if (e === undefined) return fail("Escape incompleto.")
      const cls = escapeClass(e)
      if (cls) return { t: "char", test: cls }
      if (e === "b") return { t: "assert", kind: "b" }
      if (e === "B") return { t: "assert", kind: "B" }
      const lit = escapeLiteral(e)
      return { t: "char", test: (cp) => cp === lit }
    }
    const lit = c.codePointAt(0)!
    return { t: "char", test: (cp) => cp === lit }
  }

  const parseQuant = (): { min: number; max: number } | undefined => {
    const c = peek()
    if (c === "*") return (i++, { min: 0, max: Infinity })
    if (c === "+") return (i++, { min: 1, max: Infinity })
    if (c === "?") return (i++, { min: 0, max: 1 })
    if (c === "{") {
      const m = /^\{(\d{1,3})(?:(,)(\d{0,3}))?\}/.exec(cps.slice(i, i + 12).join(""))
      if (!m) return fail("Cuantificador {n,m} inválido.")
      i += m[0].length
      const min = Number(m[1])
      const max = m[2] ? (m[3] === "" ? Infinity : Number(m[3])) : min
      if (min > MAX_REPEAT || (max !== Infinity && max > MAX_REPEAT)) return fail(`Repetición mayor que ${MAX_REPEAT}.`)
      if (max < min) return fail("Cuantificador {n,m} con m menor que n.")
      return { min, max }
    }
    return undefined
  }

  const parseCat = (depth: number): Node => {
    const items: Node[] = []
    for (;;) {
      let atom = parseAtom(depth)
      if (!atom) break
      let q = parseQuant()
      while (q) {
        if (atom.t === "assert") return fail("Un ancla no se puede repetir.")
        atom = { t: "rep", item: atom, min: q.min, max: q.max }
        if (peek() === "?") i++ // perezoso: igual para saber SI coincide
        q = peek() === "*" || peek() === "+" || peek() === "{" ? parseQuant() : undefined
        if (q) return fail("Cuantificadores seguidos no admitidos.")
      }
      items.push(atom)
    }
    return items.length === 0 ? { t: "empty" } : items.length === 1 ? items[0]! : { t: "cat", items }
  }

  function parseAlt(depth: number): Node {
    const items = [parseCat(depth)]
    while (peek() === "|") {
      i++
      items.push(parseCat(depth))
    }
    return items.length === 1 ? items[0]! : { t: "alt", items }
  }

  const node = parseAlt(0)
  if (i < cps.length) fail(cps[i] === ")" ? "Paréntesis de cierre sin abrir." : "Patrón inválido.")
  return { node, ignoreCase }
}

// ---- NFA ----
type State =
  | { k: "char"; test: Test; next: number }
  | { k: "split"; a: number; b: number }
  | { k: "assert"; kind: "^" | "$" | "b" | "B"; next: number }
  | { k: "match" }

export type Compiled = { test: (line: string) => boolean; states: number }

export const compile = (pattern: string): Compiled => {
  if (typeof pattern !== "string" || pattern.length === 0) throw new PatternError("El patrón está vacío.")
  if (pattern.length > MAX_PATTERN) throw new PatternError(`El patrón supera ${MAX_PATTERN} caracteres.`)
  const { node, ignoreCase } = parse(pattern)
  const states: State[] = []
  const add = (s: State) => {
    if (states.length >= MAX_STATES) throw new PatternError("El patrón es demasiado grande (muchas repeticiones anidadas).")
    states.push(s)
    return states.length - 1
  }
  const fold = (test: Test): Test =>
    !ignoreCase
      ? test
      : (cp) => {
          if (test(cp)) return true
          const ch = String.fromCodePoint(cp)
          const lo = ch.toLowerCase()
          const up = ch.toUpperCase()
          return (lo !== ch && Array.from(lo).length === 1 && test(lo.codePointAt(0)!)) || (up !== ch && Array.from(up).length === 1 && test(up.codePointAt(0)!))
        }
  // Se construye hacia atrás: compile(nodo, siguiente) devuelve el estado de entrada.
  const build = (n: Node, next: number): number => {
    switch (n.t) {
      case "empty":
        return next
      case "char":
        return add({ k: "char", test: fold(n.test), next })
      case "assert":
        return add({ k: "assert", kind: n.kind, next })
      case "cat": {
        let cur = next
        for (let j = n.items.length - 1; j >= 0; j--) cur = build(n.items[j]!, cur)
        return cur
      }
      case "alt": {
        const entries = n.items.map((it) => build(it, next))
        let cur = entries[entries.length - 1]!
        for (let j = entries.length - 2; j >= 0; j--) cur = add({ k: "split", a: entries[j]!, b: cur })
        return cur
      }
      case "rep": {
        let tail = next
        if (n.max === Infinity) {
          const loop = add({ k: "split", a: -1, b: next })
          ;(states[loop] as { a: number }).a = build(n.item, loop)
          tail = loop
        } else {
          for (let j = 0; j < n.max - n.min; j++) tail = add({ k: "split", a: build(n.item, tail), b: next })
        }
        for (let j = 0; j < n.min; j++) tail = build(n.item, tail)
        return tail
      }
    }
  }
  const matchState = add({ k: "match" })
  const start = build(node, matchState)

  const n = states.length
  const mark = new Int32Array(n)
  let gen = 0
  const test = (input: string): boolean => {
    const line = Array.from(input.length > MAX_LINE_MATCHED ? input.slice(0, MAX_LINE_MATCHED) : input)
    const len = line.length
    const word = (idx: number) => idx >= 0 && idx < len && isWord(line[idx]!.codePointAt(0)!)
    let cur: number[] = []
    let nxt: number[] = []
    // Añade el estado y su clausura de transiciones vacías en la posición pos. true si se llega a `match`.
    const addState = (list: number[], s0: number, pos: number): boolean => {
      const stack = [s0]
      let hit = false
      while (stack.length) {
        const s = stack.pop()!
        if (mark[s] === gen) continue
        mark[s] = gen
        const st = states[s]!
        if (st.k === "match") hit = true
        else if (st.k === "char") list.push(s)
        else if (st.k === "split") stack.push(st.b, st.a)
        else {
          const ok =
            st.kind === "^"
              ? pos === 0
              : st.kind === "$"
                ? pos === len
                : st.kind === "b"
                  ? word(pos - 1) !== word(pos)
                  : word(pos - 1) === word(pos)
          if (ok) stack.push(st.next)
        }
      }
      return hit
    }
    for (let pos = 0; pos <= len; pos++) {
      gen++
      // Lo que ya venía de la posición anterior, más un nuevo intento desde aquí (búsqueda sin anclar).
      const carried = nxt
      nxt = []
      cur = []
      let hit = false
      for (const s of carried) if (addState(cur, s, pos)) hit = true
      if (addState(cur, start, pos)) hit = true
      if (hit) return true
      if (pos === len) break
      const cp = line[pos]!.codePointAt(0)!
      for (const s of cur) {
        const st = states[s] as { test: Test; next: number }
        if (st.test(cp)) nxt.push(st.next)
      }
    }
    return false
  }
  return { test, states: n }
}

/** Valida y compila; devuelve el mensaje de error en vez de lanzar (para el parámetro del modelo). */
export const tryCompile = (pattern: string): { ok: true; re: Compiled } | { ok: false; error: string } => {
  try {
    return { ok: true, re: compile(pattern) }
  } catch (e) {
    if (e instanceof PatternError) return { ok: false, error: e.message }
    return { ok: false, error: "Patrón inválido." }
  }
}
