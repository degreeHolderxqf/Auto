const db = require("../db/database");
const logger = require("./logger");
const normalizer = require("./normalizer");
const scoring = require("./scoring");

class JobService {
  constructor() {
    this.jobScoring = scoring;
  }

  /**
   * Generate a canonical ID for deduplication
   * Normalizes company name + job title
   */
  generateCanonicalId(companyName, jobTitle) {
    if (!companyName || !jobTitle) return null;

    const normCompany = normalizer.normalizeCompanyName(companyName);
    const normTitle = normalizer.normalizeJobTitle(jobTitle);
    return `${normCompany}|${normTitle}`;
  }

  /**
   * Upsert jobs array (insert or update by canonical_id)
   * @param {Array} jobs - Array of job objects
   * @returns {Object} { inserted, updated }
   */
  async upsertJobs(jobs) {
    let inserted = 0;
    let updated = 0;

    for (const job of jobs) {
      try {
        // Generate canonical ID for deduplication
        const canonicalId = this.generateCanonicalId(job.company_name, job.title);
        if (!canonicalId) {
          logger.warn("Skipping job due to missing company name or title:", job);
          continue;
        }

        // Check if job already exists
        const existing = db.getRawDb()
          .prepare("SELECT id FROM jobs WHERE canonical_id = ?")
          .get(canonicalId);

        // Prepare job data for insertion/update
        const jobData = {
          canonical_id: canonicalId,
          title: job.title,
          company_name: job.company_name,
          company_domain: job.company_domain || "",
          description: job.description || "",
          requirements: job.requirements || "",
          skills: job.skills || "",
          employment_type: job.employment_type || "",
          experience_level: job.experience_level || "",
          location: job.location || "",
          location_restrictions: job.location_restrictions || "",
          salary_min: job.salary_min || null,
          salary_max: job.salary_max || null,
          salary_currency: job.salary_currency || "USD",
          relevance_score: job.relevance_score || 0,
          match_reason: job.match_reason || "",
          status: job.status || "new",
          application_url: job.application_url || "",
          updated_at: new Date().toISOString()
        };

        if (existing) {
          // Update existing job
          const keys = Object.keys(jobData);
          const setClause = keys.map((key) => `${key} = ?`).join(", ");
          const values = keys.map((key) => jobData[key]);

          db.getRawDb()
            .prepare(`UPDATE jobs SET ${setClause} WHERE id = ?`)
            .run(...values, existing.id);

          updated++;
          logger.debug(`Updated job: ${job.title} at ${job.company_name}`);
        } else {
          // Insert new job
          const keys = Object.keys(jobData);
          const columns = keys.join(", ");
          const placeholders = keys.map(() => "?").join(", ");
          const values = keys.map((key) => jobData[key]);

          db.getRawDb()
            .prepare(`INSERT INTO jobs (${columns}) VALUES (${placeholders})`)
            .run(...values);

          inserted++;
          logger.debug(`Inserted job: ${job.title} at ${job.company_name}`);
        }
      } catch (err) {
        logger.error(`Error processing job ${job.title}:`, err.message);
        // Continue processing other jobs
      }
    }

    logger.info(`Job upsert complete: ${inserted} inserted, ${updated} updated`);
    return { inserted, updated };
  }

  /**
   * Score jobs that don't have relevance scores
   * @param {Array} jobIds - Array of job IDs to score
   * @returns {Object} { scored, skipped }
   */
  async scoreJobs(jobIds) {
    let scored = 0;
    let skipped = 0;

    for (const jobId of jobIds) {
      try {
        const job = db.getRawDb()
          .prepare("SELECT * FROM jobs WHERE id = ?")
          .get(jobId);

        if (!job) {
          logger.warn(`Job not found for ID: ${jobId}`);
          skipped++;
          continue;
        }

        // Skip if job already has a relevance score (above 0)
        if (job.relevance_score && job.relevance_score > 0) {
          skipped++;
          continue;
        }

        // Calculate Shopify relevance score
        const servicesText = [
          job.company_name,
          job.company_domain,
          job.skills,
          job.requirements
        ].filter(Boolean).join(" ");
        const appRelevanceScore = this.jobScoring.calculateAppRelevance(
          servicesText,
          job.description || "",
          "", // tier
          null // publicApps
        );

        // Update job with new score
        db.getRawDb()
          .prepare(`
            UPDATE jobs
            SET relevance_score = ?,
                match_reason = ?,
                updated_at = ?
          `)
          .run(
            appRelevanceScore,
            `Auto-scored based on ${job.title} content`,
            new Date().toISOString()
          );

        scored++;
        logger.debug(`Scored job ${job.id}: ${job.title} -> ${appRelevanceScore}`);
      } catch (err) {
        logger.error(`Error scoring job ID ${jobId}:`, err.message);
        skipped++;
      }
    }

    logger.info(`Job scoring complete: ${scored} scored, ${skipped} skipped`);
    return { scored, skipped };
  }

  /**
   * Get job by ID
   * @param {number} id - Job ID
   * @returns {Object|null} Job object or null
   */
  getJobById(id) {
    return db.getRawDb()
      .prepare("SELECT * FROM jobs WHERE id = ?")
      .get(id);
  }

  /**
   * Get job by canonical ID
   * @param {string} canonicalId - Canonical ID
   * @returns {Object|null} Job object or null
   */
  getJobByCanonicalId(canonicalId) {
    return db.getRawDb()
      .prepare("SELECT * FROM jobs WHERE canonical_id = ?")
      .get(canonicalId);
  }

  /**
   * Get jobs with optional filtering
   * @param {Object} filters - Filter options
   * @returns {Array} Array of job objects
   */
  getJobs(filters = {}) {
    let query = `
      SELECT id, canonical_id, title, company_name, company_domain, employment_type,
             experience_level, location, location_restrictions, salary_min, salary_max,
             salary_currency, relevance_score, match_reason, status, application_url,
             created_at, updated_at
      FROM jobs
    `;
    const params = [];
    const conditions = [];

    if (filters.status) {
      conditions.push("status = ?");
      params.push(filters.status);
    }

    if (filters.minRelevance !== undefined && filters.minRelevance !== null) {
      conditions.push("relevance_score >= ?");
      params.push(filters.minRelevance);
    }

    if (filters.employmentType) {
      conditions.push("employment_type = ?");
      params.push(filters.employmentType);
    }

    if (filters.location) {
      conditions.push("location LIKE ?");
      params.push(`%${filters.location}%`);
    }

    if (filters.companyName) {
      conditions.push("company_name LIKE ?");
      params.push(`%${filters.companyName}%`);
    }

    if (conditions.length > 0) {
      query += " WHERE " + conditions.join(" AND ");
    }

    query += " ORDER BY relevance_score DESC, created_at DESC";

    if (filters.limit) {
      query += " LIMIT ?";
      params.push(filters.limit);
    }

    return db.getRawDb().prepare(query).all(params);
  }
}

module.exports = new JobService();