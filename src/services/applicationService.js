const db = require("../db/database");
const logger = require("./logger");

class ApplicationService {
  constructor() {
    // Stateless service - all state in DB
  }

  /**
   * Valid application statuses
   */
  static VALID_STATUSES = [
    "ready",
    "preparing",
    "prepared",
    "manual_action_required",
    "applied",
    "rejected",
    "interviewing",
    "offer",
    "declined",
    "archived"
  ];

  /**
   * Upsert application (create or update)
   * @param {Object} data - Application data
   * @returns {Object} Result with application ID
   */
  async upsertApplication(data) {
    try {
      // Validate required fields
      if (!data.job_id) {
        throw new Error("job_id is required");
      }

      // Verify job exists
      const job = db.getRawDb()
        .prepare("SELECT id FROM jobs WHERE id = ?")
        .get(data.job_id);

      if (!job) {
        throw new Error(`Job not found with ID: ${data.job_id}`);
      }

      // Validate status
      if (data.status && !ApplicationService.VALID_STATUSES.includes(data.status)) {
        throw new Error(`Invalid status: ${data.status}. Must be one of: ${ApplicationService.VALID_STATUSES.join(", ")}`);
      }

      // Check if application already exists for this job
      const existing = db.getRawDb()
        .prepare("SELECT id FROM applications WHERE job_id = ?")
        .get(data.job_id);

      const now = new Date().toISOString();

      if (existing) {
        // Update existing application
        const updateFields = [];
        const updateValues = [];

        const allowedFields = [
          "status",
          "applied_at",
          "resume_version",
          "cover_letter",
          "screening_answers",
          "recruiter_email",
          "recruiter_phone",
          "notes"
        ];

        for (const field of allowedFields) {
          if (data[field] !== undefined) {
            updateFields.push(`${field} = ?`);
            updateValues.push(data[field]);
          }
        }

        // Always update updated_at
        updateFields.push("updated_at = ?");
        updateValues.push(now);
        updateValues.push(existing.id);

        db.getRawDb()
          .prepare(`UPDATE applications SET ${updateFields.join(", ")} WHERE id = ?`)
          .run(...updateValues);

        logger.info(`Updated application for job ${data.job_id}`);
        return { id: existing.id, updated: true, message: "Application updated" };
      } else {
        // Insert new application
        const columns = ["job_id", "status", "created_at", "updated_at"];
        const values = [data.job_id, data.status || "ready", now, now];
        const placeholders = ["?", "?", "?", "?"];

        const allowedFields = [
          "applied_at",
          "resume_version",
          "cover_letter",
          "screening_answers",
          "recruiter_email",
          "recruiter_phone",
          "notes"
        ];

        for (const field of allowedFields) {
          if (data[field] !== undefined) {
            columns.push(field);
            values.push(data[field]);
            placeholders.push("?");
          }
        }

        db.getRawDb()
          .prepare(`INSERT INTO applications (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`)
          .run(...values);

        const newId = db.getRawDb().prepare("SELECT last_insert_rowid() as id").get().id;

        logger.info(`Created application for job ${data.job_id}`);
        return { id: newId, updated: false, message: "Application created" };
      }
    } catch (err) {
      logger.error("Error upserting application:", err.message);
      throw err;
    }
  }

  /**
   * Get application by ID
   * @param {number} id - Application ID
   * @returns {Object|null} Application object or null
   */
  getApplicationById(id) {
    return db.getRawDb()
      .prepare(`
        SELECT a.*, j.title, j.company_name, j.relevance_score, j.status AS job_status,
               j.application_url, j.created_at AS job_created
        FROM applications a
        JOIN jobs j ON a.job_id = j.id
        WHERE a.id = ?
      `)
      .get(id);
  }

  /**
   * Get application by job ID
   * @param {number} jobId - Job ID
   * @returns {Object|null} Application object or null
   */
  getApplicationByJobId(jobId) {
    return db.getRawDb()
      .prepare(`
        SELECT a.*, j.title, j.company_name, j.relevance_score, j.status AS job_status,
               j.application_url, j.created_at AS job_created
        FROM applications a
        JOIN jobs j ON a.job_id = j.id
        WHERE a.job_id = ?
      `)
      .get(jobId);
  }

