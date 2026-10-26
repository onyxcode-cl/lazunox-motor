import { describe, expect, test } from "bun:test"
import { soloMetadataDeProveedor } from "../../src/session/message-v2"

describe("metadata de partes hacia el proveedor", () => {
  test("las marcas internas de Lazunox (texto simple) no viajan como providerMetadata", () => {
    expect(soloMetadataDeProveedor({ lazunox_presupuesto: "aviso" })).toBeUndefined()
    expect(soloMetadataDeProveedor({ lazunox_presupuesto: "agotado" })).toBeUndefined()
    expect(soloMetadataDeProveedor({ lazunox_objetivo: "cumplido" })).toBeUndefined()
    expect(soloMetadataDeProveedor({ lazunox_resumen: "incompleto" })).toBeUndefined()
  })

  test("lo que sí es de un proveedor (objeto de objetos) se conserva, aunque venga mezclado con marcas", () => {
    const m = { anthropic: { signature: "abc" }, lazunox_presupuesto: "aviso", openai: { itemId: "x" } }
    expect(soloMetadataDeProveedor(m)).toEqual({ anthropic: { signature: "abc" }, openai: { itemId: "x" } })
  })

  test("sin metadata, nulos, listas y números no producen nada", () => {
    expect(soloMetadataDeProveedor(undefined)).toBeUndefined()
    expect(soloMetadataDeProveedor({})).toBeUndefined()
    expect(soloMetadataDeProveedor({ a: null, b: [1], c: 3, d: true })).toBeUndefined()
  })
})
