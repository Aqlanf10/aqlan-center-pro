# Isolated Railway staging — Aqlan Center Pro

This is a deployment procedure with the bounded provisioning record below.
Initial read-only inventory on 2026-10-05 found no `aqlan-center-pro` project. Existing `aqlan-center`,
`aqlan-center-mini`, `aqlan-dental-pro` and other projects are outside this procedure.
Use synthetic patients only. Record the exact Git SHA and CI run before deployment.

## Provisioning record — 2026-10-05, Asia/Aden

The new project's private database, migration operator and web foundation have
been deployed from the exact Git archive identified below. The account and branch
are synthetic staging fixtures; no real patient records have been loaded.
The existing projects listed above were not modified.

| Resource | Verified value |
| --- | --- |
| New project | `aqlan-center-pro` / `a0d375a9-fbaa-4342-8cd7-766477c4753c` |
| Environment | `staging` / `e058251a-0b65-475a-a3eb-301c9d0f7ab8` |
| Database service | `PostgreSQL17` / `8ebe5bb8-33dc-4616-9924-03cbac140e9f` |
| Persistent volume | `976a3bec-7580-4465-9c1a-97c297a8e9cf`, mounted at `/var/lib/postgresql/data` |
| Database image | `ghcr.io/railwayapp-templates/postgres-ssl:17` |
| Successful database deployment | `468c213e-5772-454b-84de-0f8a153de7bc` |
| Actual server version | `17.11 (Debian 17.11-1.pgdg13+2)`, verified via SSH `psql SHOW server_version` |
| Migration service | `20693ac2-43a4-450f-9715-ca87bbf326be` |
| Web service | `e1d67655-9625-45c8-86ae-a970cb4c11b0` |
| Deployed Git archive | `519cf5ffdbfb1addd7df858cb1df74d02243de89` (merged patient-history release, migrations 1–6) |
| Initial migrations | `28231c24-68e8-4c5d-91d6-3df921a2d42b`, successful one-shot |
| Synthetic administrator bootstrap | `46524367-0a32-4f16-bcc4-635c974e5903`, log confirms creation |
| Prior TLS release migration replay | `37796519-168d-4107-b88a-a8cf170c89ab`, successful one-shot, stopped |
| Migration 006 upgrade | `dda663fc-024f-4716-ae33-7f63ee7a7bd2`, successful one-shot, stopped |
| Web deployment | `d3ea0014-a434-4467-aa6d-01afe3c17a2b`, successful and running |
| HTTPS staging URL | [web-staging-1ff1.up.railway.app](https://web-staging-1ff1.up.railway.app) |

Generated database credentials were written directly to Railway through stdin;
they are not stored in this repository. The runtime secret is independent of the
administrator password; an in-memory check verified the web URL resolves to
`aqlan_runtime` and only the migration URL resolves to `postgres`. No public database endpoint was created.
The restricted `aqlan_runtime` login was provisioned after migration 005. The
synthetic operator username is `staging.owner`; its generated password exists only
in the migration service's `STAGING_ADMIN_PASSWORD` secret. The bootstrap fed that
secret through stdin and the migration service's normal start command was restored.
Neither application image nor repository contains these passwords. GitHub
autodeploy remains disconnected; uploads use the reviewed exact Git archive.

Database SSL is enabled. The server certificate includes
`postgresql17.railway.internal` in its Subject Alternative Names; its public root
CA was copied into both services' `DATABASE_CA_CERT` without exporting any private
key. Root CA SHA-256: `3f573e60152a160db511c3aa4b716ff00029c7a97f57be2e2b2ba0c286e68a2d`.
Live libpq verification with that CA and `verify-full` succeeded using TLS 1.3;
wrong-hostname and untrusted-root attempts were rejected. Actual runtime login
checks confirmed command/session privileges while rejecting command-owner role
assumption, schema DDL and direct clinical DML. The running Node application's
managed CA connection also passes its readiness probe.

HTTPS requests using normal client certificate verification returned 200 for `/`,
`/health/live` and `/health/ready`, and 401 for anonymous `/api/me`. These checks
prove bounded foundation availability, not completed clinic workflows or clinical
production approval. On the preceding TLS release `cac4c051`, authenticated Chrome
checks passed Arabic/English desktop/mobile login, one clearly synthetic patient
creation and reload persistence, logout/401, and no console errors or horizontal
overflow. This bounded check did not exercise financial workflows.

Before upgrading to migration 006, a read-only native dump of the stable staging
database was restored into `aqlan_stage_cac4c051_test`. The exact `cac4c051` operator
image then ran `scripts/restore-test.py` into the separate
`aqlan_stage_cac4c051_restore_test` database. Deployment
`9fde84d0-e792-43fa-81bb-accb47903511` passed backup checksum, restore, row counts,
schema versions, per-currency ledger and next sequence checks. Independent sorted
row SHA-256 fingerprints and counts matched across all 22 clinic/public tables in
the original, disposable source and restored database. Original staging remained
unchanged; temporary dump files were removed. The two disposable databases remain
available for inspection. This verifies database restoration, not attachment or
offsite backup recovery; no separate restored application was started.

After restore success, merged PR #5 archive `519cf5ff` was uploaded to the operator
and then web. Its reviewed head `30f9ba7` passed CI run `37245064431`. Live schema
versions are exactly 1–6 and the original synthetic patient remains. Actual runtime
login permission boundaries and wrong-hostname/untrusted-CA rejection passed again
after the upgrade. No migration 007 was included. The migration operator's normal
start command is again `python3 scripts/migrate.py`.

Operational detail: redeploying an existing Railway deployment preserves that
deployment's start command. To apply a changed operator command, upload the same
verified archive again. Deployment `303eb432-9c4c-4308-9109-822fd5d9769c` consequently
proved migration replay, not bootstrap; only the bootstrap ID above counts as
account-creation evidence.

Local canonical-LF rehearsal on exact Git archive
`cea050d16ffa88e5c8df265f3f8fb05a2e1c446b` passed against a fresh PostgreSQL 17.11
cluster: migrations 1–5, replay, all three real concurrency scenarios, and backup
restoration/counts/schema versions/per-currency ledger/sequence checks. This is
local evidence; it does not claim those operations have run on Railway.

## Resources and credentials

Create a **new** project named `aqlan-center-pro`, with an empty `staging`
environment. Do not duplicate an existing clinic environment or database. Verify
project/environment/service IDs before every CLI mutation (`railway status --json`).
Create a private PostgreSQL **17** service with its own persistent volume and
independent generated credentials. Pin the actual deployed major version; a
marketplace template's moving default is not proof of PostgreSQL 17.

| Service | Configuration | Database authority |
| --- | --- | --- |
| `migrate` | Explicit settings: `Dockerfile.migrate`, start `python3 scripts/migrate.py`, no public domain, no HTTP healthcheck, restart `NEVER`, manual deployments | Migration/operator connection only; initial role administrator can create the roles in migration 004 |
| `web` | Explicit settings: `Dockerfile`, HTTPS domain, `/health/ready`, restart `ON_FAILURE`, one replica initially | Separate login with only `clinic_runtime` membership; never owner/superuser/`clinic_command_owner` membership |

The reviewed nonsecret settings are recorded in
[`deploy/railway-staging-settings.json`](../deploy/railway-staging-settings.json).
This file is a record for operators, not an automatically applied Railway config.
The service settings have been applied through Railway's supported environment
configuration API and read back. The legacy TOML templates were removed after the
live API refused `railwayConfigFile`: new services cannot opt into deprecated
Config as Code. Do not recreate those templates or assume they control deployment.

Future IaC import is recorded deployment debt: use `railway config pull` without
exporting variable values, review the whole project including its existing database
and volume, then preview the plan before applying. IaC can delete omitted resources;
this bounded staging setup intentionally does not introduce an unreviewed SDK or
whole-project apply while preparing the first verified application release.

The migration service has Python 3, PostgreSQL 17 clients and Node 24 for the
operator bootstrap. Its default command applies checksum-tracked migrations and
exits. Successful exit is the acceptance signal; it is not an always-on server.
Keep migration autodeploy disabled. Deploy migrations successfully **before** web
on the same reviewed SHA. Never add a privileged URL to web variables or its
pre-deploy command: pre-deploy processes inherit that service's environment.

Store both connections as service-scoped secrets named `DATABASE_URL`. Only
`migrate` may reference the PostgreSQL administrator URL. Provision a separate
runtime login using the operator connection, without printing its generated
password, and grant it `clinic_runtime`. Runtime must have `NOSUPERUSER`,
`NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION`, `NOBYPASSRLS`, no schema/table ownership
and no membership enabling assumption of the migration or command-owner roles.
Keep passwords out of command arguments, Git, reports and logs. Use private service
DNS. Verify the database TLS/certificate path; do not disable certificate checking
to work around a connection failure.

Set web `NODE_ENV=production`, exact HTTPS `APP_ORIGIN` with no trailing slash,
and only its restricted `DATABASE_URL`; Railway provides `PORT`. Retain
`/health/ready` as the deployment healthcheck. A successful healthcheck alone does
not establish isolation or full clinical readiness.

## Operator sequence

1. Build both images on the release SHA. CI must pass the Node/security checks,
   PostgreSQL concurrency and restore gates, and both image builds.
2. Deploy the private database, then the one-shot migration service. Re-run the
   migration command to verify checksum-safe replay. Record migration versions
   and checksums, never the connection string.
3. Provision the restricted runtime login. Exercise actual runtime login reads,
   authorized commands and rejected direct DML, DDL, grants and role assumption.
   Do not substitute superuser `SET ROLE` for testing the login itself.
4. Bootstrap the synthetic staging administrator once using the operator image:
   `node server/bootstrap.mjs`, with `ADMIN_USERNAME`, `ADMIN_DISPLAY_NAME` and
   `BRANCH_NAME`, piping the password through secure stdin. Run this in a reviewed
   operator session with private-network access; never put a password in the
   service's start command. The bootstrap refuses an already initialized account
   database. Keep the bootstrap credential distinct from the database logins.
5. Deploy web, test HTTPS origin/CSRF and secure cookies, then run Arabic RTL and
   English LTR new/legacy patient journeys and permission boundaries. Verify the
   version-aware legacy review/activation conflict with two sessions.
6. Rehearse restoration into a fresh isolated database and compare records,
   per-currency ledger totals, migration history and sequence state. Run the
   restored application using its restricted role. Existing `backup.py` and
   `restore-test.py` are **test-only** and require disposable `_test` and
   `_restore_test` names. They are not the production backup service. Attachments
   and provider backup retention/encryption need their own acceptance evidence.

## Rollback and remaining gates

Keep the prior application image/SHA and a verified pre-upgrade backup. If a
migration fails, stop deployment and inspect the atomic rollback; do not bypass
checksums. If a new application fails after a schema upgrade, only redeploy an
older image after verifying compatibility. Otherwise restore into a new isolated
database and validate before switching the application connection. Never restore
over the existing clinic database as part of an automatic rollback.

No clinical production approval follows from synthetic staging. Account lifecycle,
shared login throttling before scaling/public operation, external TLS/grants,
attachment recovery, financial policy decisions, and the outstanding requirements
matrix remain explicit gates. Record actual service IDs, SHA, versions, test
evidence and restore result after execution; do not replace them with this plan.

Migration bytes are pinned to LF with `.gitattributes`; the migration runner
retains strict byte checksums. A Windows rehearsal before this attribute produced
CRLF checksums that differ from canonical Git/Linux files. Those disposable
databases must not be reused as deployment sources. Start a fresh test database
with canonical files; never overwrite recorded checksums to suppress a mismatch.

## Checked platform references

- [Railway private networking](https://docs.railway.com/networking/private-networking)
- [Railway PostgreSQL](https://docs.railway.com/databases/postgresql)
- [Railway pre-deploy environment](https://docs.railway.com/deployments/pre-deploy-command)
- [Railway migration from deprecated Config as Code](https://docs.railway.com/infrastructure-as-code#migrating-from-config-as-code)
- [PostgreSQL Debian repository](https://www.postgresql.org/download/linux/debian/)
