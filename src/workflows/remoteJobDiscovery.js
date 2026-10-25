/**
 * Remote Job Discovery Workflow
 *
 * Serverless-safe, chunked job discovery pipeline:
 * 1. Fetch jobs from configured sources (Himalayas, Greenhouse, Lever, WWR, Wellfound, Shopify Plus)
 * 2. Normalize and deduplicate against existing jobs table
 * 3. Score jobs by relevance (Shopify Core + Modern Stack + India-compatible)
 * 4. Checkpoint progress in job_runs after each chunk
 * 5. Return results so frontend can poll for next chunk
 *
 * NEVER processes bulk operations in a single synchronous HTTP request.
 * Uses job_runs table as the execution state store for serverless resumability.
 */

const config = require("../config");
const db = require("../db/database");
const logger = require("../services/logger");
const jobService = require("../services/jobService");
const jobRunsService = require("../services/jobRunsService");

// Lazy-load source adapters
let adapters = null;

function getAdapters() {
  if (!adapters) {
    adapters = {
      himalayas: require("../services/sources/himalayas"),
      greenhouse: require("../services/sources/greenhouse"),
      lever: require("../services/sources/lever"),
      wwr: require("../services/sources/wwr"),
      wellfound: require("../services/sources/wellfound"),
      shopifyPlus: require("../services/sources/shopifyPlus"),
    };
  }
  return adapters;
}

/**
 * Source adapters registry
 * Maps source names to their adapter instances
 */
const SOURCE_REGISTRY = {
  himalayas: {
    adapter: "himalayas",
    fetchFn: "fetchJobs",
    normalizeFn: "normalizeJob",
    maxPerRun: 100,
  },
  greenhouse: {
    adapter: "greenhouse",
    fetchFn: "fetchBoardJobs",
    normalizeFn: "normalizeJob",
    maxPerRun: 100,
  },
  lever: {
    adapter: "lever",
    fetchFn: "fetchBoardJobs",
    normalizeFn: "normalizeJob",
    maxPerRun: 100,
  },
  wwr: {
    adapter: "wwr",
    fetchFn: "fetchJobs",
    normalizeFn: "normalizeJob",
    maxPerRun: 100,
  },
  wellfound: {
    adapter: "wellfound",
    fetchFn: "fetchJobs",
    normalizeFn: "normalizeJob",
    maxPerRun: 100,
  },
  shopify_plus: {
    adapter: "shopifyPlus",
    fetchFn: "fetchAgencyJobs",
    normalizeFn: "normalizeJob",
    maxPerRun: 50,
  },
};

/**
 * Main discovery entry point
 * Creates a new job run and returns the runId for polling
 *
 * @param {Object} options - Discovery options
 * @param {string} options.source - Source name (default: "himalayas")
 * @param {number} options.targetCount - Target number of jobs (default: from config)
 * @returns {Promise<string>} Run ID
 */
async function runDiscovery(options = {}) {
  const source = options.source || "himalayas";
  const targetCount = options.targetCount || config.maxRemoteJobsPerSource;

  // Check if discovery is enabled
  if (!config.remoteJobDiscoveryEnabled) {
    logger.warn("Remote job discovery is disabled in config");
    return null;
  }

  // Create a new run
  const runId = await jobRunsService.createRun("DISCOVERY", source, targetCount);
  logger.info(`Remote discovery started: runId=${runId}, source=${source}, target=${targetCount}`);

  return runId;
}

/**
 * Process a single chunk of jobs
 * Called repeatedly by the frontend polling loop
 *
 * @param {string} runId - Run ID from job_runs
 * @param {number} chunkSize - Items per chunk (default: 25)
 * @returns {Promise<Object>} Chunk result
 */
