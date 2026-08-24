import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder): void {
  pgm.createTable(
    "loop_users",
    {
      id: {
        type: "uuid",
        primaryKey: true,
        notNull: true,
        default: pgm.func("gen_random_uuid()"),
      },
      privy_user_id: {
        type: "text",
        notNull: true,
        unique: true,
        check: "char_length(privy_user_id) between 1 and 255",
      },
      created_at: {
        type: "timestamptz",
        notNull: true,
        default: pgm.func("current_timestamp"),
      },
      updated_at: {
        type: "timestamptz",
        notNull: true,
        default: pgm.func("current_timestamp"),
      },
    },
    {
      comment:
        "Opaque LOOP accounts keyed independently from wallets and provider identities.",
    },
  );
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropTable("loop_users");
}
