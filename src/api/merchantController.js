const express = require("express");
const router = express.Router();
const merchantIngestion = require("../services/merchantIngestion");
const merchantTemplate = require("../services/merchantTemplate");
const outreachEmailGenerator = require("../services/outreachEmailGenerator");
const emailTemplates = require("../services/emailTemplates");
const QueueProcessor = require("../services/merchantQueue");
const db = require("../db/database");
const config = require("../config");
const logger = require("../services/logger");

/**
 * POST /api/merchant/ingest
 * Upload and parse merchant lead data (CSV or JSON)
 */
router.post("/ingest", async (req, res) => {
  try {
    const { filePath, skipDuplicates } = req.body;

    if (!filePath) {
      return res.status(400).json({
        success: false,
        error: "filePath is required in request body"
      });
    }

    // Validate file exists and format
    const ext = require("path").extname(filePath).toLowerCase();
    if (ext !== ".csv" && ext !== ".json") {
      return res.status(400).json({
        success: false,
        error: `Unsupported format: ${ext}. Use .csv or .json`
      });
    }

    // Check file exists
    try {
      fs.accessSync(filePath);
    } catch {
      return res.status(400).json({
        success: false,
        error: `File not found: ${filePath}`
      });
    }

    // Ingest leads
    const results = await merchantIngestion.ingest(filePath, {
      skipDuplicates: skipDuplicates !== undefined ? skipDuplicates : true
    });

    return res.json({
      success: true,
      message: `Merchant lead ingestion complete`,
      results: {
        imported: results.imported,
        skipped: results.skipped,
        errors: results.errors.length,
        leads: results.leads.length
      }
    });

  } catch (err) {
    logger.error("Merchant ingestion error:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Failed to process merchant ingestion"
    });
  }
});

/**
 * POST /api/merchant/preview
 * Generate personalized message preview for a specific lead
 */
router.post("/preview", async (req, res) => {
  try {
    const { leadId, channel } = req.body;

    if (!leadId) {
      return res.status(400).json({
        success: false,
        error: "leadId is required"
      });
    }

    if (!channel || (channel !== "email" && channel !== "whatsapp")) {
      return res.status(400).json({
        success: false,
        error: "channel must be 'email' or 'whatsapp'"
      });
    }

    // Fetch lead data from database
    const company = db.getCompanyById(leadId);
    if (!company) {
      return res.status(404).json({
        success: false,
        error: `Lead with ID ${leadId} not found`
      });
    }

    // Build lead data for templating
    const contacts = db.getContactsByCompanyId(leadId);
    const contact = contacts.length > 0 ? contacts[0] : null;

    const leadData = {
      id: leadId,
      store_name: company.name,
      domain: company.domain || "",
      installed_apps: company.shopify_services ? JSON.parse(company.shopify_services || "[]") : [],
      tech_stack: company.shopify_services ? JSON.parse(company.shopify_services || "[]") : [],
      contact_name: contact && contact.name ? contact.name : null,
      contact_email: contact && contact.email ? contact.email : null,
      contact_phone: contact && (contact.normalized_phone || contact.phone) ? (contact.normalized_phone || contact.phone) : (company.normalized_phone || company.phone),
      contact_email_type: contact && contact.email_type ? contact.email_type : null,
      contact_confidence: contact && contact.confidence ? contact.confidence : null
    };

    // Generate personalized message preview
    let preview = merchantTemplate.previewMessage(leadData, channel);
    let templateId = null;
    let templateTarget = null;
    if (channel === "email") {
      templateId = req.body.templateId || await emailTemplates.getActiveTemplateId();
      const selectedTemplate = (await emailTemplates.getTemplates()).find((item) => item.id === templateId);
      const rendered = await outreachEmailGenerator.generateEmail(leadData, contact, {
        templateId,
        baseMailOptions: preview
      });
      templateTarget = selectedTemplate ? selectedTemplate.target : templateId;
      preview = { ...preview, ...rendered, body: rendered.text };
    }

    if (!preview) {
      return res.status(400).json({
        success: false,
        error: "Could not generate message preview"
      });
    }

    // Get personalization details
    const details = merchantTemplate.getPersonalizationDetails(leadData);

    return res.json({
      success: true,
      preview: {
        to: preview.to,
        subject: channel === "email" ? preview.subject : null,
        body: preview.body || preview.text,
        html: preview.html || null,
        text: preview.text || preview.body,
        channel,
        templateId,
        templateTarget,
        leadId,
        storeName: details.storeName,
        domain: details.domain,
        installedApps: details.installedApps,
        techStack: details.techStack,
        primaryApp: details.primaryApp,
        hasEmail: details.hasEmail,
        hasPhone: details.hasPhone
      }
    });

  } catch (err) {
    logger.error("Merchant preview error:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Failed to generate message preview"
    });
  }
});

/**
 * POST /api/merchant/queue/start
 * Start queue processing with randomized delays
 */
