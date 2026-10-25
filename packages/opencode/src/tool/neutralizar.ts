// Lazunox: lo que escribe un ayudante (o su título) es DATO: no puede cerrar las etiquetas del sobre ni fingir otro ayudante.
// Módulo aparte para que `task.ts` y `task-gestion.ts` lo compartan sin ciclo de imports.
export const neutralizar = (text: string) =>
  text.replace(/<(\/?)(task_result|task_error|task|summary)\b/gi, "<​$1$2")
