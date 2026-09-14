-- GitHub owns reports. The API relays them without local issue bookkeeping.
-- This removes local receipts, not the issues already published on GitHub.
-- request_id remains a correlation marker; repeated writes may create duplicates.
drop table coach_issues;
