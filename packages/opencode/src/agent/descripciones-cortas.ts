// Lazunox (lazunox.16, recorte `agentes` de LAZUNOX_AHORRO_TOKENS): descripciones más cortas de los ayudantes NATIVOS en la lista
// que lleva la herramienta `task` (se manda en cada paso). Solo se sustituye si la descripción sigue siendo la original del motor
// (si la persona la cambió en su configuración, se respeta tal cual). Las descripciones de la lista de agentes de la app no cambian.
import { recorteActivo } from "../tool/ahorro-tokens"

const CORTAS: Record<string, { inicio: string; corta: string }> = {
  general: {
    inicio: "General-purpose agent for researching complex questions",
    corta: "General-purpose agent for researching complex questions and executing multi-step tasks; run several in parallel.",
  },
  explore: {
    inicio: "Fast agent specialized for exploring codebases.",
    corta:
      'Fast agent for exploring codebases: find files by pattern, search code for keywords, answer questions about the code. Say the thoroughness: "quick", "medium" or "very thorough".',
  },
  verificador: {
    inicio: "Verifica que un cambio funciona:",
    corta:
      "Verifica que un cambio funciona: corre las pruebas, los tipos o el linter del proyecto y responde PASA o FALLA con la evidencia (máx. 2 KB). No edita ni escribe. Indica qué comprobar.",
  },
  revisor: {
    inicio: "Revisa cambios de código (sin confirmar",
    corta:
      "Revisa cambios de código (sin confirmar, un commit o una rama) y devuelve solo los errores que el cambio introduce, como JSON `findings[]` con prioridad P0-P3. Solo lectura. Indica qué revisar.",
  },
}

export function descripcionAyudante(
  agente: { name: string; description?: string; native?: boolean },
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (!agente.native || !agente.description || !recorteActivo("agentes", env)) return agente.description
  const c = CORTAS[agente.name]
  return c && agente.description.startsWith(c.inicio) ? c.corta : agente.description
}