router.post("/queue/start", async (req, res) => {
  try {
    const { leadIds, channel, dryRun, batchId } = req.body;

    if (!leadIds || !Array.isArray(leadIds) || leadIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: "leadIds array is required and must not be empty"
      });
    }

    if (!channel || (channel !== "email" && channel !== "whatsapp")) {
      return res.status(400).json({
        success: false,
        error: "channel must be 'email' or 'whatsapp'"
      });
    }

    // Generate batchId if not provided
    const id = batchId || `merchant_${channel}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Initialize queue processor
    const processor = new QueueProcessor({
      dryRun: dryRun !== undefined ? dryRun : config.dryRun,
      channel
    });

    // Process the batch
    const results = await processor.processBatch(leadIds, id, (progress) => {
      // Progress callback - could update UI or log
      logger.info(`Queue progress: ${progress.current}/${progress.total} - ${progress.result.status}`);
    });

    return res.json({
      success: true,
      message: `Merchant ${channel} batch processing started`,
      results: {
        batchId: processor.batchId,
        total: results.total,
        sent: results.sent,
        failed: results.failed,
        skipped: results.skipped,
        successRate: results.successRate
      }
    });

  } catch (err) {
    logger.error("Merchant queue start error:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Failed to start queue processing"
    });
  }
});

/**
 * GET /api/merchant/queue/status/:batchId
 * Get status of a running/resumed batch
 */
router.get("/queue/status/:batchId", async (req, res) => {
  try {
    const { batchId } = req.params;

    const batch = db.getEmailBatch(batchId);
    if (!batch) {
      return res.status(404).json({
        success: false,
        error: `Batch "${batchId}" not found`
      });
    }

    const items = db.getRawDb().prepare(`
      SELECT ebi.*, c.name as company_name, ct.email, ct.confidence as email_confidence,
             ct.phone, ct.normalized_phone
      FROM email_batch_items ebi
      LEFT JOIN companies c ON c.id = ebi.company_id
      LEFT JOIN contacts ct ON ct.id = ebi.contact_id
      WHERE ebi.batch_id = ?
      ORDER BY ebi.position ASC
    `).all(batchId);

    return res.json({
      success: true,
      batch: {
        id: batch.id,
        mode: batch.mode,
        status: batch.status,
        total: batch.total,
        sent: batch.sent,
        failed: batch.failed,
        pending: batch.pending,
        processing: batch.processing,
        results: {
          total: items.length,
          sent: items.filter((i) => i.status === "SENT").length,
          failed: items.filter((i) => i.status === "FAILED").length,
          pending: items.filter((i) => i.status === "PENDING").length,
          processing: items.filter((i) => i.status === "PROCESSING").length
        }
      }
    });

  } catch (err) {
    logger.error("Merchant queue status error:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Failed to get queue status"
    });
  }
});

/**
 * POST /api/merchant/queue/resume/:batchId
 * Resume a paused/stopped batch
 */
router.post("/queue/resume/:batchId", async (req, res) => {
  try {
    const { batchId } = req.params;

    const batch = db.getEmailBatch(batchId);
    if (!batch) {
      return res.status(404).json({
        success: false,
        error: `Batch "${batchId}" not found`
      });
    }

    // Get remaining pending items
    const database = db.getRawDb();
    const pendingItems = database.prepare(`
      SELECT ebi.*, c.name as company_name
      FROM email_batch_items ebi
      JOIN companies c ON c.id = ebi.company_id
      WHERE ebi.batch_id = ? AND ebi.status = 'PENDING'
      ORDER BY ebi.position ASC
    `).all(batchId);

    if (pendingItems.length === 0) {
      return res.json({
        success: true,
        message: "No pending items to resume",
        results: {
          sent: batch.sent,
          failed: batch.failed,
          pending: 0
        }
      });
    }

    // Re-initialize and process remaining items
    const { channel } = batch.mode || "email";
    const processor = new QueueProcessor({
      dryRun: config.dryRun,
      channel
    });

    // Process only remaining items
    const leadIds = pendingItems.map((item) => item.company_id);
    const results = await processor.processBatch(leadIds, batchId);

    return res.json({
      success: true,
      message: "Batch resumed and processed",
      results: {
        batchId,
        total: results.total,
        sent: results.sent,
        failed: results.failed,
        skipped: results.skipped
      }
    });

  } catch (err) {
    logger.error("Merchant queue resume error:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Failed to resume queue"
    });
  }
});

/**
 * GET /api/merchant/leads/eligible
 * Get eligible leads for merchant outreach
 */
router.get("/leads/eligible", async (req, res) => {
  try {
    const { limit, minScore, channel } = req.query;

    let leads;
    if (channel === "whatsapp") {
      leads = db.getEligibleForOutreach(
        limit ? parseInt(limit, 10) : null
      );
    } else {
      leads = merchantIngestion.getMerchantLeads({
        status: "DISCOVERED",
        minScore: minScore ? parseInt(minScore, 10) : null,
        hasEmail: true
      });
    }

    // Transform to response format
    const transformed = leads.map((lead) => ({
      id: lead.id,
      name: lead.name,
      domain: lead.domain,
      store_name: lead.name,
      contact_email: lead.email,
      contact_phone: lead.normalized_phone || lead.phone,
      lead_score: lead.lead_score,
      app_relevance_score: lead.app_relevance_score,
      installed_apps: lead.shopify_services ? JSON.parse(lead.shopify_services || "[]") : [],
      tech_stack: lead.shopify_services ? JSON.parse(lead.shopify_services || "[]") : [],
      status: lead.status
    }));

    return res.json({
      success: true,
      count: transformed.length,
      leads: transformed.slice(0, limit ? parseInt(limit, 10) : transformed.length)
    });

  } catch (err) {
    logger.error("Merchant eligible leads error:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Failed to fetch eligible leads"
    });
  }
});

/**
 * GET /api/merchant/settings/delay
 * Get current delay configuration
 */
router.get("/settings/delay", async (req, res) => {
  try {
    // Return current configured delay range
    return res.json({
      success: true,
      delay: {
        minSeconds: Math.round(config.emailDelayMs / 1000),
        maxSeconds: Math.round(config.batchDelayMs / 1000),
        description: "Current email/WhatsApp delay settings from config"
      }
    });
  } catch (err) {
    logger.error("Merchant delay settings error:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Failed to fetch delay settings"
    });
  }
});

module.exports = router;
