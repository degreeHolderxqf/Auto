/**
 * Freelance Scoring Service
 *
 * Calculates multi-dimensional scores for freelance opportunities:
 * - Service clarity score (how well their services are communicated)
 * - Portfolio score (quality/listing completeness of portfolio items)
 * - Tech depth score (breadth of tech stack evidence)
 * - Geographic reach score (global vs local market presence)
 * - Contact accessibility score (availability of contact info)
 * - Responsiveness score (evidence of quick communication)
 * - Overall freelance lead score (composite, 0-100)
 */

const normalizer = require("./normalizer");

const freelanceScoring = {
  /**
   * Score how clearly and specifically the company advertises their services.
   * Looks for specificity, technical depth, and service categorization.
   */
  calculateServiceClarity(services = [], description = "") {
    let score = 0;
    const text = `${description || ""} ${Array.isArray(services) ? services.join(" ") : ""}`.toLowerCase();
    const serviceList = Array.isArray(services) ? services : [];

    // Base: number of distinct services listed
    if (serviceList.length >= 5) score += 30;
    else if (serviceList.length >= 3) score += 20;
    else if (serviceList.length >= 1) score += 10;

    // Specific, technical service terms add quality
    const technicalTerms = [
      "custom app", "hydrogen", "headless", "checkout ui", "checkout extensibility",
      "graphql", "storefront api", "admin api", "webhook", "theme app extension",
      "oxygen", "polaris", "shopify plus", "plus merchant", "migration",
      "pos integration", "multi-vendor", "subscription", "dropshipping"
    ];

    const techMatches = technicalTerms.filter(term => text.includes(term));
    score += Math.min(30, techMatches.length * 5);

    // Generic/mkt terms don't add much
    const genericTerms = ["design", "development", "marketing", "consulting", "agency"];
    const genericMatches = genericTerms.filter(term => text.includes(term));
    score += genericMatches.length <= 2 ? 5 : 0;

    // Description quality: longer, more detailed descriptions
    if (description && description.length > 200) score += 10;
    if (description && description.length > 500) score += 5;

    return Math.min(100, score);
  },

  /**
   * Score the completeness and quality of portfolio items.
   */
  calculatePortfolioScore(portfolioItems = [], clientTestimonials = []) {
    if (!portfolioItems || portfolioItems.length === 0) return 0;

    let score = 0;

    // Number of portfolio items
    if (portfolioItems.length >= 10) score += 30;
    else if (portfolioItems.length >= 5) score += 25;
    else if (portfolioItems.length >= 3) score += 20;
    else if (portfolioItems.length >= 1) score += 10;

    // Quality: items with descriptions, URLs, or stats
    const detailedItems = portfolioItems.filter(item =>
      item && (item.description || item.url || item.results || item.metrics)
    );
    score += Math.min(30, detailedItems.length * 10);

    // Client testimonials add credibility
    if (clientTestimonials && clientTestimonials.length > 0) {
      score += 10;
      if (clientTestimonials.length >= 3) score += 5;
    }

    return Math.min(100, score);
  },

  /**
   * Score the depth of technical stack evidence.
   */
  calculateTechDepthScore(techStack = [], techStackEvidence = []) {
    const stackText = `${Array.isArray(techStack) ? techStack.join(" ") : ""} ${Array.isArray(techStackEvidence) ? techStackEvidence.join(" ") : ""}`.toLowerCase();
    const techItems = Array.isArray(techStack) ? techStack : [];
    const evidenceItems = Array.isArray(techStackEvidence) ? techStackEvidence : [];

    let score = 0;

    // Breadth of technologies
    if (techItems.length >= 10) score += 30;
    else if (techItems.length >= 5) score += 25;
    else if (techItems.length >= 3) score += 20;
    else if (techItems.length >= 1) score += 10;

    // Shopify-specific tech depth
    const shopifyTech = ["shopify", "hydrogen", "oxygen", "polaris", "liquid", "theme app extension", "checkout ui", "storefront api", "admin api", "webhook", "graphql"];
    const shopifyMatches = shopifyTech.filter(term => stackText.includes(term));
    score += Math.min(25, shopifyMatches.length * 5);

    // Evidence quality
    score += Math.min(15, evidenceItems.length * 5);

    return Math.min(100, score);
  },

  /**
   * Score geographic reach and market presence.
   */
  calculateGeographicScore(geographicEvidence = [], country = null) {
    let score = 0;
    const evidence = Array.isArray(geographicEvidence) ? geographicEvidence : [];

    // More geographic evidence = broader reach
    if (evidence.length >= 5) score += 30;
    else if (evidence.length >= 3) score += 25;
    else if (evidence.length >= 1) score += 15;

    // International presence
    const evidenceText = evidence.map(e => typeof e === "string" ? e : JSON.stringify(e)).join(" ").toLowerCase();
    const countries = ["usa", "uk", "canada", "australia", "germany", "france", "singapore", "uae", "netherlands"];
    const intlCount = countries.filter(c => evidenceText.includes(c));
    score += Math.min(25, intlCount.length * 5);

    // Company country
    if (country) {
      const countryUpper = country.toUpperCase();
      if (["US", "GB", "CA", "AU", "DE", "SG", "AE", "NL"].includes(countryUpper)) {
        score += 15;
      } else {
        score += 5;
      }
    }

    return Math.min(100, score);
  },

  /**
   * Score contact accessibility based on available contact info.
   */
  calculateContactAccessibilityScore(company = null, contacts = []) {
    let score = 0;

    // Contact info on company
    if (company) {
      if (company.email) score += 20;
      if (company.phone || company.normalized_phone) score += 15;
      if (company.linkedin_url) score += 10;
      if (company.careers_url) score += 10;
      if (company.official_website) score += 10;
    }

    // Number of contacts found
    const contactCount = Array.isArray(contacts) ? contacts.length : 0;
    if (contactCount >= 5) score += 20;
    else if (contactCount >= 3) score += 15;
    else if (contactCount >= 1) score += 10;

    // Contact quality
    if (contactCount > 0) {
      const highConfidence = contacts.filter(c => c.confidence === "HIGH");
      const mediumConfidence = contacts.filter(c => c.confidence === "MEDIUM");
      score += Math.min(10, highConfidence.length * 10);
      score += Math.min(5, mediumConfidence.length * 5);
    }

    return Math.min(100, score);
  },

  /**
   * Score responsiveness based on evidence of timely communication.
   */
  calculateResponsivenessScore(responsivenessEvidence = []) {
    if (!Array.isArray(responsivenessEvidence) || responsivenessEvidence.length === 0) return 0;

    let score = 0;

    // More evidence of responsiveness
    score += Math.min(30, responsivenessEvidence.length * 10);

    // Evidence text
    const text = responsivenessEvidence.map(e => typeof e === "string" ? e : JSON.stringify(e)).join(" ").toLowerCase();
    if (text.includes("24h") || text.includes("24 hour") || text.includes("same day")) score += 25;
    if (text.includes("48h") || text.includes("48 hour") || text.includes("1-2 day")) score += 15;
    if (text.includes("response") || text.includes("reply") || text.includes("turnaround")) score += 15;

    return Math.min(100, score);
  },

  /**
   * Calculate composite freelance lead score (0-100).
   * Weights:
   * - Service clarity: 20
   * - Portfolio: 20
   * - Tech depth: 15
   * - Geographic reach: 15
   * - Contact accessibility: 15
   * - Responsiveness: 10
   * - Employee verification: 5
   */
  calculateFreelanceLeadScore(company = {}, contacts = [], leadDetails = {}) {
    let score = 0;

    const serviceClarity = this.calculateServiceClarity(
      company.service_offerings || leadDetails.service_offerings || [],
      company.store_description || company.notes || ""
    );
    score += serviceClarity * 0.20;

    const portfolio = this.calculatePortfolioScore(
      leadDetails.portfolio_items || [],
      leadDetails.client_testimonials || []
    );
    score += portfolio * 0.20;

    const techDepth = this.calculateTechDepthScore(
      company.tech_stack || leadDetails.tech_stack_evidence || [],
      leadDetails.tech_stack_evidence || []
    );
    score += techDepth * 0.15;

    const geographic = this.calculateGeographicScore(
      leadDetails.geographic_evidence || [],
      company.country
    );
    score += geographic * 0.15;

    const contactAccess = this.calculateContactAccessibilityScore(company, contacts);
    score += contactAccess * 0.15;

    const responsiveness = this.calculateResponsivenessScore(
      leadDetails?.qualification_evidence?.responsiveness || []
    );
    score += responsiveness * 0.10;

    // Employee verification bonus
    if (company.employee_count_verified) {
      score += 5;
    }

    return Math.min(100, Math.round(score));
  },

  /**
   * Quick scoring for a freelance company without deep lead details.
   * Falls back to simpler signals when deep evidence is not yet collected.
   */
  calculateQuickLeadScore(company = {}, contacts = []) {
    return this.calculateFreelanceLeadScore(company, contacts, {});
  }
};

module.exports = freelanceScoring;
