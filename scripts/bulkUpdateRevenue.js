"use strict";

const db = require("../src/db/database");
const { estimateStoreRevenue } = require("../src/services/revenueEstimator");

const DELAY_BETWEEN_ESTIMATES_MS = 1000;

function getShopifyCompanies() {
  const database = db.getRawDb();
  return database.prepare(`
    SELECT
      c.id AS company_id,
      COALESCE(NULLIF(TRIM(c.domain), ''), NULLIF(TRIM(m.website_url), '')) AS domain
    FROM companies c
    JOIN merchant_lead_details m ON m.company_id = c.id
    WHERE COALESCE(NULLIF(TRIM(c.domain), ''), NULLIF(TRIM(m.website_url), '')) IS NOT NULL
    ORDER BY c.id
  `).all();
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  const companies = getShopifyCompanies();
  let updated = 0;
  let failed = 0;

  console.log(`Found ${companies.length} merchant storefronts to estimate.`);

  for (let index = 0; index < companies.length; index += 1) {
    const company = companies[index];
    const domain = String(company.domain || "").trim();
    const progress = `[${index + 1}/${companies.length}]`;

    try {
      const estimate = await estimateStoreRevenue(domain);
      db.upsertMerchantRevenueEstimate({
        ...estimate,
        company_id: company.company_id,
        domain: estimate.domain || domain
      });
      updated += 1;
      console.log(
        `${progress} Updated ${domain}: traffic=${estimate.estimated_traffic}, ` +
        `monthly revenue=USD ${Number(estimate.estimated_monthly_revenue).toFixed(2)}`
      );
    } catch (error) {
      failed += 1;
      console.error(`${progress} Failed ${domain}: ${error.message}`);
    }

    if (index < companies.length - 1) {
      await delay(DELAY_BETWEEN_ESTIMATES_MS);
    }
  }

  console.log(`Revenue update complete: ${updated} updated, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Bulk revenue update failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { getShopifyCompanies, main };
