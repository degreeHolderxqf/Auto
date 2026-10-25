const https = require("https");
const logger = require("../../services/logger");

class WWRAdapter {
  constructor() {
    this.baseUrl = "https://weworkremotely.com";
  }

  /**
   * Fetch jobs from We Work Remotely RSS/API
   * @param {Object} options - Fetch options
   * @param {string} options.category - Job category (e.g., "remote-programming-jobs")
   * @param {number} options.limit - Max jobs to fetch
   * @returns {Promise<Array>} Array of job objects
   */
  async fetchJobs({ category = "remote-programming-jobs", limit = 100 }) {
    return new Promise((resolve, reject) => {
      const path = `/jobs/feed/${category}`;
      const options = {
        hostname: "weworkremotely.com",
        path: path,
        method: "GET",
        headers: {
          "Accept": "application/rss+xml, application/xml, text/xml",
          "User-Agent": "Mozilla/5.0 (compatible; JobDiscoveryBot/1.0)"
        }
      };

      const req = https.request(options, (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`WWR API error: ${res.statusCode}`));
            return;
          }
          try {
            // Parse RSS/XML
            const jobs = this.parseRSS(data);
            resolve(jobs.slice(0, limit));
          } catch (e) {
            reject(new Error(`Failed to parse WWR RSS: ${e.message}`));
          }
        });
      });

      req.on("error", (e) => {
        reject(new Error(`WWR request error: ${e.message}`));
      });

      req.end();
    });
  }

  /**
   * Parse RSS XML feed into job objects
   * @param {string} xml - RSS XML string
   * @returns {Array} Array of job objects
   */
  parseRSS(xml) {
    const jobs = [];
    // Simple regex-based XML parsing (avoiding external dependencies)
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;

    while ((match = itemRegex.exec(xml)) !== null) {
      const itemXml = match[1];
      const job = {
        title: this.extractXmlValue(itemXml, "title"),
        description: this.extractXmlValue(itemXml, "description"),
        company_name: this.extractXmlValue(itemXml, "company"),
        location: this.extractXmlValue(itemXml, "location"),
        application_url: this.extractXmlValue(itemXml, "link"),
        employment_type: "full_time",
        salary_min: null,
        salary_max: null,
        salary_currency: "USD"
      };

      // Extract salary if present
      const salaryStr = this.extractXmlValue(itemXml, "salary");
      if (salaryStr) {
        const salaryMatch = salaryStr.match(/(\d+)(?:\s*-\s*(\d+))?/);
        if (salaryMatch) {
          job.salary_min = parseInt(salaryMatch[1], 10);
          job.salary_max = salaryMatch[2] ? parseInt(salaryMatch[2], 10) : null;
        }
      }

      if (job.title && job.company_name) {
        jobs.push(job);
      }
    }

    return jobs;
  }

  /**
   * Extract value from XML tag
   * @param {string} xml - XML string
   * @param {string} tag - Tag name
   * @returns {string} Tag content
   */
  extractXmlValue(xml, tag) {
    const regex = new RegExp(`<${tag}><!\\[CDATA\\[([^\\]]*?)\\]\\]><\\/${tag}>|<${tag}>([^<]*)<\\/${tag}>`, "i");
    const match = xml.match(regex);
    if (match) {
      return (match[1] || match[2] || "").trim();
    }
    return "";
  }

  /**
   * Normalize a WWR job to canonical format
   * @param {Object} job - Raw WWR job
   * @returns {Object} Normalized job object
   */
  normalizeJob(job) {
    // Determine if remote
    const isRemote = job.location?.toLowerCase().includes("remote") ||
                     job.description?.toLowerCase().includes("anywhere") ||
                     job.description?.toLowerCase().includes("worldwide");

    return {
      company_name: job.company_name || "Unknown",
      company_domain: job.company_url || "",
      title: job.title || "Untitled Position",
      description: job.description || "",
      requirements: "",
      skills: "",
      employment_type: job.employment_type || "full_time",
      experience_level: "",
      location: isRemote ? "Remote (Worldwide)" : (job.location || "Remote"),
      location_restrictions: isRemote ? "" : job.location || "",
      salary_min: job.salary_min || null,
      salary_max: job.salary_max || null,
      salary_currency: job.salary_currency || "USD",
      application_url: job.application_url || job.link || "",
    };
  }
}

module.exports = new WWRAdapter();