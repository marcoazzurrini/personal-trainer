-- D1 batches cannot hold a row lock while TypeScript validates a correction.
-- A version protects that read/validate/write interval. SQLite advances it for
-- every relevant write, so a future writer cannot silently forget the protocol.
ALTER TABLE sessions ADD COLUMN write_version INTEGER NOT NULL DEFAULT 0
  CHECK (write_version BETWEEN 0 AND 9007199254740991);

CREATE TRIGGER sessions_version_after_facts
AFTER UPDATE OF date, rationale, notes, overall_feel, started_at, completed_at ON sessions
BEGIN
  UPDATE sessions SET write_version = write_version + 1 WHERE id = NEW.id;
END;

CREATE TRIGGER sessions_version_after_set_insert
AFTER INSERT ON sets
BEGIN
  UPDATE sessions SET write_version = write_version + 1 WHERE id = NEW.session_id;
END;

CREATE TRIGGER sessions_version_after_set_update
AFTER UPDATE ON sets
BEGIN
  UPDATE sessions SET write_version = write_version + 1
    WHERE id = OLD.session_id OR id = NEW.session_id;
END;

CREATE TRIGGER sessions_version_after_set_delete
AFTER DELETE ON sets
BEGIN
  UPDATE sessions SET write_version = write_version + 1 WHERE id = OLD.session_id;
END;

-- Empty outside a successful write batch. A failed precondition must cause a
-- SQL error inside the transaction: inspecting zero affected rows after commit
-- cannot roll back sibling writes. Concurrent batches are serialized by D1.
CREATE TABLE api_write_assertions (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version_matches INTEGER NOT NULL DEFAULT 1,
  rows_match INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT api_session_changed CHECK (version_matches = 1),
  CONSTRAINT api_incomplete_write CHECK (rows_match = 1)
) STRICT;
