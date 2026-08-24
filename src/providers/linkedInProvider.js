const normalizer = require("../services/normalizer");

class LinkedInProvider {
  /**
   * Constructs a standard public LinkedIn company search URL if company LinkedIn wasn't found directly on website
   */
  generateCompanySearchUrl(companyName) {
    if (!companyName) return null;
    const cleanName = encodeURIComponent(companyName.trim());
    return `https://www.linkedin.com/company/${cleanName.toLowerCase()}`;
  }

  /**
   * Normalizes LinkedIn URL
   */
  cleanLinkedInUrl(rawUrl) {
    if (!rawUrl) return null;
    const match = rawUrl.match(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/company\/[a-zA-Z0-9_-]+/i);
    return match ? match[0] : null;
  }
}

module.exports = new LinkedInProvider();
