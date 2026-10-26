// Lazunox (6.6, H11): las dependencias de una tarea se guardan como JSON en `todo.depende_de`. Un valor roto se ignora.
export const dependenciasDeFila = (crudo: string | null | undefined): { depende_de?: string[] } => {
  if (!crudo) return {}
  try {
    const v = JSON.parse(crudo)
    if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string")) return { depende_de: v }
  } catch {}
  return {}
}
