import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261026003436_todo_verificar",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`todo\` ADD \`verificar\` text;`)
      yield* tx.run(`ALTER TABLE \`todo\` ADD \`bloqueado\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
