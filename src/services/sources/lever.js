const https = require("https");
const logger = require("../../services/logger");

class LeverAdapter {
  constructor() {
    this.baseUrl = "https://api.lever.co/v0";
  }

  /**
   * Fetch jobs from a specific Lever board
   * @param {string} boardToken - Lever board token (e.g., "acme")
   * @param {Object} options - Fetch options
   * @param {number} options.limit - Max jobs to fetch
   * @param {number} options.offset - Offset for pagination
   * @returns {Promise<Array>} Array of job objects
   */
  async fetchBoardJobs(boardToken, { limit = 100, offset = 0 }) {
    return new Promise((resolve, reject) => {
      const path = `/postings/${boardToken}?limit=${limit}&skip=${offset}`;
      const options = {
        hostname: "api.lever.co",
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
            reject(new Error(`Lever API error: ${res.statusCode}`));
            return;
          }
          try {
            const parsed = JSON.parse(data);
            resolve(Array.isArray(parsed) ? parsed : []);
          } catch (e) {
            reject(new Error(`Failed to parse Lever response: ${e.message}`));
          }
        });
      });

      req.on("error", (e) => {
        reject(new Error(`Lever request error: ${e.message}`));
      });

      req.end();
    });
  }

  /**
   * Fetch jobs from a Lever board via public API
   * @param {string} boardUrl - Full board URL (e.g., https://jobs.lever.co/acme)
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
   * Extract board token from a Lever URL
   * @param {string} boardUrl - Full board URL
   * @returns {string|null} Board token
   */
  extractBoardToken(boardUrl) {
    try {
      const u = new URL(boardUrl);
      // Pattern: jobs.lever.co/{boardToken}
      const match = u.pathname.match(/^\/([^\/]+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  /**
   * Normalize a Lever job to canonical format
   * @param {Object} job - Raw Lever job
   * @returns {Object} Normalized job object
   */
  normalizeJob(job) {
    const locationStr = job.location || "";
    const employmentType = job.employment || "full_time";
    const commitment = job.commitment || "";

    return {
      company_name: job.company || "Unknown",
      company_domain: job.companyUrl || "",
      title: job.text || job.title || "Untitled Position",
      description: job.description || job.blocks || "",
      requirements: job.lists?.find((l) => l.text?.toLowerCase().includes("requirement"))?.text || "",
      skills: job.categories?.skills?.join(", ") || "",
      employment_type: employmentType,
      experience_level: job.categories?.level || "",
      location: locationStr,
      location_restrictions: job.location || "",
      salary_min: job.salary?.min || null,
      salary_max: job.salary?.max || null,
      salary_currency: job.salary?.currency || "USD",
      application_url: job.absolute_url || job.applyUrl || "",
    };
  }
}

module.exports = new LeverAdapter();