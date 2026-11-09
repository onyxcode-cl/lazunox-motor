// Lazunox (lazunox.16, B2, E8): con la confianza encendida, un plugin, config, agente, comando o skill de una carpeta confiada que sea
// un ENLACE SIMBÓLICO con destino fuera de la cadena del proyecto (la carpeta y sus madres hasta la raíz del repo) no se carga: confiar
// en una carpeta es confiar en lo que HAY en ella, no en lo que un enlace apunte fuera. Falla cerrado (si no se puede resolver, no se carga).
//
// Lazunox (lazunox.16, B2, ronda 2): la implementación vive en core (packages/core/src/config/confianza.ts) para que la vía v2
// (location services) use exactamente la misma regla. Este archivo solo reexporta, para no mover los imports existentes.
export { filtroDeEnlaces } from "@opencode-ai/core/config/confianza"
