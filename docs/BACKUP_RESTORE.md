# Backup and restore rehearsal

This is a **test database restore drill**, not an operational production backup service.
No production retention, encrypted storage, scheduled backups, or recovery SLA is configured by these files.

Run the migrations and PostgreSQL concurrency tests first. Use PostgreSQL 17 clients against the PostgreSQL 17 test server. Export `TEST_DATABASE_URL` and `RESTORE_TEST_DATABASE_URL` through your environment/secret manager, then run:

```sh
python3 scripts/restore-test.py
```

The source name must end in `_test`. The target must end in `_restore_test`, be a **different, nonexistent database**, and use the same disposable cluster and owner role. The command refuses to overwrite or drop any existing database. Its administrator creates only the new restore database. No source data or source sequence is modified.

The drill creates a private temporary directory, writes a custom-format dump and SHA-256 manifest with permissions `0600`, restores into the new target, then checks:

- Patient, plan, journal, journal line, payment and audit row counts.
- Applied clinical schema versions.
- Debit, credit and net balances by branch, ledger account and currency.
- Every `clinic` sequence's state and the actual next generated ID **on the restore target only**.

The dump and manifest use the same exported read-only database snapshot. Sequence counters are not MVCC snapshots, so this drill requires a quiescent source (no concurrent writers). CI fixtures satisfy that requirement. Dumps contain sensitive records; they are never uploaded as CI artifacts. The temporary files are deleted after the run; the new disposable restore database remains for inspection until the CI service is destroyed. A failure also leaves its newly created target available for investigation.

Database connection credentials stay in environment variables, not process arguments or logs. A hash detects accidental corruption; it is not encryption or proof of authenticity. PostgreSQL custom dumps do not include cluster-wide roles. Existing role definitions on the same test cluster are retained; production disaster recovery must restore/provision roles separately, with credentials stored separately from backups.

For a standalone disposable backup use a **new** output directory:

```sh
python3 scripts/backup.py /private/path/new-backup-directory
```

Before production adoption, configure encrypted offsite/provider backups, access controls, rotation and retention approved by the clinic, separate recovery credentials, recovery point/time targets, monitoring/alerts and a documented restore into an isolated environment. Validate attachment/object-storage restoration and the application with a restricted runtime role as well as database totals. Production backup and restoration require their own reviewed runbook; these test-only scripts intentionally reject production database names.
