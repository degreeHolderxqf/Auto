const crypto = require("crypto");
const db = require("../db/database");
const logger = require("./logger");
const jobService = require("./jobService");

class JobRunsService {
  constructor() {
    // Serverless-safe: state lives in SQLite, not in memory
  }

  /**
   * Create a new job run
   * @param {string} type - Run type (DISCOVERY, SCORING, PREPARATION)
   * @param {string} source - Source name (e.g., "himalayas", "greenhouse")
   * @param {number} targetCount - Target number of candidates
   * @returns {string} Run ID
   */
  async createRun(type, source = null, targetCount = 100) {
    try {
      const runId = `run_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
      const checkpointData = JSON.stringify({
        source,
        targetCount,
        processedSources: [],
        cursor: 0
      });

      const now = new Date().toISOString();

      db.getRawDb()
        .prepare(`
          INSERT INTO job_runs (id, type, status, last_cursor, processed_count, success_count, started_at, checkpoint_data)
          VALUES (?, ?, 'running', ?, 0, 0, ?, ?)
        `)
        .run(runId, type, "0", now, checkpointData); // last_cursor is TEXT — keep as string

      logger.info(`Created job run: ${runId} (type: ${type}, source: ${source || "N/A"})`);
      return runId;
    } catch (err) {
      logger.error("Error creating job run:", err.message);
      throw err;
    }
  }

  /**
   * Process the next chunk of a discovery run
   * @param {string} runId - Run ID
   * @param {number} chunkSize - Number of items to process in this chunk
   * @returns {Object} { completed, processed, successCount, hasMore }
   */
  async processNextChunk(runId, chunkSize = 25) {
    try {
      // Fetch run state
      const run = db.getRawDb()
        .prepare("SELECT * FROM job_runs WHERE id = ?")
        .get(runId);

      if (!run) {
        throw new Error(`Run not found: ${runId}`);
      }

      if (run.status === "completed" || run.status === "failed") {
        return {
          completed: true,
          processed: run.processed_count,
          successCount: run.success_count,
          hasMore: false,
          message: `Run already in terminal state: ${run.status}`
        };
      }

      // Parse checkpoint data
      let checkpoint = {};
      try {
        checkpoint = JSON.parse(run.checkpoint_data || "{}");
      } catch {
        checkpoint = {};
      }

      const source = checkpoint.source || "himalayas";
      const cursor = parseInt(run.last_cursor || "0", 10);
      const targetCount = checkpoint.targetCount || 100;
      const processedSources = checkpoint.processedSources || [];

      // Simulate discovery chunk processing
      // In a real implementation, this would call the appropriate source adapter
      // For now, return chunk metadata
      const newProcessed = Math.min(cursor + chunkSize, targetCount);
      const completed = newProcessed >= targetCount;
      const newSuccess = Math.min(newProcessed, chunkSize);

      // Update run state
      const now = new Date().toISOString();
      const updatedCheckpoint = JSON.stringify({
        ...checkpoint,
        processedSources: [...processedSources, `${source}_${cursor}_${newProcessed}`],
        cursor: newProcessed
      });

      const newStatus = completed ? "completed" : "running";

      db.getRawDb()
        .prepare(`
          UPDATE job_runs
          SET last_cursor = ?,
              processed_count = ?,
              success_count = success_count + ?,
              status = ?,
              checkpoint_data = ?,
              completed_at = ?
          WHERE id = ?
        `)
        .run(
          String(newProcessed),
          newProcessed,
          newSuccess,
          newStatus,
          updatedCheckpoint,
          completed ? now : null,
          runId
        );

      logger.info(`Processed chunk for run ${runId}: ${cursor}-${newProcessed} (${source})`);

      return {
        completed,
        processed: newProcessed,
        successCount: newSuccess,
        hasMore: !completed,
        cursor: newProcessed,
        message: completed ? "Run completed" : "Chunk processed successfully"
      };
    } catch (err) {
      // Mark run as failed
      try {
        db.getRawDb()
          .prepare("UPDATE job_runs SET status = 'failed', error_message = ? WHERE id = ?")
          .run(err.message, runId);
      } catch (updateErr) {
        logger.error("Failed to mark run as failed:", updateErr.message);
      }

      logger.error(`Error processing chunk for run ${runId}:`, err.message);
      throw err;
    }
  }

  /**
   * Resume a paused or failed run
   * @param {string} runId - Run ID
   * @returns {Object} { resumed, run }
   */
  async resumeRun(runId) {
    try {
      const run = db.getRawDb()
        .prepare("SELECT * FROM job_runs WHERE id = ?")
        .get(runId);

      if (!run) {
        throw new Error(`Run not found: ${runId}`);
      }

      // Reset to running state if failed/paused
      if (run.status === "failed" || run.status === "queued") {
        db.getRawDb()
          .prepare(`
            UPDATE job_runs
            SET status = 'running',
                error_message = NULL,
                started_at = ?
            WHERE id = ?
          `)
          .run(new Date().toISOString(), runId);
      }

      logger.info(`Resumed run: ${runId}`);
      return {
        resumed: true,
        run: db.getRawDb()
          .prepare("SELECT * FROM job_runs WHERE id = ?")
          .get(runId)
      };
    } catch (err) {
      logger.error(`Error resuming run ${runId}:`, err.message);
      throw err;
    }
  }

  /**
   * Get run status
   * @param {string} runId - Run ID
   * @returns {Object|null} Run object or null
   */
  getRun(runId) {
    return db.getRawDb()
      .prepare("SELECT * FROM job_runs WHERE id = ?")
      .get(runId);
  }

  /**
   * Get recent runs
   * @param {number} limit - Number of runs to fetch
   * @returns {Array} Array of run objects
   */
  getRecentRuns(limit = 10) {
    return db.getRawDb()
      .prepare(`
        SELECT id, type, status, last_cursor, processed_count, success_count,
               error_message, started_at, completed_at, checkpoint_data
        FROM job_runs
        ORDER BY started_at DESC
        LIMIT ?
      `)
      .all(limit);
  }
}

module.exports = new JobRunsService();