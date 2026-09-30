import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canonicalDate,
  canonicalInstant,
  canonicalUuid,
  caseKey,
  romeDate,
  scaledInteger,
} from "../storage.ts";
import { migrationStatements } from "./local.ts";

test("decimal storage matches numeric rounding without binary-float ties", () => {
  for (const [value, precision, scale, expected] of [
    ["82.345", 5, 2, 8235],
    ["-82.345", 5, 2, -8235],
    [1.005, 6, 2, 101],
    ["2.35", 8, 1, 24],
    ["14.755", 8, 2, 1476],
    ["9.999e1", 6, 1, 1000],
    ["1e-100", 5, 2, 0],
    ["0", 6, 2, 0],
    ["9999.99", 6, 2, 999_999],
  ] satisfies [string | number, number, number, number][]) {
    assert.equal(scaledInteger(value, precision, scale), expected);
  }
});

test("overflow and invalid numbers fail before storage", () => {
  for (const value of [
    "9999.995",
    "1e100",
    Infinity,
    Number.NaN,
    "NaN",
    "0xff",
    null,
    "",
    true,
    "1e-1000000",
  ]) {
    assert.throws(() => scaledInteger(value, 6, 2));
  }
});

test("microseconds survive validation and invalid calendar dates fail", () => {
  const value = "2026-09-01T10:11:12.123456Z";
  assert.equal(canonicalInstant(value), value);
  assert.equal(canonicalDate("2024-02-29"), "2024-02-29");
  for (const invalid of [
    "2026-02-30T10:11:12.123456Z",
    "2026-09-01T10:11:12.123Z",
    "2026-09-01T10:11:12.123456+02:00",
  ]) {
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
    "abcdefab-abcd-abcd-abcd-abcdefabcdef"
  );
  assert.throws(() => canonicalUuid("abc"));
  assert.equal(caseKey("CAFFÈ"), "caffè");
  assert.notEqual(caseKey("caffè"), caseKey("caffe"));
});

test("migration splitting respects quoted semicolons and complete trigger bodies", () => {
  const source =
    "-- comment;\nCREATE TABLE a(x); CREATE TRIGGER keep_x BEFORE INSERT ON a BEGIN SELECT CASE WHEN NEW.x = 'a;--b' THEN RAISE(ABORT, 'no;') END; END; /* trailing */";
  const split = migrationStatements(source);
  assert.equal(split.length, 2);
  assert.ok(split[1].includes("END; END;"));
  assert.throws(() => migrationStatements("SELECT 'unfinished"));
});
