# Bulk lead enrichment

This workflow accepts a CSV or JSON list, queries a configured enrichment API, and uses a robots.txt-aware static crawler only when the API returns no contact signals. Each output row contains a domain, one email (or a blank email when public social links are the only result), the source (`API` or `Web`), and social links as JSON.

## Files

```text
src/
  providers/
    contactEnrichmentApi.js       # Generic API adapter (Hunter/Apollo-style mapping)
    respectfulDomainCrawler.js   # Axios + Cheerio crawler with robots checks
  services/
    bulkInputProcessor.js        # CSV and JSON input parsing
  workflows/
    bulkLeadEnrichment.js        # Concurrency, fallback, and CSV export
```

## Input examples

CSV:

```csv
domain,company_name
example.com,Example Company
,Second Company
```

JSON:

```json
[
  { "domain": "example.com", "company_name": "Example Company" },
  { "company_name": "Second Company" }
]
```

The accepted field names include `domain`, `website`, `website_url`, `url`, `company_domain`, `company_name`, `company`, `organization`, and `name`.

## API contract and configuration

Set `BULK_ENRICHMENT_API_URL` to a provider adapter or mock endpoint. The workflow sends a GET request with either `domain=<domain>` or `company_name=<name>`, adds `Authorization: Bearer <key>` when `BULK_ENRICHMENT_API_KEY` is set, and expects JSON. It accepts a provider-neutral response such as:

```json
{
  "domain": "example.com",
  "emails": [{ "email": "hello@example.com" }],
  "socialLinks": {
    "linkedin": "https://www.linkedin.com/company/example",
    "twitter": "@example"
  }
}
```

It also maps common `emails`, `people`, `contacts`, `linkedin_url`, and `twitter_url` fields. For a real Hunter or Apollo account, configure a small adapter endpoint that converts that provider's response into this contract; no provider account details or keys are bundled in this module.

## Run

```sh
npm run bulk-enrich -- --input=data/targets.csv --output=output/enriched_leads.csv --concurrency=3
```

Concurrency is capped at five. API calls are serialized with at least 2.5 seconds between requests. Web requests are paced per origin by at least 2.5 seconds, or longer when robots.txt specifies a crawl delay. The crawler checks robots.txt before the homepage and checks its rules for both `/` and `/contact`. It stops on robots errors, HTTP 403/429, timeouts, or redirects whose destination policy has not been checked.
