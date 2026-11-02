# Shopify Store Performance & CRO Audits

The audit workflow is for existing Shopify merchant leads in the outreach application. It does not alter agency/partner discovery, existing email templates, or WhatsApp sending. A report-mode audit creates a multi-page, evidence-based review; the older PageSpeed-only output remains available for audits that do not have saved storefront crawl data.

## Configuration

PageSpeed Insights needs a backend API key. Gemini may personalize the email draft, but report generation and a verified-evidence email fallback do not depend on Gemini being available:

```dotenv
PAGESPEED_API_KEY=...
# Optional: AI-assisted email draft; the system has a non-AI fallback.
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash
```

PageSpeed Insights uses Google's API quota. Page inspection is limited to a bounded set of public pages linked from the homepage and obeys the site's `robots.txt` policy. Gemini availability and pricing depend on the Google AI account and current plan. Keep keys on the backend; never use `NEXT_PUBLIC_*` variables for secrets.

## Workflow

1. Open **Store Performance Audits** in the existing frontend and select an imported Shopify merchant lead.
2. Select Option A (short email, no attachment) or Option B (email with PDF report), and mobile or desktop analysis.
3. The backend verifies the website host is public, inspects the homepage and a bounded set of linked product, collection, and policy pages, and requests a PageSpeed Insights performance run.
4. The report stores inspected and skipped page URLs, scope limitations, executive summary, priority counts, and findings with page evidence, impact, recommendations, effort estimates, confidence, and verification state. It does not attempt checkout or payment actions.
5. Gemini can select only an observation and solution from verified PageSpeed or storefront findings. If Gemini is unavailable, the system uses a concise template based on the same verified evidence. If no verified issue is available, no outreach draft is created.
6. Review the metrics, detailed findings, multi-page PDF, recipient, subject, and body. Edit and save the draft if needed.
7. Approve the draft. This locks it but does not send it. Sending is a separate explicit action.
8. The send endpoint uses the existing SMTP integration and dry-run setting, writes to `email_logs`, and blocks a merchant/contact already recorded as contacted. Existing WhatsApp routes and queues are untouched.

Audit results are stored in the `merchant_performance_audits` SQLite table; the detailed report is saved as JSON in an additive column so existing audit records remain valid. PDF downloads are available from the audit review whether or not a PDF attachment was selected for email. The email-mode selection controls attachment delivery only. API routes are documented in [the frontend API map](../../docs/frontend-api-map.md#8-shopify-store-performance-audits).

Findings that could not be confirmed from returned HTML are labelled `needs_verification`; JavaScript-rendered content may not be detected. The report does not claim that observed issues caused lost sales or conversions, and it does not guarantee outcomes.
