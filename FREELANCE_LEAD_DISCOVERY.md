# Freelance and public job lead enrichment

## How it fits

```text
Manual job export / approved RSS / explicitly authorized board
                         |
                         v
        normalize + deduplicate job records
                         |
                         v
       extract URLs, domains, and company names
                |                     |
          domain found           name only
                |                     |
                |          configured search API lookup
                |                     |
                +----------+----------+
                           v
             companyWebsite.researchWebsite()
             (public contacts; robots.txt respected)
                           |
                           v
       output/freelance_leads.csv and .json
```

The existing `src/services/freelanceScraper.js` owns source ingestion, parsing,
bounded workers, enrichment, and exports. The existing
`src/providers/companyWebsite.js` handles public website contact discovery. The
new `freelance-leads` CLI command connects those pieces.

## Platform access notes

- Upwork ended support for job RSS feeds on August 20, 2024 ([Upwork help](https://support.upwork.com/hc/en-us/articles/52052528243731-RSS-deprecation)).
  Its [terms](https://www.upwork.com/legal) prohibit scraping site content. Use
  an operator-provided job export or another access method Upwork explicitly
  permits; this module does not automate Upwork.
- Fiverr's [terms](https://www.fiverr.com/legal-portal/legal-terms/terms-of-service)
  prohibit bots, crawlers, and scraping. This module does not automate Fiverr.
  Its buyer/seller workflows should stay on Fiverr.
- The Puppeteer adapter is for other boards only when their terms allow it and
  `robots.txt` permits the selected page. It stops on access challenges, 401,
  403, or 429 responses. It does not rotate user agents, use proxies, or bypass
  Cloudflare/captcha controls.

## Files and packages

```text
Testing/ccc/
  src/services/freelanceScraper.js   ingestion, parser, enrichment, CSV/JSON
  src/providers/companyWebsite.js    existing public email/contact researcher
  src/cli.js                         `freelance-leads` command
  data/freelance-jobs.json           optional operator-provided job export
  data/authorized-boards.json        optional explicitly authorized board config
  output/freelance_leads.csv         generated five-column export
  output/freelance_leads.json        generated JSON export
```

Packages used:

- `rss-parser` (new) for approved RSS feeds.
- `puppeteer` (already declared by this project) for explicitly authorized boards.
- Node built-ins and existing `companyWebsite` provider for parsing, bounded
  processing, public contact lookup, and output. No NLP package is required;
  company-name extraction uses conservative label patterns.

Install project dependencies from `Testing/ccc` with `npm install`.

## Import a job export

Create `data/freelance-jobs.json` as an array, or as `{ "jobs": [...] }`:

```json
[
  {
    "title": "Shopify theme refresh",
    "description": "We need help improving the storefront at https://store.example.org",
    "link": "https://jobs.example.org/posts/123",
    "platform": "Operator import"
  }
]
```

Run:

```powershell
npm run freelance-leads -- --input=data/freelance-jobs.json
```

The input row can also use `Job Title`, `Job Description`, `Job Link`, and
`Job Platform` keys. The output is written to `output/freelance_leads.csv` and
`output/freelance_leads.json`.

## Approved RSS

Only pass a feed from a source that publishes it for this use and whose terms
allow processing. The `--authorized` flag is an explicit operator assertion:

```powershell
npm run freelance-leads -- --rss=https://jobs.example.org/feed.xml --authorized --platform="Example Board"
```

The feed is read sequentially. `upwork.com` and `fiverr.com` hosts are rejected.

## Other authorized boards

Create `data/authorized-boards.json` with the page URL and CSS selectors for a
board whose terms permit automation. `authorized: true` records the operator's
access check; `robots.txt` is checked at runtime.

```json
[
  {
    "authorized": true,
    "platform": "Example Board",
    "url": "https://jobs.example.org/search?query=shopify",
    "selectors": {
      "item": ".job-card",
      "title": ".job-title",
      "description": ".job-description",
      "link": "a.job-link"
    }
  }
]
```

Run:

```powershell
npm run freelance-leads -- --boards=data/authorized-boards.json
```

The browser fetches one board at a time. Do not mark a board authorized unless
you have checked its terms and access permission.

## Domain and email enrichment

`extractDomains()` handles full URLs, bare hostnames, and `myshopify.com`
subdomains. If no domain appears, `extractCompanyNames()` looks for explicit
phrases such as “our company is Acme” or “brand: Acme”. It does not guess a
`.com` domain. A configured resolver may be injected for application use, or
the module uses SerpAPI when `SEARCH_PROVIDER=serpapi` and `SEARCH_API_KEY` are
set. Google Custom Search additionally needs `GOOGLE_CSE_ID` (the engine ID).
Google currently limits that JSON API to existing customers and has announced
a January 1, 2027 transition deadline ([Google documentation](https://developers.google.com/custom-search/v1/overview)),
so configure it only if your account is eligible.

Each selected domain is sent to the existing website researcher with
`respectRobots: true`. Email values come from public website pages and are not
read from the job board. Set `FREELANCE_MAX_CONCURRENCY` to a value from 1 to 4;
the worker pool caps larger values at 4 and defaults to 2.

The command only prepares a lead export. Review the source post, confirm the
company match, and follow the applicable platform rules before contacting anyone.
