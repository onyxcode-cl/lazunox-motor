import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Agent } from "./agent"
import { topeDelPadre } from "./restringir-permisos"

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task tool. Combines:
 *
 * 1. The parent session's deny rules and external_directory rules.
 *    Parent agent restrictions only govern that agent; the subagent's own
 *    permissions determine its capabilities.
 * 2. Default `todowrite` and `task` denies if the subagent's own ruleset
 *    doesn't already permit them.
 * 3. Lazunox (2A, P06): para un agente definido por el usuario (`subagent.usuario`), el tope del padre: la cola de
 *    restricciones de lo que el padre tiene efectivo (permisos de su agente + de su sesión) y las negaciones propias del
 *    agente. La hija queda con la INTERSECCIÓN: nunca más que el padre. `parentAgentPermission` es el `permission` del agente
 *    que lanza la tarea; sin él solo cuenta la sesión del padre (el piso es el de `defaults + config` de agent.ts).
 *    Los agentes nativos (general, explore) siguen como antes.
 */
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: PermissionV1.Ruleset
  parentAgentPermission?: PermissionV1.Ruleset
  subagent: Agent.Info
}): PermissionV1.Ruleset {
  const canTask = input.subagent.permission.some((rule) => rule.permission === "task")
  const canTodo = input.subagent.permission.some((rule) => rule.permission === "todowrite")
  return [
    ...input.parentSessionPermission.filter(
      (rule) => rule.permission === "external_directory" || rule.action === "deny",
    ),
    ...(input.subagent.usuario
      ? topeDelPadre(
          [...(input.parentAgentPermission ?? []), ...input.parentSessionPermission],
          input.subagent.permission,
          input.subagent.estricto,
        )
      : []),
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}
