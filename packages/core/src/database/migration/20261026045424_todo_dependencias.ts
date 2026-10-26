import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261026045424_todo_dependencias",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`todo\` ADD \`tarea_id\` text;`)
      yield* tx.run(`ALTER TABLE \`todo\` ADD \`depende_de\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
