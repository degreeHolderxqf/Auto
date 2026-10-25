const https = require("https");
const config = require("../../config");
const db = require("../../db/database");
const logger = require("../../services/logger");

class HimalayasAdapter {
  constructor() {
    this.baseUrl = "https://api.himalayas.co/v1";
  }

  /**
   * Fetch jobs from Himalayas API with pagination support
   * @param {Object} options - Fetch options
   * @param {number} options.limit - Max jobs to fetch
   * @param {number} options.offset - Offset for pagination
   * @returns {Promise<Array>} Array of job objects
   */
  async fetchJobs({ limit = 50, offset = 0 }) {
    return new Promise((resolve, reject) => {
      const path = "/companies?limit=" + limit + "&offset=" + offset;
      const options = {
        hostname: "api.himalayas.co",
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
            reject(new Error(`Himalayas API error: ${res.statusCode}`));
            return;
          }
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.results || parsed);
          } catch (e) {
            reject(new Error(`Failed to parse Himalayas response: ${e.message}`));
          }
        });
      });

      req.on("error", (e) => {
        reject(new Error(`Himalayas request error: ${e.message}`));
      });

      req.end();
    });
  }

  /**
   * Normalize a Himalayas job to canonical format
   * @param {Object} job - Raw Himalayas job
   * @returns {Object} Normalized job object
   */
  normalizeJob(job) {
    return {
      company_name: job.company_name || job.employer_name || "Unknown",
      company_domain: job.company_domain || "",
      title: job.title || "Untitled Position",
      description: job.description || job.summary || "",
      requirements: job.requirements || "",
      skills: job.skills || job.technologies || "",
      employment_type: job.employment_type || job.employmentType || "full_time",
      experience_level: job.experience_level || job.level || "",
      location: job.location || job.city || "",
      location_restrictions: job.location_restrictions || "",
      salary_min: job.salary_min || null,
      salary_max: job.salary_max || null,
      salary_currency: job.salary_currency || "USD",
      application_url: job.application_url || job.apply_url || "",
    };
  }
}

module.exports = new HimalayasAdapter();