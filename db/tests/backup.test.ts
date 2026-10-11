import assert from "node:assert/strict";
import { homedir } from "node:os";
import nodePath from "node:path";
import { test } from "node:test";

import { backupDestination, verifyExport } from "../backup.ts";

const repository = nodePath.resolve(import.meta.dirname, "../..");

const schema = `
CREATE TABLE users (id INTEGER PRIMARY KEY);
CREATE TABLE sets (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id));
CREATE VIEW user_sets AS SELECT user_id, count(*) AS n FROM sets GROUP BY user_id;
`;
const required = ["users", "sets"];

test("backups refuse a missing, relative or in-repository destination", () => {
  assert.throws(() => backupDestination(), /TRAINER_BACKUP_DIR/u);
  assert.throws(
    () => backupDestination("Backups/personal-trainer"),
    /absolute path/u
  );
  for (const inside of [repository, nodePath.join(repository, "backups")]) {
    assert.throws(() => backupDestination(inside), /inside the repository/u);
  }
  const outside = nodePath.join(homedir(), "Backups", "personal-trainer");
  assert.deepEqual(backupDestination(outside), outside);
});

test("a restorable export with intact keys and views reports its counts", () => {
  const sql = `${schema}
INSERT INTO users VALUES (1);
INSERT INTO sets VALUES (1, 1), (2, 1);`;
  assert.deepEqual(verifyExport(sql, required), { users: 1, sets: 2 });
});

test("an export with dangling keys, empty core tables or broken views is refused", () => {
  assert.throws(
    () =>
      verifyExport(
        `${schema} INSERT INTO users VALUES (1); INSERT INTO sets VALUES (1, 2);`,
        required
      ),
    /dangling foreign keys/u
  );
  assert.throws(
    () => verifyExport(`${schema} INSERT INTO users VALUES (1);`, required),
    /no rows in "sets"/u
  );
  assert.throws(
    () =>
      verifyExport(
        `${schema} CREATE VIEW broken AS SELECT * FROM missing;
INSERT INTO users VALUES (1); INSERT INTO sets VALUES (1, 1);`,
        required
      ),
    Error
  );
  assert.throws(() => verifyExport("CREATE TABLE", required), Error);
});