  /**
   * Get all applications with optional filtering
   * @param {Object} filters - Filter options
   * @returns {Array} Array of application objects
   */
  getApplications(filters = {}) {
    let query = `
      SELECT a.id, a.job_id, a.status, a.applied_at, a.resume_version, a.cover_letter,
             a.screening_answers, a.recruiter_email, a.recruiter_phone, a.notes,
             j.title, j.company_name, j.relevance_score, j.status AS job_status,
             j.application_url, j.created_at AS job_created
      FROM applications a
      JOIN jobs j ON a.job_id = j.id
    `;
    const params = [];
    const conditions = [];

    if (filters.status) {
      conditions.push("a.status = ?");
      params.push(filters.status);
    }

    if (filters.jobId) {
      conditions.push("a.job_id = ?");
      params.push(filters.jobId);
    }

    if (filters.companyName) {
      conditions.push("j.company_name LIKE ?");
      params.push(`%${filters.companyName}%`);
    }

    if (conditions.length > 0) {
      query += " WHERE " + conditions.join(" AND ");
    }

    query += " ORDER BY a.updated_at DESC";

    if (filters.limit) {
      query += " LIMIT ?";
      params.push(filters.limit);
    }

    return db.getRawDb().prepare(query).all(params);
  }

  /**
   * Update application status
   * @param {number} id - Application ID
   * @param {string} status - New status
   * @returns {Object} Result
   */
  async updateStatus(id, status) {
    if (!ApplicationService.VALID_STATUSES.includes(status)) {
      throw new Error(`Invalid status: ${status}`);
    }

    const now = new Date().toISOString();

    const result = db.getRawDb()
      .prepare("UPDATE applications SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, now, id);

    if (result.changes === 0) {
      throw new Error(`Application not found: ${id}`);
    }

    logger.info(`Updated application ${id} status to: ${status}`);
    return { id, status, updated: true };
  }

  /**
   * Mark application as applied
   * @param {number} id - Application ID
   * @param {string} resumeVersion - Resume version used
   * @returns {Object} Result
   */
  async markApplied(id, resumeVersion = null) {
    const now = new Date().toISOString();

    const updates = ["status = 'applied'", "applied_at = ?", "updated_at = ?"];
    const values = [now, now];

    if (resumeVersion) {
      updates.push("resume_version = ?");
      values.push(resumeVersion);
    }

    values.push(id);

    const result = db.getRawDb()
      .prepare(`UPDATE applications SET ${updates.join(", ")} WHERE id = ?`)
      .run(...values);

    if (result.changes === 0) {
      throw new Error(`Application not found: ${id}`);
    }

    logger.info(`Marked application ${id} as applied`);
    return { id, status: "applied", appliedAt: now };
  }

  /**
   * Delete application (soft delete - mark as archived)
   * @param {number} id - Application ID
   * @returns {Object} Result
   */
  async deleteApplication(id) {
    const now = new Date().toISOString();

    const result = db.getRawDb()
      .prepare("UPDATE applications SET status = 'archived', updated_at = ? WHERE id = ?")
      .run(now, id);

    if (result.changes === 0) {
      throw new Error(`Application not found: ${id}`);
    }

    logger.info(`Archived application ${id}`);
    return { id, archived: true };
  }

  /**
   * Get application statistics
   * @returns {Object} Stats object
   */
  getStats() {
    const stats = db.getRawDb()
      .prepare(`
        SELECT
          status,
          COUNT(*) as count
        FROM applications
        GROUP BY status
      `)
      .all();

    const result = {
      total: 0,
      byStatus: {}
    };

    for (const row of stats) {
      result.byStatus[row.status] = row.count;
      result.total += row.count;
    }

    return result;
  }
}

module.exports = new ApplicationService();