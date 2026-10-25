# Shopify Revenue and Public Signal Enrichment

The merchant revenue enrichment is additive. It does not change Partner, App Store, freelance, scoring, email, WhatsApp, or general lead-discovery behavior. It uses a five-second storefront request deadline, HTTPS-only requests, public DNS/IP validation, validated redirects, a one-megabyte response limit, and at most two same-store product-page fallbacks.

## Free mode and available sources

`REVENUE_ESTIMATION_MODE` defaults to `free`. Free mode never calls DataForSEO, Similarweb, Semrush, or another paid traffic API, even when old provider credentials are present.

The collector can inspect:

- The public Shopify `/products.json?limit=30` feed, when it is accessible.
- Public homepage HTML and up to two same-origin product pages when the feed is blocked or lacks prices.
- Product JSON-LD, basic product metadata, titles, prices, variant prices, currency, product URLs, availability, product sample count, and observed price distribution.
- Shopify theme/CDN/markup signals and recognizable Judge.me, Loox, Yotpo, and Stamped integrations.
- Public JSON-LD aggregate review counts. A widget alone is not a review count or evidence of sales. Counts are the largest accessible per-product count observed, not a store-wide total; dated snapshots are retained and daily changes are reported when available.
- An optional imported Tranco domain rank. Rank is stored with its source, list identifier, and publication date. It is a popularity signal only and is never converted into monthly visits.

Public product prices are stored as product-price proxies, not verified average order value. Missing prices and currencies remain null; the service does not substitute a default price. A free rank or product catalog without a defensible monthly traffic figure produces `PARTIAL_DATA` and no revenue number.

## Optional rank import

Download a Tranco list from [Tranco](https://tranco-list.eu/) and record the exact list ID and publication date shown by the source. The CLI reads a local CSV and does not fetch a list automatically:

```powershell
node src/cli.js import-tranco --input="C:\data\tranco.csv" --publication-date=2026-10-24 --list-id=LIST_ID
```

The accepted row format is `rank,domain`; a `rank,domain` header is also accepted. Reimporting the same list ID replaces that dataset's ranks in a transaction rather than duplicating them. Use the source's actual publication date and stable list ID.

Tranco is a composite dataset whose source components have different licenses, including CC BY-NC for Cloudflare Radar. A publicly downloadable list is not automatically cleared for every commercial use; review the [source attribution and licenses](https://tranco-list.eu/) for your use case. Tranco describes its standard list as the average of provider rankings over the previous 30 days, and warns that rankings can change and are popularity rankings rather than visit counts. See its [methodology](https://tranco-list.eu/methodology).

## When revenue is estimated

Revenue is produced only when all inputs exist: an observed public product-price sample, verified currency, a configured external traffic provider, and explicit conversion-rate assumptions. The optional model is:

```text
estimated monthly revenue = provider traffic metric × configured conversion rate × median product-price proxy
```

The built-in DataForSEO adapter reports estimated organic and paid search traffic, not total site visits. Therefore any resulting revenue is a low-confidence search-traffic scenario, not actual sales or a total-site forecast. The low/base/high scenarios use the observed 25th percentile, median, and 75th percentile product prices with the configured conversion assumptions; they are not statistical confidence intervals. No category multiplier or review-widget uplift is applied.

To permit billable traffic requests, explicitly set:

```dotenv
REVENUE_ESTIMATION_MODE=paid
TRAFFIC_PROVIDER=dataforseo
DATAFORSEO_LOGIN=...
DATAFORSEO_PASSWORD=...
```

The existing conversion assumptions remain configurable with `REVENUE_LOW_CONVERSION_RATE`, `REVENUE_BASE_CONVERSION_RATE`, and `REVENUE_HIGH_CONVERSION_RATE`. Their defaults are assumptions, not measured store performance. Without successful provider traffic data, revenue and traffic remain null. Domain rank is never used as a traffic substitute.

No credential-free public source that provides a reliable merchant-specific revenue estimate is currently integrated. Third-party revenue estimates are not represented as merchant actuals.

## Statuses, storage, and API

The latest observation uses one of `ESTIMATED`, `PARTIAL_DATA`, `INSUFFICIENT_DATA`, `STORE_UNAVAILABLE`, `NOT_SHOPIFY`, or `RETRYABLE_ERROR`. Invalid or unsafe domains return the validation code `DOMAIN_INVALID`. Older `SUCCESS` rows remain supported. A later partial refresh does not erase a previously calculated estimate: `revenue_last_updated_at` is the latest attempt, and `revenue_estimate_updated_at` is the last successful calculation time.

Additive migrations extend `merchant_revenue_estimates` and create domain-rank dataset/rank and dated review-snapshot tables. Product signals, rank provenance, review observations, current status, and the prior valid calculated estimate are kept separate. Reimport and review snapshot writes are idempotent.

`GET /api/companies` preserves its existing response shape and `estimated_revenue` field. If a prior calculated monthly estimate exists it is formatted into that field, while structured properties expose the latest status, method, confidence, data sources, assumptions, product-price proxy, Shopify signals, rank, review observations, and both update timestamps. The existing `POST /api/companies/{id}/revenue-estimate` manual refresh remains available.

Discovery checks the existing enrichment cache before making a new request: estimated results refresh after the configured 30-day interval; other statuses retry after the configured 24-hour interval. In-flight requests for the same domain are deduplicated. Revenue failures are logged and do not stop discovery.

## Verification

Run the focused mocked checks from `Testing/ccc`:

```powershell
node test_revenue_estimator.js
```

The checks use an in-memory SQLite database and mocked storefront responses; they do not call paid services or live merchant websites.
