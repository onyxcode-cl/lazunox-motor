import path from "path"
import { Effect, Exit, Schema } from "effect"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Skill } from "../skill"
import * as Tool from "./tool"
import DESCRIPTION from "./skill.txt"
import DESCRIPTION_CORTA from "./skill-corto.txt"
import { recorteActivo } from "./ahorro-tokens"
import { Agent } from "../agent/agent"
import { Config } from "@/config/config"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { MessageV2 } from "../session/message-v2"
import { MessageID, SessionID } from "../session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import {
  envolverBloque,
  hayBloques,
  modeloDeSkill,
  quitarBloques,
  reglasDeSkill,
  type SkillMeta,
} from "../skill/frontmatter"
import { acotarResultado, permisoDeHija, renderOutput, resultadoMaximo, type TaskPromptOps } from "./task"
import * as Truncate from "./truncate"

export const Parameters = Schema.Struct({
  name: Schema.String.annotate({ description: "The name of the skill from available_skills" }),
  args: Schema.optional(Schema.String).annotate({
    description:
      "What the person asked for, in your own words. Required context for skills that run as a helper (context: fork), which cannot see this conversation.",
  }),
})

/** Agente con el que corre una skill `context: fork`: el ayudante general (nunca otro con más permisos). */
export const AGENTE_FORK = "general"

/** Texto de las restricciones activas, para que el modelo sepa por qué una herramienta ya no está. */
export function avisoDeRestricciones(meta: SkillMeta): string | undefined {
  if (meta.allowedTools.length === 0 && meta.disallowedTools.length === 0) return undefined
  return [
    "Restricciones de esta skill (solo limitan, nunca conceden permisos):",
    ...(meta.allowedTools.length ? [`- Solo se pueden usar: ${meta.allowedTools.join(", ")}.`] : []),
    ...(meta.disallowedTools.length ? [`- Prohibidas: ${meta.disallowedTools.join(", ")}.`] : []),
    "- Rigen hasta que termine este turno.",
  ].join("\n")
}

