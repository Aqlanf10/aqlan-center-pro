# Synthetic browser rehearsal

Run `npm ci`, `npx playwright install chromium`, then `npm run test:browser` from the repository root. On Linux CI, use `npx playwright install --with-deps chromium` to install required browser libraries. This is an explicit integration command, separate from the Node unit-test glob; a missing browser fails the command rather than silently skipping it.

The harness starts the actual HTTP application on loopback port 43187, creates a fresh in-memory PGlite database with the numbered migrations, seeds one synthetic staff account with a random ephemeral password, and drives Chromium. No real patient data, external service, persisted password, or production fallback is involved. The browser and HTTP server close in `finally`.

Optional environment variables:

- `BROWSER_EXECUTABLE`: installed Chrome/Edge executable, otherwise Playwright Chromium.
- `BROWSER_ARTIFACT_DIR`: output directory for synthetic screenshots, including Arabic/English mobile plans and the English desktop account statement.
- `BROWSER_DATABASE_URL`: PostgreSQL connection to a fresh database whose name ends in `_browser_test`. Existing `clinic` schemas are rejected. Use a disposable cluster with no existing clinic roles: migration 004 creates cluster-wide roles. The harness leaves its synthetic database for inspection and never drops databases or roles. The PostgreSQL adapter uses a four-connection pool. Its operator credentials are for test setup; this harness alone does not certify a deployed restricted login.

The exercised journey covers Arabic-first RTL, language switching without losing login/search drafts, patient registration, exact calendar dates, new SAR agreement, an FDI tooth-linked procedure and signed visit without extra charges, 14,000 YER at 140 YER/SAR settling 100 SAR, an unknown legacy agreement rejected until review, a competing review invalidating an open approval dialog, explicit reload and activation, unchanged user-entered clinical text (including select options), revoked financial visibility, and 390-pixel Arabic/English layouts without page-level overflow.

The payment scenario deliberately drops a response after the server commits. The dialog keeps the original request key and payload, freezes fields, blocks close/Escape, warns before leaving the page, and retries without a second payment. The outcome stays explicitly unknown until the retry returns a committed result. No patient details or passwords are persisted to browser storage. Closing or reloading the browser despite its warning still loses the in-memory request; durable operator reconciliation after a restart remains a separate gap, so this test does not accept the full offline/recovery gate.

The scenario also expires the session while that outcome is unknown. A 401 preserves the locked original dialog and request key, with a same-origin `noopener` sign-in link to a new tab. Reauthenticating with the same account restores the shared session cookie; returning to the original tab retries that exact request and still produces one payment. Logging in as another account cannot bypass the server's actor-bound idempotency checks.

These assertions cover the current foundation, not the unimplemented specialty workflows, full accessibility, Safari/mobile devices, provider integrations, Railway deployment, concurrent financial transactions, or production readiness. Those need their own evidence.
