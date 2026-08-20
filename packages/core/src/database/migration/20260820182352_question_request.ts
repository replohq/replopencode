import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260820182352_question_request",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`question_request\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_question_request_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`question_request_session_idx\` ON \`question_request\` (\`session_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
