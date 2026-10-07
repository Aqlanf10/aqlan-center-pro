# Authenticated HTTP boundary (foundation)

`node server/start.mjs` serves `web/` and the API. This is a bounded foundation, not a completed clinic product.

Required environment: `DATABASE_URL` (runtime role, not migration owner), `APP_ORIGIN` (exact origin, no trailing slash), `NODE_ENV=production` and Railway `PORT`. Production requires HTTPS origin and rejects superuser/schema-owner DB identities. The `pg` driver is required for production; missing configuration/dependency fails closed. PGlite is used only by tests, never as a production fallback.

For a private database certificate issuer, supply its PEM trust root as
`DATABASE_CA_CERT`. The driver enables TLS with `rejectUnauthorized: true`,
validating the peer certificate and hostname. Do not add SSL query parameters to
`DATABASE_URL` with this setting: they can replace the driver's CA configuration,
so the application rejects that combination. No certificate or password is
written to the repository. See the [driver SSL contract](https://node-postgres.com/features/ssl).

## Authentication

- `POST /api/login` JSON `{username,password}`; generic invalid-credential response.
- `GET /api/me` → `{user:{id,display_name,username}}`.
- `POST /api/logout` JSON `{}`; revokes current session.
- Every mutation requires matching `Origin` and `Content-Type: application/json`. Cookies are HttpOnly and SameSite=Strict, plus Secure and `__Host-` in production.
- Eight-hour opaque random sessions are stored only as SHA-256 hashes. Inactive staff are rejected on every request.
- Body limit 64 KiB; login rate limit five attempts per source address/account per 15 minutes; do not trust forwarded IP headers. Limiter is per instance. Shared throttling and credential recovery must precede broader production rollout.

## Read contract

### Self-service account security (schema 007)

`GET /api/account/sessions` returns the authenticated account's
`{credentialVersion,sessions:[{id,createdAt,expiresAt,current}]}`. IDs are public
random UUIDs, never session token hashes. It requires no branch role and gives
no authority over another account. `POST /api/account/sessions/:id/revoke` with
`{}` revokes only an owned session; another account's ID returns the same 404 as
an absent ID. `POST /api/account/sessions/revoke-others` with `{}` retains the
current session and reports `revokedCount`. Revoking the current session clears
the cookie. Repeated no-op revocation of other sessions adds no success audit.

`POST /api/account/password` accepts exactly
`{currentPassword,newPassword,expectedCredentialVersion}`. The version comes from
the sessions read. Passwords are 12–256 characters; current-password verification
and salted scrypt hashing occur on the trusted server. Five attempts per account
per 15 minutes are allowed by the instance-local limiter; shared throttling is a
remaining production/scaling requirement. Incorrect current password returns
CURRENT_PASSWORD_INCORRECT without changing credentials. A successful change
atomically increments the credential version, revokes all sessions and requires
a new login. No new session is issued automatically.

Login creates sessions through a locked version check, so a password change that
wins a race cannot be followed by a valid login based on the previous credential
snapshot. Account operations recheck active identity/current session under that
same lock. Audit records contain fixed action/actor/session-ID/count/time fields,
never passwords, password hashes or cookie hashes. Transport failure after a
password POST has an uncertain outcome: sign in with the new password, or the old
one if the new one is rejected; do not automatically repeat the write. Password
recovery, MFA, staff provisioning and global role administration are not supplied
by this partial self-service delivery.

### Branch and patient reads

- `GET /api/branches` → `{branches:[{id,name,timezone,permissions:[]}]}`.
- `GET /api/specialties` → `{specialties:[{code,name_ar}]}`.
- `GET /api/branches/:branch/patients?q=...` → `{patients:[]}`; max 100.
- `GET /api/branches/:branch/patients/:patient` → `{patient}` (demographics).
- `GET .../:patient/plans` → `{plans:[]}` with `steps`; clinical permission required, financial fields omitted without finance.read.
- `GET .../:patient/visits` → `{visits:[]}`; clinical permission required.
- `GET .../:patient/statement` → `{balances:[{currency,balance}],entries:[]}`; finance permission required.

All patient routes require patient.read in the requested branch and patient membership in that branch. Record properties follow SQL snake_case. No public patient data route exists.

Calendar dates (`birth_date`, `as_of_date`, `occurred_on`, `effective_date`) are
`YYYY-MM-DD` strings or null, never instants converted through the host timezone.
Statement balances and entries use one PostgreSQL statement snapshot; all monetary
fields, including nested line debit/credit and payment exchange rates, are exact
decimal strings. Clients must not convert ledger amounts through floating point.

## Commands

`POST /api/branches/:branch/commands` accepts `{key,command,payload}`. Key must be a UUID unique to the intended operation, reused only on retries of that same payload. Command/payload contracts are in `db/002_commands.sql`. Decimal values are strings, never floating-point JSON numbers. Actor comes exclusively from the authenticated session. Response is the real committed SQL command result `{id,command}`. Errors are `{error:CODE}` and never include SQL or secrets.

Migration 005 updates that command contract: `legacy.review`, `legacy.activate`
and `plan.activate` require numeric `expectedVersion` from the displayed plan's
`version`. Review and activation each increment the version. A stale snapshot
returns `STALE_PLAN_VERSION` without posting; the operator must read and review
the current values explicitly. Exact retries keep the original version and key.
All required permissions, including payload-dependent financial permissions,
are rechecked before returning a saved result. Previous migration files remain
immutable; apply the numbered upgrade before deploying this client.

## Reviewed patient history (PAT-03 partial)

Migration 006 is required before serving this release; readiness rejects an older
schema. `GET /api/branches/:branch/patients/:patient/history` requires patient.read
and clinical.read. It returns `{patientId,branchId,scope:'branch',version,current,revisions}`;
an unreviewed branch has version 0, current null and an empty revision list. This
does not establish absence of allergies in this or any other branch.

`POST` to the same route additionally requires clinical.write and accepts
`{key,payload:{expectedVersion,medical,dental,allergies,source,reason,observedOn}}`.
Each section contains `{status,details}`: status is unknown, none or reported;
reported requires 3–6000 characters, while the other states require empty details.
Source is patient_report, guardian_report, record_review or clinician_review;
reason is 3–2000 characters and observedOn is a valid nonfuture branch-local date.
The authenticated actor and their display-name snapshot are assigned by the server.
Reviews append immutable versions. The result is `{id,version,command}`;
STALE_HISTORY_VERSION requires rereading and reviewing the newer information.
Use the exact same key and payload after an uncertain response. Permissions and
patient membership are rechecked before returning any previously committed result.
No charge, diagnosis or consent is created by recording this review.

## Operator bootstrap

After migrations, invoke `node server/bootstrap.mjs` against the admin connection with `ADMIN_USERNAME`, `ADMIN_DISPLAY_NAME`, and `BRANCH_NAME`; supply a 12–256-character password through a secure stdin pipe. No password argument or log. The CLI refuses to proceed if any login account exists. Bootstrap does not run on server startup. There is no public bootstrap endpoint or default credential.

`/health/live` checks HTTP process; `/health/ready` checks database/schema availability and returns 503 otherwise.

Security integration checks: `node --test server/auth.test.mjs`.
