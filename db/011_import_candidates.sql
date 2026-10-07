-- IMP-03 candidate matching persistence. The preview proposes exact legacy
-- file-number and normalized-phone matches only; the operator still decides
-- per row. Persisting the proposal (id + name + signal) keeps the audit trail
-- after the in-memory preview is gone and feeds the import screen chips.
ALTER TABLE clinic.import_row ADD COLUMN candidates jsonb NOT NULL DEFAULT '[]';

INSERT INTO clinic.schema_version VALUES(11,now());
