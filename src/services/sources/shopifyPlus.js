const https = require("https");
const logger = require("../../services/logger");

/**
 * Shopify Plus Agency Career Boards Adapter
 * Scrapes career pages from known Shopify Plus agency partners
 * These agencies specialize in Shopify development and often hire remote developers
 */
class ShopifyPlusAdapter {
  constructor() {
    this.agencies = [
      { name: "Shopify", careersUrl: "https://www.shopify.com/careers" },
      { name: "Pixel Union", careersUrl: "https://pixelunion.net/careers" },
      { name: "TFG", careersUrl: "https://www.tfg.co/careers" },
      { name: "Culty", careersUrl: "https://cultivatemarketing.com/careers" },
      { name: "Mighty Oak", careersUrl: "https://www.mightyoak.co/careers" },
      { name: "Switch", careersUrl: "https://switchstudios.io/careers" },
    ];
  }

  /**
   * Fetch jobs from a specific agency career page
   * Note: This uses a simplified scraping approach. For production use,
   * agencies with Greenhouse/Lever integration should use those adapters instead
   * @param {Object} agency - Agency object with name and careersUrl
   * @param {Object} options - Fetch options
   * @returns {Promise<Array>} Array of normalized job objects
   */
  async fetchAgencyJobs(agency, { limit = 50 } = {}) {
    try {
      const jobs = await this.scrapeCareerPage(agency.careersUrl, limit);
      return jobs.map((job) => ({
        ...job,
        company_name: agency.name,
        source_type: "shopify_plus_agency",
        source_url: agency.careersUrl,
      }));
    } catch (err) {
      logger.warn(`Failed to fetch jobs from ${agency.name}: ${err.message}`);
      return [];
    }
  }

  /**
   * Scrape a career page for job listings
   * @param {string} url - Career page URL
   * @param {number} limit - Max jobs to fetch
   * @returns {Promise<Array>} Array of raw job objects
   */
  async scrapeCareerPage(url, limit = 50) {
    return new Promise((resolve, reject) => {
      try {
        const parsed = new URL(url);
        const options = {
          hostname: parsed.hostname,
          path: parsed.pathname,
          method: "GET",
          headers: {
            "Accept": "text/html,application/xhtml+xml",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
          },
          timeout: 10000
        };

        const req = https.request(options, (res) => {
          let data = "";

          res.on("data", (chunk) => {
            data += chunk;
          });

          res.on("end", () => {
            if (res.statusCode !== 200) {
              reject(new Error(`HTTP ${res.statusCode}`));
              return;
            }
            try {
              const jobs = this.parseHTML(data, limit);
              resolve(jobs);
            } catch (e) {
              reject(new Error(`HTML parse error: ${e.message}`));
            }
          });
        });

        req.on("error", (e) => {
          reject(new Error(`Request error: ${e.message}`));
        });

        req.on("timeout", () => {
          req.destroy();
          reject(new Error("Request timeout"));
        });

        req.end();
      } catch (e) {
        reject(e);
      }
    });
  }

  /**
   * Parse HTML content to extract job listings
   * Basic implementation - real agencies use Greenhouse/Lever APIs
   * @param {string} html - HTML content
   * @param {number} limit - Max jobs to extract
   * @returns {Array} Array of job objects
   */
  parseHTML(html, limit) {
    const jobs = [];
    // Very basic job extraction from common patterns
    // In production, this would use a proper HTML parser like cheerio

    // Look for common job listing patterns
    const jobPatterns = [
      /<(?:a|h[1-6])[^>]*href=["']([^"']*apply[^"']*)["'][^>]*>([^<]*(?:Shopify|Shopify|web|developer|engineer|Remix|React)[^<]*)<\/a>/gi,
      /<li[^>]*class=["'][^"']*job[^"']*["'][^>]*>[\s\S]*?<a[^>]*href=["']([^"']*)["'][^>]*>([^<]*)<\/a>[\s\S]*?<\/li>/gi,
    ];

    for (const pattern of jobPatterns) {
      let match;
      while ((match = pattern.exec(html)) !== null && jobs.length < limit) {
        const applicationUrl = match[1];
        const title = (match[2] || "").trim();

        if (title && applicationUrl && !jobs.find((j) => j.title === title)) {
          jobs.push({
            title,
            application_url: applicationUrl.startsWith("http") ? applicationUrl : `https://example.com${applicationUrl}`,
            employment_type: "full_time",
            location: "Remote",
            description: "",
            requirements: "",
            skills: "Shopify, Liquid, React, Node.js",
            salary_min: null,
            salary_max: null,
            salary_currency: "USD",
          });
        }
      }
    }

    return jobs;
  }

  /**
   * Normalize a Shopify Plus agency job to canonical format
   * @param {Object} job - Raw job object
   * @returns {Object} Normalized job object
   */
  normalizeJob(job) {
    // Check if job mentions Shopify-related technologies
    const shopifyKeywords = ["Shopify", "Liquid", "Remix", "React", "Node.js", "GraphQL", "Storefront", "Hydrogen", "Headless"];
    const description = `${job.description || ""} ${job.requirements || ""} ${job.skills || ""}`;
    const hasShopifyKeywords = shopifyKeywords.some((kw) =>
      description.toLowerCase().includes(kw.toLowerCase())
    );

    return {
      company_name: job.company_name || "Unknown",
      company_domain: job.company_domain || "",
      title: job.title || "Untitled Position",
      description: job.description || "",
      requirements: job.requirements || "",
      skills: job.skills || "",
      employment_type: job.employment_type || "full_time",
      experience_level: job.experience_level || "",
      location: job.location || "Remote",
      location_restrictions: job.location_restrictions || "",
      salary_min: job.salary_min || null,
      salary_max: job.salary_max || null,
      salary_currency: job.salary_currency || "USD",
      application_url: job.application_url || "",
      source_type: job.source_type || "shopify_plus_agency",
      source_url: job.source_url || "",
    };
  }

  /**
   * Get list of known Shopify Plus agencies
   * @returns {Array} Array of agency objects
   */
  getAgencies() {
    return this.agencies;
  }

  /**
   * Add a custom agency to track
   * @param {string} name - Agency name
   * @param {string} careersUrl - Career page URL
   */
  addAgency(name, careersUrl) {
    if (!this.agencies.find((a) => a.name === name)) {
      this.agencies.push({ name, careersUrl });
      logger.info(`Added Shopify Plus agency: ${name}`);
    }
  }
}

module.exports = new ShopifyPlusAdapter();