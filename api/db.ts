import postgres, { type TransactionSql } from "postgres";

// The handle sql.begin passes to its callback; route code that runs inside
// transactions takes this type.
export type Tx = TransactionSql<{ bigint: number; date: string }>;

// DATABASE_URL is set per environment: the root .env locally, a secret on
// the host. The connection goes straight to Postgres, so prepared statements
// (the driver's default) are fine. Nothing connects until the first query,
// so a module that imports this one can be imported without a database,
// which is what the pure tests do.
export const sql = postgres(Deno.env.get("DATABASE_URL") ?? "", {
  // bigint (our ids) arrives as text by default to protect precision past
  // 2^53. These ids never get near that; numbers make a cleaner API.
  types: {
    bigint: {
      to: 20,
      from: [20],
      serialize: (v: number) => String(v),
      parse: (v: string) => Number(v),
    },
    // Postgres date (oid 1082) stays a plain "YYYY-MM-DD" string instead of
    // becoming a JS Date that serializes as a midnight-UTC timestamp.
    date: {
      to: 1082,
      from: [1082],
      serialize: (v: string) => v,
      parse: (v: string) => v,
    },
  },
});
