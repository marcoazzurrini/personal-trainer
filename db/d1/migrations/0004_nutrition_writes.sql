-- Transaction-local assertions. Never retained as locks across Worker calls.
CREATE TABLE nutrition_write_assertions (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  valid INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT api_incomplete_write CHECK (valid = 1)
) STRICT;
