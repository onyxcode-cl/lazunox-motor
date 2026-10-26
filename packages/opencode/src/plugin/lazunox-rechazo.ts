// B2 (probe): un gancho `UserPromptSubmit` que rechaza el mensaje debe llegar a la app como error de cliente (400) con el motivo,
// no como el 500 genérico «Unexpected server error». Esta clase la lanza el plugin de ganchos y la reconoce `middleware/error.ts`.

/** Tope del motivo que viaja al cliente (el gancho ya lo acota a 2000; aquí se deja corto para que sea legible). */
export const MAX_MOTIVO_RECHAZO = 1000

/** El motivo es DATO del gancho: sin ANSI ni control, sin poder cerrar sobres del motor, en una línea corta. */
export const limpiarMotivoRechazo = (t: string) =>
  t
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‎‏‪-‮⁦-⁩]/g, "")
    .replace(/</g, "‹")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MOTIVO_RECHAZO) || "(sin motivo)"

export class GanchoRechazoError extends Error {
  override readonly name = "GanchoRechazoError"
  readonly motivo: string
  constructor(motivo: string) {
    const limpio = limpiarMotivoRechazo(motivo)
    super(`Un gancho de usuario rechazó este mensaje: ${limpio}`)
    this.motivo = limpio
  }
  static isInstance(x: unknown): x is GanchoRechazoError {
    return typeof x === "object" && x !== null && (x as { name?: unknown }).name === "GanchoRechazoError" && typeof (x as { motivo?: unknown }).motivo === "string"
  }
  toObject() {
    return { name: this.name, data: { message: this.message } }
  }
}
