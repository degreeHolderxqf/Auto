const scoring = {
  /**
   * Calculates APP_RELEVANCE_SCORE (0 - 100) based on services, descriptions, and partner profile info.
   */
  calculateAppRelevance(servicesText, description = "", tier = "", publicApps = null) {
    const text = `${servicesText || ""} ${description || ""}`.toLowerCase();
    const tierLower = (tier || "").toLowerCase();

    // Check for Public Apps
    const hasPublicApps = (publicApps && (Array.isArray(publicApps) ? publicApps.length > 0 : publicApps.toString().length > 2)) ||
      text.includes("public app") || text.includes("shopify app store") || text.includes("apps on shopify");

    if (hasPublicApps) {
      return 100;
    }

    // Check for App Development & GraphQL / APIs / Custom Apps
    const hasCustomApps = text.includes("custom app") || text.includes("app development") || text.includes("app dev");
    const hasApis = text.includes("graphql") || text.includes("shopify api") || text.includes("rest api") || text.includes("webhook") || text.includes("systems integration");

    if (hasCustomApps && hasApis) {
      return 95;
    }

    if (hasCustomApps) {
      return 90;
    }

    // Check for Shopify Plus & Advanced Development
    const isPlus = tierLower.includes("plus") || tierLower.includes("platinum") || tierLower.includes("premier") || text.includes("shopify plus");
    const hasHeadless = text.includes("headless") || text.includes("hydrogen") || text.includes("remix") || text.includes("checkout upgrade") || text.includes("checkout extensibility") || text.includes("custom functions");

    if (isPlus && hasHeadless) {
      return 85;
    }

    if (isPlus || hasHeadless) {
      return 80;
    }

    // Check for General Shopify Development & Integrations
    const hasDevelopment = text.includes("development") || text.includes("customization") || text.includes("theme customization") || text.includes("troubleshooting");
    const hasIntegration = text.includes("integration") || text.includes("migration") || text.includes("pos");

    if (hasDevelopment && hasIntegration) {
      return 70;
    }

    if (hasDevelopment) {
      return 60;
    }

    // Basic store setup / catalog
    const hasStoreSetup = text.includes("store setup") || text.includes("store build") || text.includes("product and collection");
    if (hasStoreSetup) {
      return 50;
    }

    // Marketing / Design only
    const hasMarketing = text.includes("marketing") || text.includes("seo") || text.includes("branding") || text.includes("content") || text.includes("photography");
    if (hasMarketing) {
      return 30;
    }

    return 40; // Default minimum baseline for listed Shopify Partners
  },

  /**
   * Calculates overall LEAD_SCORE (0 - 100)
   * Weighting:
   * - Shopify App relevance: 40
   * - Public Shopify app evidence: 20
   * - Shopify Plus / advanced Shopify: 10
   * - Recruitment contact found: 15
   * - Email confidence: 10
   * - Company quality/rating: 5
   */
  calculateLeadScore(company, bestContact = null) {
    let score = 0;

    // 1. Shopify App Relevance (max 40)
    const appRel = company.app_relevance_score || 0;
    score += (appRel / 100) * 40;

    // 2. Public Shopify App Evidence (max 20)
    const hasPublicApps = (company.public_apps && company.public_apps.length > 2) || (company.shopify_services && company.shopify_services.toLowerCase().includes("public app"));
    if (hasPublicApps) {
      score += 20;
    } else if (company.shopify_services && company.shopify_services.toLowerCase().includes("custom app")) {
      score += 12;
    }

    // 3. Shopify Plus / Advanced Shopify (max 10)
    const isPlus = (company.partner_tier && (company.partner_tier.toLowerCase().includes("plus") || company.partner_tier.toLowerCase().includes("platinum") || company.partner_tier.toLowerCase().includes("premier")));
    if (isPlus) {
      score += 10;
    } else if (company.shopify_services && (company.shopify_services.toLowerCase().includes("headless") || company.shopify_services.toLowerCase().includes("checkout"))) {
      score += 7;
    }

    // 4. Recruitment Contact Found (max 15)
    if (bestContact) {
      if (bestContact.email_type === "HR / Recruitment") {
        score += 15;
      } else if (bestContact.email_type === "Hiring Management") {
        score += 12;
      } else if (bestContact.email_type === "Personal / Professional") {
        score += 8;
      } else {
        score += 5;
      }
    }

    // 5. Email Confidence (max 10)
    if (bestContact) {
      if (bestContact.confidence === "HIGH") {
        score += 10;
      } else if (bestContact.confidence === "MEDIUM") {
        score += 6;
      } else {
        score += 2;
      }
    }

    // 6. Company Quality / Rating (max 5)
    const rating = company.rating ? parseFloat(company.rating) : 0;
    const reviews = company.reviews ? parseInt(company.reviews, 10) : 0;
    if (rating >= 4.8 && reviews >= 10) {
      score += 5;
    } else if (rating >= 4.5 || reviews >= 5) {
      score += 3;
    } else if (rating > 0) {
      score += 2;
    }

    return Math.min(100, Math.round(score));
  }
};

module.exports = scoring;
