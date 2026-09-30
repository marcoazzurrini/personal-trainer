-- Plan writes can express their preconditions inside the atomic batch, without
-- a version counter. A lost removal/redose precondition rolls back the decision
-- and every sibling change. Re-read membership before reporting or retrying.
ALTER TABLE api_write_assertions ADD COLUMN plan_matches INTEGER NOT NULL DEFAULT 1
  CONSTRAINT api_plan_membership_changed CHECK (plan_matches = 1);
