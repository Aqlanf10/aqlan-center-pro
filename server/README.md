# Authenticated HTTP boundary (foundation)

`node server/start.mjs` serves `web/` and the API. This is a bounded foundation, not a completed clinic product.

Required environment: `DATABASE_URL` (runtime role, not migration owner), `APP_ORIGIN` (exact origin, no trailing slash), `NODE_ENV=production` and Railway `PORT`. Production requires HTTPS origin and rejects superuser/schema-owner DB identities. The `pg` driver is required for production; missing configuration/dependency fails closed. PGlite is used only by tests, never as a production fallback.

## Authentication

- `POST /api/login` JSON `{username,password}`; generic invalid-credential response.
- `GET /api/me` → `{user:{id,display_name,username}}`.
- `POST /api/logout` JSON `{}`; revokes current session.
- Every mutation requires matching `Origin` and `Content-Type: application/json`. Cookies are HttpOnly and SameSite=Strict, plus Secure and `__Host-` in production.
- Eight-hour opaque random sessions are stored only as SHA-256 hashes. Inactive staff are rejected on every request.
- Body limit 64 KiB; login rate limit five attempts per source address/account per 15 minutes; do not trust forwarded IP headers. Limiter is per instance. Shared throttling and credential recovery must precede broader production rollout.

## Read contract

- `GET /api/branches` → `{branches:[{id,name,timezone,permissions:[]}]}`.
- `GET /api/specialties` → `{specialties:[{code,name_ar}]}`.
- `GET /api/branches/:branch/patients?q=...` → `{patients:[]}`; max 100.
- `GET /api/branches/:branch/patients/:patient` → `{patient}` (demographics).
- `GET .../:patient/plans` → `{plans:[]}` with `steps`; clinical permission required, financial fields omitted without finance.read.
- `GET .../:patient/visits` → `{visits:[]}`; clinical permission required.
- `GET .../:patient/statement` → `{balances:[{currency,balance}],entries:[]}`; finance permission required.

All patient routes require patient.read in the requested branch and patient membership in that branch. Record properties follow SQL snake_case. No public patient data route exists.

## Commands

`POST /api/branches/:branch/commands` accepts `{key,command,payload}`. Key must be a UUID unique to the intended operation, reused only on retries of that same payload. Command/payload contracts are in `db/002_commands.sql`. Decimal values are strings, never floating-point JSON numbers. Actor comes exclusively from the authenticated session. Response is the real committed SQL command result `{id,command}`. Errors are `{error:CODE}` and never include SQL or secrets.

## Operator bootstrap

After migrations, invoke `node server/bootstrap.mjs` against the admin connection with `ADMIN_USERNAME`, `ADMIN_DISPLAY_NAME`, and `BRANCH_NAME`; supply a 12–256-character password through a secure stdin pipe. No password argument or log. The CLI refuses to proceed if any login account exists. Bootstrap does not run on server startup. There is no public bootstrap endpoint or default credential.

`/health/live` checks HTTP process; `/health/ready` checks database/schema availability and returns 503 otherwise.

Security integration checks: `node --test server/auth.test.mjs`.
