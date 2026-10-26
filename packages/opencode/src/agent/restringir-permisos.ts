import { Wildcard } from "@opencode-ai/core/util/wildcard"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"

/**
 * Lazunox (2A, P06): topes de permisos para agentes definidos por el usuario.
 *
 * Las reglas se evalúan con «gana la última que coincide». Un agente definido en una carpeta (`.opencode/agents`,
 * `.claude/agents`) puede RESTRINGIR lo que hereda, nunca ampliarlo: el resultado debe ser, para cada petición,
 * lo más estricto entre lo que declara y lo que tiene el padre (la base).
 *
 * Con una sola lista ordenada se logra así:
 *
 *     base ++ declarado ++ cola(base) ++ estrictas(declarado)
 *
 *  - `cola(base)`: las reglas de la base que no son «allow» (preguntar / denegar) y las «allow» que sobrescriben una de
 *    esas (p. ej. directorios de lectura permitidos). Van DESPUÉS de lo declarado, así que un `allow` declarado no puede
 *    reabrir lo que la base pregunta o niega. Los `allow` de la cola se acotan a lo que el agente declara para ese patrón
 *    (si el agente lo niega, sigue negado).
 *  - `estrictas(declarado)`: las negaciones del agente que no quedan pisadas por una regla posterior suya; van al final
 *    para que la cola de la base (que puede ser «ask») no las convierta en «preguntar».
 *
 * Aproximación conocida: la comparación de patrones es literal (`Wildcard.match` de un patrón contra otro). Donde dos
 * patrones se cruzan sin contenerse, la cola puede ser más estricta que la base (nunca más laxa): falla hacia pedir permiso.
 */

type Regla = PermissionV1.Rule

const cubre = (ancha: Regla, estrecha: Regla) =>
  Wildcard.match(estrecha.permission, ancha.permission) && Wildcard.match(estrecha.pattern, ancha.pattern)

/** Lo que dice un conjunto de reglas para (permiso, patrón) tal cual; sin coincidencia, `undefined` (sin opinión). */
export function accionLiteral(permiso: string, patron: string, reglas: readonly Regla[]): Regla["action"] | undefined {
  return reglas.findLast((r) => Wildcard.match(permiso, r.permission) && Wildcard.match(patron, r.pattern))?.action
}

/**
 * Reglas de la base que hay que volver a imponer: no-allow, y los allow que pisan a una no-allow anterior.
 * Los allow de `external_directory` se conservan tal cual (carpetas de solo lectura que el padre ya tiene: salidas
 * truncadas, skills, temporales); el resto se acota con `declarado` para no reabrir lo que el agente niega.
 */
export function colaDeLaBase(base: readonly Regla[], declarado: readonly Regla[] = [], acotarExternos = false): Regla[] {
  const cola: Regla[] = []
  base.forEach((r, i) => {
    if (r.action !== "allow") {
      // Un «preguntar» de la base no reabre lo que el agente niega (lista blanca `"*": deny`): sigue negado y la herramienta
      // no se le ofrece. Un «denegar» de la base se conserva siempre.
      if (r.action === "ask" && accionLiteral(r.permission, r.pattern, declarado) === "deny") {
        cola.push({ ...r, action: "deny" })
        // Lista blanca con patrones concretos (p. ej. el revisor: `git diff*`): lo que el agente permite explícitamente queda en
        // «preguntar», igual que el padre (la persona decide), y todo lo demás sigue negado. Nunca más que el «preguntar» del padre.
        for (const d of declarado) {
          // Lista blanca en «allow» (agentes de carpeta) o ya en «ask» (revisor/verificador): en ambos casos queda en «preguntar».
          if (d.action === "deny") continue
          // B3 (probe): si el «preguntar» del padre es el comodín `*: ask` (patrón `*`), también cuentan las herramientas concretas que el
          // agente permite (el emparejamiento era solo en un sentido y `*` no emparejaba con `bash`), incluidas las de patrón `*`
          // (read, grep, glob): quedan en «preguntar» como el padre, nunca en allow. El comodín del propio agente (`"*": deny`) no
          // es un allow, así que no entra. Sin esto el revisor lanzado desde una sesión `*: ask` quedaba sin ninguna herramienta.
          const comodinAsk = r.permission === "*" && r.pattern === "*" && d.permission !== "*"
          if ((d.pattern !== "*" || comodinAsk) && (Wildcard.match(r.permission, d.permission) || (comodinAsk && Wildcard.match(d.permission, r.permission))))
            cola.push({ ...d, action: "ask" })
        }
        return
      }
      cola.push(r)
      return
    }
    const pisa = base.slice(0, i).some((previa) => previa.action !== "allow" && cubre(previa, r))
    if (!pisa) return
    // Con `acotarExternos` (permisos propios del agente), un `"*": deny` del agente también cierra estas carpetas: una lista blanca
    // no puede quedar con más libertad que su padre (el guardián de la app lo compara). Con el tope del padre se conservan tal cual.
    if (r.permission === "external_directory" && !acotarExternos) {
      cola.push(r)
      return
    }
    // El agente solo puede dejarlo igual o más estricto.
    cola.push({ ...r, action: accionLiteral(r.permission, r.pattern, declarado) ?? "allow" })
  })
  return cola
}

/** Negaciones del agente que ninguna regla suya posterior vuelve a abrir (la lista blanca `"*": deny` + `read: allow` no cuenta). */
export function negacionesEfectivas(declarado: readonly Regla[]): Regla[] {
  return declarado.filter(
    (r, i) => r.action === "deny" && !declarado.slice(i + 1).some((despues) => despues.action !== "deny" && cubre(r, despues)),
  )
}

/** Permisos finales de un agente de usuario: base + lo declarado, sin poder superar a la base. */
export function restringir(base: readonly Regla[], declarado: readonly Regla[]): { permission: Regla[]; estricto: Regla[] } {
  const estricto = negacionesEfectivas(declarado)
  return { permission: [...base, ...declarado, ...colaDeLaBase(base, declarado, true), ...estricto], estricto }
}

/**
 * Tope que el padre impone al ayudante en la sesión hija (va DESPUÉS de los permisos del agente):
 * la cola de lo que el padre tiene efectivo (agente + sesión), con los `allow` acotados a lo que el propio ayudante permite,
 * y de nuevo sus negaciones propias al final.
 */
export function topeDelPadre(padreEfectivo: readonly Regla[], ayudante: readonly Regla[], estricto: readonly Regla[] = []): Regla[] {
  return [...colaDeLaBase(padreEfectivo, ayudante), ...estricto]
}
