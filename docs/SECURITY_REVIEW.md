# Security review — foundation slice

Review date: 2026-10-05. This is a bounded source review and local test record, **not production approval** and not a claim of medical or legal compliance. All fixtures are synthetic.

## Reviewed boundaries

- `db/001_core.sql`, `db/002_commands.sql`, `db/003_auth.sql`.
- `server/app.mjs`, `server/password.mjs`, `server/start.mjs`.
- Monetary domain inputs and conversion in `packages/domain`.

The HTTP service is a trusted backend. Its database credential and session lookup must remain private. SQL `execute(actor, branch, ...)` does not authenticate the actor by itself; the HTTP service supplies the actor from a server-side session. Database credentials therefore must never be exposed to browsers or mobile applications.

## Verified by security tests

`node --test tests/security.test.mjs` passed 3 tests, with no skipped tests:

1. Anonymous command requests, missing/wrong Origin, and cross-site mutation requests are rejected. Client body/header actor identifiers do not replace the authenticated session actor. Numeric JSON money is rejected; source/config paths are not served; API responses carry no-store and framing restrictions.
2. Authorization is scoped to branch and rechecked before idempotent replay. Disabled staff, disabled branches and removed permission cannot reuse an old successful key. Another actor cannot reuse a key. Rejected attempts do not add patients, operations or audit entries.
3. PUBLIC has no schema/table/function access after the reviewed migrations.

HTTP tests use a narrow database stub to observe the actor passed to SQL. SQL tests use PGlite. These tests do **not** prove production reverse proxy, TLS, external PostgreSQL roles, multi-process throttling, or backup behavior. Separate database tests cover transactional and accounting behavior.

## Findings fixed during review

- Command result assignment collided with a PL/pgSQL variable name. Renamed to avoid ambiguity.
- Reversal query's journal identifier collided with a local variable. Qualified the reference.
- A SQL CHECK with nullable legacy source fields could pass as UNKNOWN. Explicit non-null source checks added.
- New-plan intake accepted a historical opening date. New intake now forbids that legacy-only field.

## Outstanding production gates

| Severity | Evidence / limitation | Required disposition |
| --- | --- | --- |
| High | Reviewed command function uses SECURITY INVOKER. Runtime execution consequently needs underlying mutation privileges; a non-owner role alone does not enforce a command-only database boundary. | Provision and verify least-privilege roles. Prefer a dedicated non-login owner of narrowly scoped SECURITY DEFINER commands with fixed search_path, runtime EXECUTE only for clinical/financial mutations, and explicitly restricted read/session grants. Test that runtime direct financial writes, role grants, DDL, and owner assumption fail. Do not deploy using the migration owner. |
| High | Real TLS termination, production cookie behavior, external database role grants, and backup restoration have not been exercised by these security tests. | Verify in an isolated Railway staging environment before real patient data. Never convert local test success into a production claim. |
| Medium | Login throttling is an in-memory map per Node process. Multiple replicas and restarts do not share budgets; proxy peers may also share an IP budget. | Add a shared rate limiter and validate proxy identity handling before multiple replicas or public clinical operation. Keep arbitrary forwarded-IP headers untrusted. |
| Medium | Credential recovery/reset, user administration, session revocation controls and authentication event audit are not yet complete. | Finish and test operator/staff account lifecycle before enabling actual clinic staff access. Never put passwords in git, logs, URLs or client responses. |
| Medium | Session expiry exists, but expired-row cleanup and practical recovery procedures are not yet demonstrated. | Add an operational cleanup/recovery path and verify forced revocation after account changes. |

## Scope limits and accounting observations

The opening balance command posts remaining receivable or prior patient credit, not historical cash. Payment exchange rates are stored and conversions use decimal arithmetic. Composite patient/plan/branch foreign keys protect against mixed patient links, and posted journals, lines, payments and audit rows reject ordinary UPDATE/DELETE. Those protections are valuable but cannot stop a database owner from changing schema or disabling triggers.

Agreement corrections, legacy evidence reconciliation, import overlap review, refunds/credit application, complete specialty clinical templates and the remaining master-plan modules are not delivered by this foundation. Their absence must stay visible in the implementation roadmap. No claim that this is already a complete clinical or accounting system is supported by this review.
