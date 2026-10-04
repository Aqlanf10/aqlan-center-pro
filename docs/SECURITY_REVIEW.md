# Security review — foundation slice

Review date: 2026-10-05. This is a bounded source review and local test record, **not production approval** and not a claim of medical or legal compliance. All fixtures are synthetic.

## Reviewed boundaries

- `db/001_core.sql` through `db/004_runtime_boundary.sql`.
- `server/app.mjs`, `server/password.mjs`, `server/start.mjs`.
- Monetary domain inputs and conversion in `packages/domain`.

The HTTP service is a trusted backend. Its database credential and session lookup must remain private. SQL `execute(actor, branch, ...)` does not authenticate the actor by itself; the HTTP service supplies the actor from a server-side session. Database credentials therefore must never be exposed to browsers or mobile applications.

## Verified by security tests

`node --test tests/security.test.mjs` passed 4 tests, with no skipped tests:

1. Anonymous command requests, missing/wrong Origin, and cross-site mutation requests are rejected. Client body/header actor identifiers do not replace the authenticated session actor. Numeric JSON money is rejected; source/config paths are not served; API responses carry no-store and framing restrictions.
2. Authorization is scoped to branch and rechecked before idempotent replay. Disabled staff, disabled branches and removed permission cannot reuse an old successful key. Another actor cannot reuse a key. Rejected attempts do not add patients, operations or audit entries.
3. PUBLIC has no schema/table/function access after the reviewed migrations.
4. After migration 004, an isolated runtime login can execute an authorized patient command, but direct clinical/financial DML, permission grants, schema DDL, disabling financial triggers and assumption of the command owner are rejected. The test uses `SET SESSION AUTHORIZATION`, not merely `SET ROLE` from a superuser session, to check real role-assumption restrictions.

HTTP tests use a narrow database stub to observe the actor passed to SQL. SQL tests use PGlite. These tests do **not** prove production reverse proxy, TLS, external PostgreSQL roles, multi-process throttling, or backup behavior. Separate database tests cover transactional and accounting behavior.

## Findings fixed during review

- Command result assignment collided with a PL/pgSQL variable name. Renamed to avoid ambiguity.
- Reversal query's journal identifier collided with a local variable. Qualified the reference.
- A SQL CHECK with nullable legacy source fields could pass as UNKNOWN. Explicit non-null source checks added.
- New-plan intake accepted a historical opening date. New intake now forbids that legacy-only field.
- Migration 004 adds dedicated non-login runtime and command roles, constrained SECURITY DEFINER commands with a fixed search_path, explicit read/session grants, and no runtime clinical/financial DML. Local PostgreSQL-compatible runtime attack-path tests pass. This replaces the earlier SECURITY INVOKER role-boundary blocker.

## Outstanding production gates

| Severity | Evidence / limitation | Required disposition |
| --- | --- | --- |
| High | The isolated runtime-role design passes local tests, but the actual Railway PostgreSQL login, grants and migration-user separation have not been provisioned or verified by this review. | Apply migration 004 using a privileged migration operator, grant the HTTP login only runtime membership, verify the production driver and effective privileges, and repeat permission checks against staging. Do not deploy using the migration owner. |
| High | Real TLS termination, production cookie behavior, external database role grants, and backup restoration have not been exercised by these security tests. | Verify in an isolated Railway staging environment before real patient data. Never convert local test success into a production claim. |
| Medium | Login throttling is an in-memory map per Node process. Multiple replicas and restarts do not share budgets; proxy peers may also share an IP budget. | Add a shared rate limiter and validate proxy identity handling before multiple replicas or public clinical operation. Keep arbitrary forwarded-IP headers untrusted. |
| Medium | Credential recovery/reset, user administration, session revocation controls and authentication event audit are not yet complete. | Finish and test operator/staff account lifecycle before enabling actual clinic staff access. Never put passwords in git, logs, URLs or client responses. |
| Medium | Session expiry exists, but expired-row cleanup and practical recovery procedures are not yet demonstrated. | Add an operational cleanup/recovery path and verify forced revocation after account changes. |

## Scope limits and accounting observations

The opening balance command posts remaining receivable or prior patient credit, not historical cash. Payment exchange rates are stored and conversions use decimal arithmetic. Composite patient/plan/branch foreign keys protect against mixed patient links, and posted journals, lines, payments and audit rows reject ordinary UPDATE/DELETE. Those protections are valuable but cannot stop a database owner from changing schema or disabling triggers.

Agreement corrections, legacy evidence reconciliation, import overlap review, refunds/credit application, complete specialty clinical templates and the remaining master-plan modules are not delivered by this foundation. Their absence must stay visible in the implementation roadmap. No claim that this is already a complete clinical or accounting system is supported by this review.
