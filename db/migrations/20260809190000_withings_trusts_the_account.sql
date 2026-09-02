-- The scale filter goes, and with it the column that fed it.
--
-- The sync accepted a weight only if its measure group carried the Body's own
-- device id, to keep hand-entered and third-party-imported weights out of the
-- trend. Two things were wrong with that, and only one of them was visible when
-- it was written.
--
-- It was never verified. The account held nothing but scale readings when it was
-- inspected — the one Apple Health import had already been removed — so there
-- was no negative example to test the rule against. It guarded a case that had
-- been cleaned up and may never recur.
--
-- And it failed in the worst available direction. A replaced scale reports a
-- different device id; every reading would fail the pin; the sync would keep
-- reporting success while writing nothing. No error, no alert. The first symptom
-- would be the coach reporting insufficient data for an expenditure estimate,
-- weeks later, with nothing to connect it to a new scale bought in the
-- meantime. An unverifiable guard is not worth a silent failure that takes a
-- fortnight to surface and longer to diagnose.
--
-- So Withings' account becomes the source of truth: what it holds as a real
-- measurement (category 1, carrying a weight) is written. The trade is stated
-- plainly rather than hidden — connect another app to Withings and its weights
-- will arrive here too. Marco's call, made with that consequence in front of
-- him.
--
-- What still guards the table is what always did: the 25–300 kg band, the
-- future-instant rule, and the natural key on (measured_at, source).

alter table withings_auth drop column device_id;

comment on column bodyweight.source is
  'Where the measurement came from: "manual" for a value Marco read off a scale and told the coach, "withings" for one his Withings account holds. Half of the natural key with measured_at, which is what makes the automatic path safe to run twice — a notification and the daily catch-up can both deliver the same reading and only one row exists.';
