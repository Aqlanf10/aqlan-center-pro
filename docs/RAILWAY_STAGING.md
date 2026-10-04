# Isolated Railway staging — Aqlan Center Pro

This is a deployment procedure with the bounded provisioning record below.
Initial read-only inventory on 2026-10-05 found no `aqlan-center-pro` project. Existing `aqlan-center`,
`aqlan-center-mini`, `aqlan-dental-pro` and other projects are outside this procedure.
Use synthetic patients only. Record the exact Git SHA and CI run before deployment.

## Provisioning record — 2026-10-05, Asia/Aden

The new project's private database has been provisioned. Empty `migrate` and `web`
services are configured without a source, public domain or deployment. No application or
migration service has been deployed and no real patient records have been loaded.
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
| Empty migration service | `20693ac2-43a4-450f-9715-ca87bbf326be` |
| Empty web service | `e1d67655-9625-45c8-86ae-a970cb4c11b0` |

Generated database credentials were written directly to Railway through stdin;
they are not stored in this repository. The runtime secret is independent of the
administrator password; an in-memory check verified the web URL resolves to
`aqlan_runtime` and only the migration URL resolves to `postgres`. No public database endpoint was created.
The actual runtime database login, schema migrations, bootstrap account and application's external
HTTPS path still require the operator sequence below after the final CI gate.

Database SSL is enabled. The server certificate includes
`postgresql17.railway.internal` in its Subject Alternative Names; its public root
CA was copied into both services' `DATABASE_CA_CERT` without exporting any private
key. Root CA SHA-256: `3f573e60152a160db511c3aa4b716ff00029c7a97f57be2e2b2ba0c286e68a2d`.
Actual driver certificate verification remains a deployment check.

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
