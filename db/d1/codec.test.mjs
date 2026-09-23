import assert from "node:assert/strict";
import { test } from "node:test";
import {
  booleanInteger,
  canonicalDate,
  canonicalInstant,
  canonicalUuid,
  caseKey,
  convertRow,
  jsonText,
  romeDate,
  safeInteger,
  scaledInteger,
  sqlLiteral,
} from "./codec.mjs";
import { DatabaseSync } from "node:sqlite";
import { migrationStatements } from "./local.mjs";

test("decimal storage matches numeric rounding without binary-float ties", () => {
  for (
    const [value, precision, scale, expected] of [
      ["82.345", 5, 2, 8235],
      ["-82.345", 5, 2, -8235],
      [1.005, 6, 2, 101],
      ["2.35", 8, 1, 24],
      ["14.755", 8, 2, 1476],
      ["9.999e1", 6, 1, 1000],
      ["1e-100", 5, 2, 0],
      ["0", 6, 2, 0],
      ["9999.99", 6, 2, 999999],
    ]
  ) assert.equal(scaledInteger(value, precision, scale), expected);
});

test("overflow and invalid numbers fail before an import is written", () => {
  for (
    const value of [
      "9999.995",
      "1e100",
      Infinity,
      NaN,
      "NaN",
      "0xff",
      null,
      "",
      true,
      "1e-1000000",
    ]
  ) {
    assert.throws(() => scaledInteger(value, 6, 2));
  }
  assert.throws(() => safeInteger("9007199254740993"));
  assert.throws(() => safeInteger("3.1"));
  assert.throws(() => safeInteger("Infinity"));
});

test("microseconds survive validation and invalid calendar dates fail", () => {
  const value = "2026-09-01T10:11:12.123456Z";
  assert.equal(canonicalInstant(value), value);
  assert.equal(canonicalDate("2024-02-29"), "2024-02-29");
  for (
    const invalid of [
      "2026-02-30T10:11:12.123456Z",
      "2026-09-01T10:11:12.123Z",
      "2026-09-01T10:11:12.123456+02:00",
    ]
  ) {
    assert.throws(() => canonicalInstant(invalid));
  }
  assert.throws(() => canonicalDate("2026-02-29"));
});

test("Rome dates follow winter and summer offsets and both DST boundaries", () => {
  assert.equal(romeDate("0001-01-01T00:00:00.123456Z"), "0001-01-01");
  assert.equal(romeDate("2026-01-01T23:30:00.000000Z"), "2026-01-02");
  assert.equal(romeDate("2026-07-01T22:30:00.000000Z"), "2026-07-02");
  assert.equal(romeDate("2026-03-29T00:59:59.999999Z"), "2026-03-29");
  assert.equal(romeDate("2026-03-29T01:00:00.000000Z"), "2026-03-29");
  assert.equal(romeDate("2026-10-25T00:59:59.999999Z"), "2026-10-25");
  assert.equal(romeDate("2026-10-25T01:00:00.000000Z"), "2026-10-25");
});

test("UUIDs and Unicode case keys retain their intended distinctions", () => {
  assert.equal(
    canonicalUuid("ABCDEFAB-ABCD-ABCD-ABCD-ABCDEFABCDEF"),
    "abcdefab-abcd-abcd-abcd-abcdefabcdef",
  );
  assert.throws(() => canonicalUuid("abc"));
  assert.equal(caseKey("CAFFÈ"), "caffè");
  assert.notEqual(caseKey("caffè"), caseKey("caffe"));
  assert.equal(booleanInteger("t"), 1);
  assert.equal(booleanInteger("f"), 0);
  assert.throws(() => booleanInteger("yes"));
});

test("JSON is validated without losing large numbers or reserializing it", () => {
  const json = '{"n":9007199254740993,"null":null}';
  assert.equal(jsonText(json), json);
  assert.throws(() => jsonText("{"));
});

test("row conversion distinguishes null and zero and derives the Rome day", () => {
  const columns = {
    id: { type: "bigint", nullable: false },
    value_kg: { type: "numeric", nullable: false, precision: 5, scale: 2 },
    measured_at: { type: "timestamp with time zone", nullable: false },
    source: { type: "text", nullable: false },
    request_id: { type: "uuid", nullable: true },
  };
  const spec = {
    decimals: { value_kg: { precision: 5, scale: 2 } },
    timestamps: ["measured_at"],
    uuids: ["request_id"],
  };
  const source = {
    id: "1",
    value_kg: "82.35",
    measured_at: "2026-07-01T22:30:00.123456Z",
    source: "manual",
    request_id: null,
  };
  const row = convertRow("bodyweight", source, columns, spec);
  assert.equal(row.value_kg, 8235);
  assert.equal(row.measured_date, "2026-07-02");
  assert.equal(row.measured_at, source.measured_at);
  assert.equal(row.request_id, null);
  assert.equal(
    convertRow("bodyweight", { ...source, value_kg: "0" }, columns, spec)
      .value_kg,
    0,
  );
  assert.throws(() =>
    convertRow("bodyweight", { ...source, value_kg: null }, columns, spec)
  );
  assert.throws(() =>
    convertRow("bodyweight", { ...source, unknown: "fact" }, columns, spec)
  );
});

test("storage rules refuse a changed source type, including null decimals", () => {
  for (const value of ["180.15", null]) {
    assert.throws(() =>
      convertRow("users", { height_cm: value }, {
        height_cm: { type: "double precision", nullable: true },
      }, {
        decimals: { height_cm: { precision: 4, scale: 1 } },
      }), /source type/);
  }
});

test("SQL generation handles hostile text without turning it into a statement", () => {
  const text = "'); DROP TABLE sessions; --\nCaffè\u0000";
  const sql = `INSERT INTO notes VALUES (${sqlLiteral(text)});`;
  assert.ok(!sql.includes("DROP TABLE"));
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE notes (text TEXT)");
    db.exec(sql);
    assert.equal(db.prepare("SELECT text FROM notes").get().text, text);
  } finally {
    db.close();
  }
  const source =
    "-- comment;\nCREATE TABLE a(x); CREATE TRIGGER keep_x BEFORE INSERT ON a BEGIN SELECT CASE WHEN NEW.x = 'a;--b' THEN RAISE(ABORT, 'no;') END; END; /* trailing */";
  const split = migrationStatements(source);
  assert.equal(split.length, 2);
  assert.ok(split[1].includes("END; END;"));
  assert.throws(() => migrationStatements("SELECT 'unfinished"));
});