export const SkillTool = Tool.define(
  "skill",
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const ripgrep = yield* Ripgrep.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const providers = yield* Provider.Service
    const database = yield* Database.Service
    const truncate = yield* Truncate.Service
    const events = yield* EventV2Bridge.Service

    // Lazunox (4A): las restricciones de una skill rigen "mientras dura": al quedar la sesión en reposo (fin del turno) se
    // quitan los bloques de reglas que la skill puso en los permisos de la sesión.
    const limpiar = Effect.fn("SkillTool.limpiarBloques")(function* (sessionID: SessionID) {
      const s = yield* sessions.get(sessionID)
      if (!hayBloques(s.permission ?? [])) return
      yield* sessions.setPermission({ sessionID, permission: quitarBloques(s.permission ?? []) })
    })
    const unsubscribe = yield* events.listen((event) => {
      if (event.type !== SessionStatus.Event.Idle.type) return Effect.void
      const sessionID = (event.data as { sessionID?: string }).sessionID
      if (!sessionID) return Effect.void
      return limpiar(SessionID.make(sessionID)).pipe(Effect.catchCause(() => Effect.void))
    })
    yield* Effect.addFinalizer(() => unsubscribe)

    // ----- context: fork -----
    const correrComoAyudante = Effect.fn("SkillTool.fork")(function* (
      info: Skill.Info,
      meta: SkillMeta,
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
      cuerpo: (notas: string[]) => string,
    ) {
      const cfg = yield* config.get()
      const parent = yield* sessions.get(ctx.sessionID)
      let current = parent
      let depth = 0
      while (current.parentID) {
        depth++
        current = yield* sessions.get(current.parentID)
      }
      if (depth >= (cfg.subagent_depth ?? 1)) {
        return yield* Effect.fail(
          new Error(`Subagent depth limit reached (${cfg.subagent_depth ?? 1}). The skill "${info.name}" cannot run as a helper here.`),
        )
      }
      // Lanzar un ayudante es lanzar un ayudante: lo gobierna el permiso `task` de quien la usa (un padre que no puede lanzar
      // ayudantes tampoco puede lanzarlos por una skill).
      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: "task",
          patterns: [AGENTE_FORK],
          always: ["*"],
          metadata: { description: `skill ${info.name}`, subagent_type: AGENTE_FORK },
        })
      }
      const general = yield* agents.get(AGENTE_FORK)
      if (!general) return yield* Effect.fail(new Error(`Unknown agent type: ${AGENTE_FORK}`))
      // `usuario: true` = sus permisos son la INTERSECCIÓN con los del padre (2A) y heredan el tope del modo plan (2C).
      const next: Agent.Info = { ...general, usuario: true, estricto: general.estricto ?? [] }
      const parentAgent = yield* agents.get(ctx.agent)
      const permisoHijo = permisoDeHija({ cfg, parent, parentAgent, next })
      const reglas = reglasDeSkill(Permission.merge(next.permission, permisoHijo), {
        allowed: meta.allowedTools,
        disallowed: meta.disallowedTools,
      })
      const permission = [...permisoHijo, ...reglas]

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const sesion = { providerID: msg.info.providerID as string, modelID: msg.info.modelID as string }

      // Modelo: solo del mismo proveedor que la sesión; otro se ignora y se registra.
      const notas: string[] = []
      let modelo = { providerID: sesion.providerID, modelID: sesion.modelID }
      let cambiado = false
      if (meta.model) {
        const v = meta.model.trim()
        const cand = v.includes("/") ? { p: v.slice(0, v.indexOf("/")), m: v.slice(v.indexOf("/") + 1) } : { p: sesion.providerID, m: v }
        const existe =
          cand.p === sesion.providerID && cand.m
            ? yield* providers
                .getModel(ProviderV2.ID.make(cand.p), ModelV2.ID.make(cand.m))
                .pipe(Effect.as(true), Effect.catchCause(() => Effect.succeed(false)))
            : false
        const res = modeloDeSkill(meta.model, { providerID: sesion.providerID }, () => existe)
        if (res.tipo === "modelo") {
          modelo = { providerID: res.providerID, modelID: res.modelID }
          cambiado = true
        } else if (res.tipo === "pequeno") {
          const pequeno = yield* providers
            .getSmallModel(ProviderV2.ID.make(sesion.providerID))
            .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
          if (pequeno && pequeno.providerID === sesion.providerID) {
            modelo = { providerID: pequeno.providerID, modelID: pequeno.id }
            cambiado = true
          }
        } else if (res.tipo === "ignorado") {
          yield* Effect.logWarning("skill: model ignorado", { skill: info.name, model: meta.model, motivo: res.motivo })
          notas.push(`Nota: ${res.motivo}.`)
        }
      }

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("Skill fork requires promptOps in ctx.extra"))

      const hija = yield* sessions.create({
        parentID: ctx.sessionID,
        title: `${info.name} (skill, @${next.name})`,
        agent: next.name,
        permission,
      })
      yield* ctx.metadata({
        title: `Skill: ${info.name}`,
        metadata: { parentSessionId: ctx.sessionID, sessionId: hija.id, model: modelo, skill: info.name },
      })

      // El contenido de la skill es DATO del repositorio: va como texto literal (sin resolver @archivos ni comandos).
      const texto = [
        `Eres un ayudante que ejecuta la skill "${info.name}". Sigue sus instrucciones y termina con un informe breve.`,
        `Tus permisos son los del padre o menos: lo que la skill te pida y no tengas permitido, no lo hagas.`,
        "",
        ...(params.args?.trim() ? ["Petición:", params.args.trim(), ""] : []),
        cuerpo([]),
      ].join("\n")

      const cancel = ops.cancel(hija.id)
      const onAbort = () => {
        void Effect.runPromise(cancel).catch(() => undefined)
      }
      ctx.abort.addEventListener("abort", onAbort)
      const exit = yield* Effect.exit(
        ops
          .prompt({
            messageID: MessageID.ascending(),
            sessionID: hija.id,
            model: { modelID: ModelV2.ID.make(modelo.modelID), providerID: ProviderV2.ID.make(modelo.providerID) },
            variant: cambiado ? undefined : msg.info.variant,
            agent: next.name,
            parts: [{ type: "text", text: texto }],
          })
          .pipe(Effect.onInterrupt(() => cancel)),
      )
      ctx.abort.removeEventListener("abort", onAbort)
      if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause)
      const result = exit.value
      if (result.info.role === "assistant" && result.info.error) {
        const m =
          "message" in result.info.error.data && typeof result.info.error.data.message === "string"
            ? result.info.error.data.message
            : result.info.error.name
        return yield* Effect.fail(new Error(`Skill helper failed (task_id: ${hija.id}): ${m}`))
      }
      const informe = yield* acotarResultado(
        result.parts.findLast((item) => item.type === "text")?.text ?? "",
        resultadoMaximo(),
        truncate.write,
      )
      return {
        title: `Skill: ${info.name}`,
        output: renderOutput({ sessionID: hija.id, state: "completed", text: [...notas, informe].join("\n") }),
        metadata: { name: info.name, dir: path.dirname(info.location), sessionId: hija.id, fork: true },
      }
    })

    const ejecutar = Effect.fn("SkillTool.execute")(function* (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) {
      const info = yield* skill
        .require(params.name)
        .pipe(Effect.catchTag("Skill.NotFoundError", (error) => Effect.die(new Error(error.message))))

      // Lazunox (4A): `disable-model-invocation` y `paths` sin activar: el modelo no puede cargarla (la persona sí, con su comando).
      const invocable = yield* skill.invocable(info.name)
      if (!invocable.ok) return yield* Effect.fail(new Error(invocable.motivo))

      yield* ctx.ask({
        permission: "skill",
        patterns: [params.name],
        always: [params.name],
        metadata: {},
      })

      const meta = yield* skill.meta(info.name)
      const dir = path.dirname(info.location)
      const base = dir
      const files = yield* ripgrep.find({
        cwd: dir,
        pattern: "!**/SKILL.md",
        hidden: true,
        follow: false,
        signal: ctx.abort,
        limit: 10,
      })
      const cuerpo = (notas: string[]) =>
        [
          `<skill_content name="${info.name}">`,
          `# Skill: ${info.name}`,
          "",
          info.content.trim(),
          "",
          `Base directory for this skill: ${base}`,
          "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
          "Note: file list is sampled.",
          "",
          "<skill_files>",
          files.map((file) => `<file>${path.resolve(dir, file.path)}</file>`).join("\n"),
          "</skill_files>",
          ...(notas.length ? ["", ...notas] : []),
          "</skill_content>",
        ].join("\n")

      if (meta.fork) return yield* correrComoAyudante(info, meta, params, ctx, cuerpo)

      // ----- En línea: solo restricciones, durante el turno -----
      const notas: string[] = []
      const aviso = avisoDeRestricciones(meta)
      if (aviso) {
        const parentAgent = yield* agents.get(ctx.agent)
        const session = yield* sessions.get(ctx.sessionID)
        const sinEsta = quitarBloques(session.permission ?? [], info.name)
        const efectivo = Permission.merge(parentAgent?.permission ?? [], sinEsta)
        const reglas = reglasDeSkill(efectivo, { allowed: meta.allowedTools, disallowed: meta.disallowedTools })
        if (reglas.length > 0) {
          yield* sessions.setPermission({
            sessionID: ctx.sessionID,
            permission: [...sinEsta, ...envolverBloque(info.name, reglas)],
          })
          notas.push(aviso)
        }
      }
      if (meta.model) {
        yield* Effect.logWarning("skill: model solo se aplica con context: fork; se ignora", { skill: info.name, model: meta.model })
        notas.push("Nota: el campo model de esta skill solo se aplica con context: fork; aquí se ignora.")
      }
      return {
        title: `Loaded skill: ${info.name}`,
        output: cuerpo(notas),
        metadata: { name: info.name, dir },
      }
    })

    return {
      description: recorteActivo("herramientas") ? DESCRIPTION_CORTA : DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        ejecutar(params, ctx).pipe(Effect.orDie),
    }
  }),
)
