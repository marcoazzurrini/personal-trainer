import { homedir } from "node:os";
import nodePath from "node:path";
import { test } from "node:test";

import { assertEquals, assertThrows } from "../../api/tests/assertions.ts";
import { backupDestination, verifyExport } from "../backup.ts";

const repository = nodePath.resolve(import.meta.dirname, "../..");

const schema = `
CREATE TABLE users (id INTEGER PRIMARY KEY);
CREATE TABLE sets (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id));
CREATE VIEW user_sets AS SELECT user_id, count(*) AS n FROM sets GROUP BY user_id;
`;
const required = ["users", "sets"];

test("backups refuse a missing, relative or in-repository destination", () => {
  assertThrows(() => backupDestination(), Error, "TRAINER_BACKUP_DIR");
  assertThrows(
    () => backupDestination("Backups/personal-trainer"),
    Error,
    "absolute path"
  );
  for (const inside of [repository, nodePath.join(repository, "backups")]) {
    assertThrows(
      () => backupDestination(inside),
      Error,
      "inside the repository"
    );
  }
  const outside = nodePath.join(homedir(), "Backups", "personal-trainer");
  assertEquals(backupDestination(outside), outside);
});

test("a restorable export with intact keys and views reports its counts", () => {
  const sql = `${schema}
INSERT INTO users VALUES (1);
INSERT INTO sets VALUES (1, 1), (2, 1);`;
  assertEquals(verifyExport(sql, required), { users: 1, sets: 2 });
});

test("an export with dangling keys, empty core tables or broken views is refused", () => {
  assertThrows(
    () =>
      verifyExport(
        `${schema} INSERT INTO users VALUES (1); INSERT INTO sets VALUES (1, 2);`,
        required
      ),
    Error,
    "dangling foreign keys"
  );
  assertThrows(
    () => verifyExport(`${schema} INSERT INTO users VALUES (1);`, required),
    Error,
    'no rows in "sets"'
  );
  assertThrows(
    () =>
      verifyExport(
        `${schema} CREATE VIEW broken AS SELECT * FROM missing;
INSERT INTO users VALUES (1); INSERT INTO sets VALUES (1, 1);`,
        required
      ),
    Error
  );
  assertThrows(() => verifyExport("CREATE TABLE", required), Error);
});
