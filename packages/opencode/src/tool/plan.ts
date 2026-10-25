import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import { Session } from "@/session/session"
import { Provider } from "@/provider/provider"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { PlanEvent } from "@opencode-ai/schema/plan-event"
import { MessageID, PartID, type SessionID } from "../session/schema"
import { aprobado, acotarTexto, ENTRAR_OPCIONES, PLAN_EVENTO_MAX_BYTES, PLAN_OPCIONES } from "../session/plan-modo"
import EXIT_DESCRIPTION from "./plan-exit.txt"
import ENTER_DESCRIPTION from "./plan-enter.txt"

export const Parameters = Schema.Struct({})

const cambiarDeAgente = Effect.fn("Plan.cambiarDeAgente")(function* (
  session: Session.Interface,
  provider: Provider.Interface,
  sessionID: SessionID,
  agent: "build" | "plan",
  text: string,
) {
  const messages = yield* session.messages({ sessionID }).pipe(Effect.orDie)
  const lastUser = messages.findLast((item) => item.info.role === "user" && item.info.model)
  const model =
    lastUser?.info.role === "user" && lastUser.info.model ? lastUser.info.model : yield* provider.defaultModel()

  const msg: SessionV1.User = {
    id: MessageID.ascending(),
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent,
    model,
  }
  yield* session.updateMessage(msg)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID: sessionID,
    type: "text",
    text,
    synthetic: true,
  } satisfies SessionV1.TextPart)
})

export const PlanExitTool = Tool.define(
  "plan_exit",
  Effect.gen(function* () {
    const session = yield* Session.Service
    const question = yield* Question.Service
    const provider = yield* Provider.Service
    const flags = yield* RuntimeFlags.Service
    const events = yield* EventV2Bridge.Service
    const fsys = yield* FSUtil.Service

    return {
      description: EXIT_DESCRIPTION,
      parameters: Parameters,
      execute: (_params: {}, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const info = yield* session.get(ctx.sessionID)
          const plan = path.relative(instance.worktree, Session.plan(info, instance))

          // Lazunox (2C, P08): modo plan para la app. Salir exige la decisión EXPLÍCITA de una persona.
          if (flags.lazunoxPlan) {
            if (info.parentID || ctx.agent !== "plan") {
              throw new Error("plan_exit solo puede llamarlo el agente de plan de una conversación; un ayudante o el agente de edición no pueden salir del modo plan.")
            }
            const absoluta = Session.plan(info, instance)
            const texto = yield* fsys.readFileStringSafe(absoluta).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (texto === undefined || texto.trim() === "") {
              throw new Error(`Todavía no hay plan: escríbelo en ${plan} (herramienta write) y vuelve a llamar a plan_exit.`)
            }
            const acotado = acotarTexto(texto, PLAN_EVENTO_MAX_BYTES)
            yield* events.publish(PlanEvent.Listo, {
              sessionID: ctx.sessionID,
              messageID: ctx.messageID,
              callID: ctx.callID,
              ruta: plan,
              rutaAbsoluta: absoluta,
              contenido: acotado.texto,
              truncado: acotado.truncado,
              bytes: acotado.bytes,
            })
            const decidir = (decision: "aprobado" | "seguir") =>
              events.publish(PlanEvent.Decidido, { sessionID: ctx.sessionID, callID: ctx.callID, decision, ruta: plan })
            const respuestas = yield* question
              .ask({
                sessionID: ctx.sessionID,
                questions: [
                  {
                    question: `El plan (${plan}) está listo. ¿Lo apruebas para empezar a editar? Cada edición seguirá pidiendo permiso según tus reglas.`,
                    header: "Plan listo",
                    custom: false,
                    options: [
                      { label: PLAN_OPCIONES.aprobar, description: "Pasa al agente de edición con el plan; los permisos siguen como siempre" },
                      { label: PLAN_OPCIONES.seguir, description: "Se queda en modo plan, sin editar, para ajustar el plan" },
                    ],
                  },
                ],
                tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
              })
              .pipe(Effect.tapError(() => decidir("seguir")))
            if (!aprobado(respuestas, PLAN_OPCIONES.aprobar)) {
              yield* decidir("seguir")
              return yield* new Question.RejectedError()
            }
            yield* decidir("aprobado")
            yield* cambiarDeAgente(
              session,
              provider,
              ctx.sessionID,
              "build",
              `La persona aprobó el plan de ${plan}: ya puedes editar archivos (cada edición pide permiso según las reglas). Léelo y ejecútalo paso a paso.`,
            )
            return {
              title: "Pasando al agente de edición",
              output: "La persona aprobó el plan. Espera las siguientes instrucciones.",
              metadata: {},
            }
          }

          const answers = yield* question.ask({
            sessionID: ctx.sessionID,
            questions: [
              {
                question: `Plan at ${plan} is complete. Would you like to switch to the build agent and start implementing?`,
                header: "Build Agent",
                custom: false,
                options: [
                  { label: "Yes", description: "Switch to build agent and start implementing the plan" },
                  { label: "No", description: "Stay with plan agent to continue refining the plan" },
                ],
              },
            ],
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          if (answers[0]?.[0] === "No") yield* new Question.RejectedError()

          yield* cambiarDeAgente(
            session,
            provider,
            ctx.sessionID,
            "build",
            `The plan at ${plan} has been approved, you can now edit files. Execute the plan`,
          )

          return {
            title: "Switching to build agent",
            output: "User approved switching to build agent. Wait for further instructions.",
            metadata: {},
          }
        }).pipe(Effect.orDie),
    }
  }),
)

/** Lazunox (2C): del agente de edición al modo plan, preguntando antes a la persona (solo con LAZUNOX_PLAN=1). */
export const PlanEnterTool = Tool.define(
  "plan_enter",
  Effect.gen(function* () {
    const session = yield* Session.Service
    const question = yield* Question.Service
    const provider = yield* Provider.Service

    return {
      description: ENTER_DESCRIPTION,
      parameters: Parameters,
      execute: (_params: {}, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const info = yield* session.get(ctx.sessionID)
          if (info.parentID || ctx.agent === "plan") {
            throw new Error("plan_enter solo lo puede llamar el agente de edición de una conversación, no un ayudante ni el propio agente de plan.")
          }
          const plan = path.relative(instance.worktree, Session.plan(info, instance))
          const respuestas = yield* question.ask({
            sessionID: ctx.sessionID,
            questions: [
              {
                question: `¿Quieres planificar antes de tocar nada? Se guardará un plan en ${plan} y no se editará ningún otro archivo hasta que lo apruebes.`,
                header: "Modo plan",
                custom: false,
                options: [
                  { label: ENTRAR_OPCIONES.entrar, description: "Pasa al modo plan: el agente investiga y escribe solo el plan" },
                  { label: ENTRAR_OPCIONES.seguir, description: "Sigue con el agente de edición, sin plan" },
                ],
              },
            ],
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })
          if (!aprobado(respuestas, ENTRAR_OPCIONES.entrar)) yield* new Question.RejectedError()

          yield* cambiarDeAgente(
            session,
            provider,
            ctx.sessionID,
            "plan",
            `La persona aceptó planificar primero. Estás en modo plan: investiga solo leyendo y escribe el plan en ${plan}.`,
          )
          return {
            title: "Pasando al modo plan",
            output: "La persona aceptó planificar primero. Espera las siguientes instrucciones.",
            metadata: {},
          }
        }).pipe(Effect.orDie),
    }
  }),
)