async function processChunk(runId, chunkSize = 25) {
  const run = jobRunsService.getRun(runId);
  if (!run) {
    throw new Error(`Run not found: ${runId}`);
  }

  // Parse checkpoint to get current state
  let checkpoint = {};
  try {
    checkpoint = JSON.parse(run.checkpoint_data || "{}");
  } catch {
    checkpoint = {};
  }

  const source = checkpoint.source || run.last_cursor?.split("|")[0] || "himalayas";
  const sourceOffset = parseInt(checkpoint.offset || "0", 10);
  const adapter = getAdapters()[source];

  if (!adapter) {
    throw new Error(`Unknown source: ${source}`);
  }

  // Fetch a chunk of raw jobs from source
  const rawJobs = await fetchFromSource(adapter, source, {
    limit: chunkSize,
    offset: sourceOffset,
  });

  // Normalize jobs to canonical format
  const normalizedJobs = rawJobs.map((j) => adapter.normalizeJob(j));

  // Upsert jobs (deduplication + insertion)
  const { inserted, updated } = await jobService.upsertJobs(normalizedJobs);

  // Score the new jobs
  const newJobIds = await getNewlyInsertedJobIds(normalizedJobs);
  let scored = 0;
  if (newJobIds.length > 0) {
    const scoreResult = await jobService.scoreJobs(newJobIds);
    scored = scoreResult.scored;
  }

  // Update checkpoint
  const newOffset = sourceOffset + rawJobs.length;
  const completed = rawJobs.length < chunkSize || newOffset >= (checkpoint.targetCount || 100);

  // Update run state
  await jobRunsService.processNextChunk(runId, chunkSize);

  logger.info(
    `Chunk processed: runId=${runId}, source=${source}, fetched=${rawJobs.length}, ` +
    `inserted=${inserted}, updated=${updated}, scored=${scored}`
  );

  return {
    runId,
    source,
    fetched: rawJobs.length,
    inserted,
    updated,
    scored,
    offset: newOffset,
    completed,
    hasMore: !completed,
  };
}

/**
 * Fetch raw jobs from a source adapter
 * @param {Object} adapter - Source adapter instance
 * @param {string} source - Source name
 * @param {Object} options - Fetch options
 * @returns {Promise<Array>} Raw job objects
 */
async function fetchFromSource(adapter, source, options = {}) {
  const { limit = 25, offset = 0 } = options;

  try {
    switch (source) {
      case "himalayas":
        return await adapter.fetchJobs({ limit, offset });

      case "greenhouse":
        // For greenhouse, we'd need a specific board token
        // In production, this would come from the checkpoint or a configured list
        return [];

      case "lever":
        // For lever, same as greenhouse
        return [];

      case "wwr":
        return await adapter.fetchJobs({ category: "remote-programming-jobs", limit });

      case "wellfound":
        return await adapter.fetchJobs({ role: "engineering", limit, remoteOnly: true });

      case "shopify_plus":
        // Fetch from first agency in list (production would iterate through all)
        const agencies = adapter.getAgencies();
        if (agencies.length > 0) {
          return await adapter.fetchAgencyJobs(agencies[0], { limit });
        }
        return [];

      default:
        logger.warn(`Unknown source: ${source}`);
        return [];
    }
  } catch (err) {
    logger.error(`Error fetching from ${source}:`, err.message);
    return []; // Continue with other sources on error
  }
}

/**
 * Get IDs of newly inserted jobs for scoring
 * @param {Array} jobs - Normalized jobs that were just upserted
 * @returns {Promise<Array>} Array of job IDs
 */
async function getNewlyInsertedJobIds(jobs) {
  const ids = [];
  for (const job of jobs) {
    const canonicalId = jobService.generateCanonicalId(job.company_name, job.title);
    if (canonicalId) {
      const existing = jobService.getJobByCanonicalId(canonicalId);
      if (existing) {
        // Only score if it doesn't already have a score
        if (!existing.relevance_score || existing.relevance_score === 0) {
          ids.push(existing.id);
        }
      }
    }
  }
  return ids;
}

/**
 * Run the full discovery workflow (for local/server environments)
 * In serverless, prefer runDiscovery() + processChunk() polling instead
 *
 * @param {Object} options - Discovery options
 * @returns {Promise<Object>} Final results
 */
async function runFullDiscovery(options = {}) {
  const runId = await runDiscovery(options);
  if (!runId) {
    return { success: false, message: "Discovery disabled or failed to start" };
  }

  const results = {
    runId,
    sources: [],
    totalFetched: 0,
    totalInserted: 0,
    totalUpdated: 0,
    totalScored: 0,
  };

  const chunkSize = options.chunkSize || 25;
  let hasMore = true;

  while (hasMore) {
    try {
      const chunk = await processChunk(runId, chunkSize);
      results.sources.push({
        source: chunk.source,
        fetched: chunk.fetched,
        inserted: chunk.inserted,
        scored: chunk.scored,
      });
      results.totalFetched += chunk.fetched;
      results.totalInserted += chunk.inserted;
      results.totalUpdated += chunk.updated;
      results.totalScored += chunk.scored;
      hasMore = chunk.hasMore;
    } catch (err) {
      logger.error("Chunk processing error:", err.message);
      results.error = err.message;
      break;
    }
  }

  const finalRun = jobRunsService.getRun(runId);
  results.status = finalRun?.status || "unknown";
  results.success = finalRun?.status === "completed";

  return results;
}

module.exports = {
  runDiscovery,
  processChunk,
  runFullDiscovery,
  getAdapters,
  SOURCE_REGISTRY,
};
