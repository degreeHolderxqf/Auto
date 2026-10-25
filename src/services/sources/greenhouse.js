const https = require("https");
const logger = require("../../services/logger");

class GreenhouseAdapter {
  constructor() {
    this.baseUrl = "https://api.greenhouse.io/v1";
  }

  /**
   * Fetch jobs from a specific Greenhouse board
   * @param {string} boardToken - Greenhouse board token
   * @param {Object} options - Fetch options
   * @param {number} options.limit - Max jobs to fetch
   * @param {number} options.offset - Offset for pagination
   * @returns {Promise<Array>} Array of job objects
   */
  async fetchBoardJobs(boardToken, { limit = 100, offset = 0 }) {
    return new Promise((resolve, reject) => {
      const path = `/v1/boards/${boardToken}/jobs?limit=${limit}&offset=${offset}`;
      const options = {
        hostname: "api.greenhouse.io",
        path: path,
        method: "GET",
        headers: {
          "Accept": "application/json",
        }
      };

      const req = https.request(options, (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Greenhouse API error: ${res.statusCode}`));
            return;
          }
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.jobs || []);
          } catch (e) {
            reject(new Error(`Failed to parse Greenhouse response: ${e.message}`));
          }
        });
      });

      req.on("error", (e) => {
        reject(new Error(`Greenhouse request error: ${e.message}`));
      });

      req.end();
    });
  }

  /**
   * Fetch jobs from a Greenhouse board via public API
   * @param {string} boardUrl - Full board URL (e.g., https://boards.greenhouse.io/acme)
   * @param {Object} options - Fetch options
   * @returns {Promise<Array>} Array of normalized job objects
   */
  async fetchJobsFromBoard(boardUrl, { limit = 100, offset = 0 }) {
    const boardToken = this.extractBoardToken(boardUrl);
    if (!boardToken) {
      throw new Error(`Could not extract board token from URL: ${boardUrl}`);
    }

    const jobs = await this.fetchBoardJobs(boardToken, { limit, offset });
    return jobs.map((j) => this.normalizeJob(j));
  }

  /**
   * Extract board token from a Greenhouse URL
   * @param {string} boardUrl - Full board URL
   * @returns {string|null} Board token
   */
  extractBoardToken(boardUrl) {
    try {
      const u = new URL(boardUrl);
      // Pattern: boards.greenhouse.io/{boardToken}
      const match = u.pathname.match(/^\/([^\/]+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  /**
   * Normalize a Greenhouse job to canonical format
   * @param {Object} job - Raw Greenhouse job
   * @returns {Object} Normalized job object
   */
  normalizeJob(job) {
    const locationStr = job.location ? (job.location.name || "") : "";
    return {
      company_name: job.company_name || job.employer_name || "Unknown",
      company_domain: job.company_domain || job.career_page_url || "",
      title: job.title || "Untitled Position",
      description: job.description || "",
      requirements: job.requirements || "",
      skills: job.tags || job.custom_fields?.technologies || "",
      employment_type: job.employment_type || job.workplace_type || "full_time",
      experience_level: job.seniority_level || "",
      location: locationStr,
      location_restrictions: job.location?.name || "",
      salary_min: job.salary_min || null,
      salary_max: job.salary_max || null,
      salary_currency: job.salary_currency || "USD",
      application_url: job.absolute_url || job.application_url || "",
    };
  }
}

module.exports = new GreenhouseAdapter();