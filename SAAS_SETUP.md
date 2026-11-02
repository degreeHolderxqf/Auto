# SaaS Account Foundation

The account foundation uses durable PostgreSQL and is intentionally disabled until `DATABASE_URL` is configured. The HTTP servers do not run database migrations automatically.

## Configure and migrate

1. Configure `DATABASE_URL` for the intended PostgreSQL database and `APP_PUBLIC_URL` for the public frontend origin. For the Vercel serverless backend, copy Supabase's **Shared Pooler / Transaction** connection string from the project’s Connect dialog; do not use the direct `db.<project-ref>.supabase.co:5432` endpoint, which is IPv6-only unless the project has the IPv4 add-on. Use the exact pooler host and username shown by Supabase. Production email links require an HTTPS origin.
2. Configure `SMTP_USER` and `SMTP_PASS` on the backend to enable email verification and password reset.
3. Generate a long random `ADMIN_BOOTSTRAP_TOKEN`; set it only as a backend environment variable. Do not expose it through `NEXT_PUBLIC_*`.
4. Generate a separate random `CRON_SECRET` and configure it in both the backend and Vercel so the scheduled email worker remains protected.
5. Review the SQL migration and take a database backup before applying it.
6. From `Testing/ccc`, run `npm run migrate:saas` against the explicitly configured database.
7. Register with the authorized administrator email, request email verification, and verify the address from the emailed link. Sign in, then use the one-time token on the Account page to bind the administrator account.

The migration seeds the approved payment-launch time (`2026-11-02 12:00:00 UTC`). Accounts registered before that instant are grandfathered into unlimited access. New accounts can save five unique leads; duplicates do not use quota. Paid entitlements and payment-provider flows are not enabled.

## API and isolation status

- Session cookies are HttpOnly, SameSite=Lax, and Secure in production.
- Regular users can access their account summary and private saved-lead list only.
- Shared legacy SQLite APIs are administrator-only until their data and operations are migrated to user-scoped PostgreSQL storage.
- The account endpoint `POST /api/account/leads` accepts up to 100 candidate records, stores only the authenticated user's records, and returns HTTP 402 when the free quota prevents completing a batch.
- No production migration, provider integration, payment capture, or deployment is performed by this setup.

Run the backend unit tests with `npm test` from `Testing/ccc`. The frontend build is `npm run build` from `automationJobs/frontend`.
