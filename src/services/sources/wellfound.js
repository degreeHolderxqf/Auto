const https = require("https");
const logger = require("../../services/logger");

class WellfoundAdapter {
  constructor() {
    this.baseUrl = "https://angel.co/api";
  }

  /**
   * Fetch jobs from Wellfound (AngelList) public API
   * @param {Object} options - Fetch options
   * @param {string} options.role - Job role (e.g., "engineering")
   * @param {number} options.limit - Max jobs to fetch
   * @param {string} options.remoteOnly - Filter remote-only jobs
   * @returns {Promise<Array>} Array of job objects
   */
  async fetchJobs({ role = "engineering", limit = 100, remoteOnly = true }) {
    return new Promise((resolve, reject) => {
      const path = `/jobs?role=${role}&limit=${limit}${remoteOnly ? "&remote=true" : ""}`;
      const options = {
        hostname: "angel.co",
        path: path,
        method: "GET",
        headers: {
          "Accept": "application/json",
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
            reject(new Error(`Wellfound API error: ${res.statusCode}`));
            return;
          }
          try {
            const parsed = JSON.parse(data);
            const jobs = Array.isArray(parsed) ? parsed : (parsed.jobs || []);
            resolve(jobs);
          } catch (e) {
            reject(new Error(`Failed to parse Wellfound response: ${e.message}`));
          }
        });
      });

      req.on("error", (e) => {
        reject(new Error(`Wellfound request error: ${e.message}`));
      });

      req.end();
    });
  }

  /**
   * Normalize a Wellfound job to canonical format
   * @param {Object} job - Raw Wellfound job
   * @returns {Object} Normalized job object
   */
  normalizeJob(job) {
    const company = job.company || job.startup || {};
    const isRemote = job.remote_ok || job.location?.toLowerCase().includes("remote") || false;

    // Extract salary range
    let salaryMin = null;
    let salaryMax = null;
    let salaryCurrency = "USD";

    if (job.equity_min || job.salary_min) {
      salaryMin = job.salary_min || null;
    }
    if (job.salary_max) {
      salaryMax = job.salary_max;
    }
    if (job.currency) {
      salaryCurrency = job.currency;
    }

    return {
      company_name: company.name || company.company_name || "Unknown",
      company_domain: company.url || company.domain || "",
      title: job.title || "Untitled Position",
      description: job.description || "",
      requirements: "",
      skills: (job.tags || []).join(", "),
      employment_type: job.job_type || "full_time",
      experience_level: job.experience_level || job.seniority || "",
      location: isRemote ? "Remote" : (job.location || ""),
      location_restrictions: isRemote ? "" : (job.location || ""),
      salary_min: salaryMin,
      salary_max: salaryMax,
      salary_currency: salaryCurrency,
      application_url: job.url || job.apply_url || "",
    };
  }
}

module.exports = new WellfoundAdapter();