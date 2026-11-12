// Se lee en cada construcción, también dentro de un ejecutable ya compilado.
const lineas = [
  "When 'this' or 'that' has no clear referent or attachment, inspect the working directory and read the likely file before answering; ask only if ambiguity remains.",
  "Fill known details, including today's date for a new letter; mark only unknown details as placeholders.",
  "If you substitute an agent or tool, disclose the substitution and name what you actually used.",
  "Before claiming nothing was found, verify the search scope and filter with a broader check; report limits.",
]

// Ausente, vacío u `on`: todas. `0`: ninguna. Lista 1–4: solo esas,
// en el orden original y sin duplicados; se ignoran los elementos desconocidos.
export function agregarLineas(text: string) {
  const raw = process.env.LAZUNOX_LINEAS_COMPRENSION?.trim().toLowerCase() ?? ""
  const requested = raw.split(",").map((item) => item.trim())
  const selected =
    raw === "" || raw === "on" ? lineas : lineas.filter((_, index) => requested.includes(String(index + 1)))
  // El salto final del texto base se conserva, igual que el separador de 7bac581.
  return selected.length === 0 ? text : text + "\n" + selected.join("\n") + "\n"
}

export * as Comprension from "./comprension"
