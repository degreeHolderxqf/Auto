const config = require("../config");
const db = require("../db/database");
const logger = require("./logger");
const merchantIngestion = require("./merchantIngestion");
const merchantTemplate = require("./merchantTemplate");
const outreachEmailGenerator = require("./outreachEmailGenerator");
const emailTemplates = require("./emailTemplates");
const emailSender = require("./emailSender");
const whatsappWorkflow = require("../workflows/whatsappWorkflow");
const whatsappGenerator = require("./whatsappGenerator");

const MIN_DELAY_MS = 2 * 60 * 1000;
const MAX_DELAY_MS = 5 * 60 * 1000;
const runningBatches = new Set();
let queueTail = Promise.resolve();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getRandomDelayMs = (random = Math.random) =>
  MIN_DELAY_MS + Math.floor(random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1));

class MerchantQueue {
  constructor({ channel, dryRun, templateId = null } = {}) {
    if (channel !== "email" && channel !== "whatsapp") {
      throw new Error("channel must be 'email' or 'whatsapp'");
    }
    this.channel = channel;
    this.dryRun = dryRun !== undefined
      ? Boolean(dryRun)
      : channel === "email" ? config.dryRun : config.evolution.dryRun;
    this.templateId = templateId;
    this.batchId = null;
  }

  createBatch(leadIds, batchId = null) {
    const ids = [...new Set(leadIds.map(Number))];
    if (ids.length === 0 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      throw new Error("leadIds must contain positive integer merchant IDs");
    }
    const leads = new Map(ids.map((id) => [id, merchantIngestion.getMerchantLeadById(id)]));
    const missingId = ids.find((id) => !leads.get(id));
    if (missingId) {
      throw new Error(`Merchant lead ${missingId} was not found`);
    }
    this.batchId = batchId || `merchant_${this.channel}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const database = db.getRawDb();
    const insertBatch = database.prepare(`
      INSERT INTO merchant_outreach_batches (id, channel, status, dry_run, total, pending, skipped)
      VALUES (?, ?, 'QUEUED', ?, ?, 0, 0)
    `);
    const insertItem = database.prepare(`
      INSERT INTO merchant_outreach_items (batch_id, company_id, contact_id, recipient, position, status, error)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const pendingItems = [];
    const skippedCount = { value: 0 };

    database.exec("BEGIN TRANSACTION;");
    try {
      insertBatch.run(this.batchId, this.channel, this.dryRun ? 1 : 0, ids.length);
      ids.forEach((companyId, position) => {
        const lead = leads.get(companyId);
        const contacts = db.getContactsByCompanyId(companyId);
        const contact = contacts.find((item) => item.email === lead?.email) || contacts[0] || null;
        const recipient = this.channel === "email"
          ? lead?.email || null
          : lead?.normalized_phone || lead?.phone || null;
        const error = !lead
          ? `Merchant lead ${companyId} was not found`
          : !recipient
            ? this.channel === "email" ? "No contact email is available" : "No phone number is available"
            : null;
        const status = error ? "SKIPPED" : "PENDING";
        if (error) skippedCount.value++;
        else pendingItems.push(companyId);
        insertItem.run(
          this.batchId,
          companyId,
          contact?.id || null,
          recipient,
          position,
          status,
          error
        );
      });
      database.prepare(`
        UPDATE merchant_outreach_batches
        SET pending = ?, skipped = ?, status = ?, updated_at = datetime('now'),
            completed_at = CASE WHEN ? = 0 THEN datetime('now') ELSE NULL END
        WHERE id = ?
      `).run(
        pendingItems.length,
        skippedCount.value,
        pendingItems.length ? "QUEUED" : "COMPLETED",
        pendingItems.length,
        this.batchId
      );
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
    return this.batchId;
  }

  startBatch(leadIds, batchId = null) {
    const id = this.createBatch(leadIds, batchId);
    const batch = this.getBatch(id);
    if (batch && batch.pending > 0) {
      setImmediate(() => {
        this.processBatch(id).catch((error) => {
          logger.error(`Merchant batch ${id} failed`, error);
        });
      });
    }
    return batch;
  }

  resumeBatch(batchId) {
    if (runningBatches.has(batchId)) {
      return this.getBatch(batchId);
    }
    const database = db.getRawDb();
    const batch = this.getBatch(batchId);
    if (!batch) {
      throw new Error(`Batch "${batchId}" not found`);
    }
    database.prepare(`
      UPDATE merchant_outreach_items SET status = 'PENDING', error = NULL
      WHERE batch_id = ? AND status = 'PROCESSING'
    `).run(batchId);
    const refreshed = this.refreshBatch(batchId);
    if (refreshed.pending === 0) {
      return this.getBatch(batchId);
    }
    database.prepare(`
      UPDATE merchant_outreach_batches
      SET status = 'QUEUED', error = NULL, updated_at = datetime('now'), completed_at = NULL
      WHERE id = ?
    `).run(batchId);
    const updated = this.getBatch(batchId);
    if (updated.pending > 0) {
      setImmediate(() => {
        this.processBatch(batchId).catch((error) => {
          logger.error(`Merchant batch ${batchId} resume failed`, error);
        });
      });
    }
    return updated;
  }

  getBatch(batchId) {
    const batch = db.getRawDb().prepare(
      "SELECT * FROM merchant_outreach_batches WHERE id = ?"
    ).get(batchId);
    if (!batch) return null;
    return {
      ...batch,
      dry_run: Boolean(batch.dry_run)
    };
  }

  async processBatch(batchId) {
    if (runningBatches.has(batchId)) {
      return { alreadyRunning: true, batch: this.getBatch(batchId) };
    }
    runningBatches.add(batchId);
    const previousBatch = queueTail;
    let releaseBatch;
    queueTail = new Promise((resolve) => {
      releaseBatch = resolve;
    });
    await previousBatch.catch(() => {});

    let database;
    try {
      database = db.getRawDb();
      database.prepare(`
        UPDATE merchant_outreach_batches
        SET status = 'PROCESSING', updated_at = datetime('now')
        WHERE id = ? AND status IN ('QUEUED', 'PROCESSING')
      `).run(batchId);
      let processed = 0;

      while (true) {
        const item = database.prepare(`
          SELECT * FROM merchant_outreach_items
          WHERE batch_id = ? AND status = 'PENDING'
          ORDER BY position ASC LIMIT 1
        `).get(batchId);
        if (!item) break;

        const claimed = database.prepare(`
          UPDATE merchant_outreach_items SET status = 'PROCESSING'
          WHERE id = ? AND status = 'PENDING'
        `).run(item.id);
        if (!claimed.changes) continue;

        let result;
        try {
          result = await this.sendItem(item, batchId);
          database.prepare(`
            UPDATE merchant_outreach_items
            SET status = ?, message_id = ?, error = ?, processed_at = datetime('now')
            WHERE id = ?
          `).run(
            result.success ? "SENT" : result.skipped ? "SKIPPED" : "FAILED",
            result.messageId || null,
            result.success ? null : result.error || "Unknown sending error",
            item.id
          );
        } catch (error) {
          result = { success: false, error: error.message || "Unexpected sending error" };
          database.prepare(`
            UPDATE merchant_outreach_items
            SET status = 'FAILED', error = ?, processed_at = datetime('now')
            WHERE id = ?
          `).run(result.error, item.id);
          logger.error(`Merchant ${this.channel} send failed for lead ${item.company_id}`, error);
        }

        this.refreshBatch(batchId);
        processed++;
        logger.info(`Merchant batch ${batchId}: processed ${processed} item(s), last status=${result.success ? "SENT" : result.skipped ? "SKIPPED" : "FAILED"}`);

      }

      this.refreshBatch(batchId);
      const latest = this.getBatch(batchId);
      if (latest.pending === 0) {
        database.prepare(`
          UPDATE merchant_outreach_batches
          SET status = 'COMPLETED', completed_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ?
        `).run(batchId);
      }
      return { batch: this.getBatch(batchId) };
    } catch (error) {
      if (database) {
        database.prepare(`
          UPDATE merchant_outreach_items
          SET status = 'PENDING'
          WHERE batch_id = ? AND status = 'PROCESSING'
        `).run(batchId);
        this.refreshBatch(batchId);
        database.prepare(`
          UPDATE merchant_outreach_batches
          SET status = 'FAILED', error = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(error.message || "Unexpected queue processing error", batchId);
      }
      throw error;
    } finally {
      releaseBatch();
      runningBatches.delete(batchId);
    }
  }

  async sendWithGlobalDelay(send) {
    const database = db.getRawDb();
    const rateLimit = database.prepare(
      "SELECT next_send_at FROM merchant_outreach_rate_limit WHERE id = 1"
    ).get();
    const remainingDelay = this.dryRun
      ? 0
      : Math.max(0, Number(rateLimit?.next_send_at || 0) - Date.now());
    if (remainingDelay > 0) {
      logger.info(`Waiting ${Math.ceil(remainingDelay / 1000)} seconds before the next merchant message`);
      await sleep(remainingDelay);
    }
    try {
      return await send();
    } finally {
      if (!this.dryRun) {
        const delayMs = getRandomDelayMs();
        database.prepare(`
          UPDATE merchant_outreach_rate_limit SET next_send_at = ? WHERE id = 1
        `).run(Date.now() + delayMs);
        logger.info(`Merchant send cooldown set to ${Math.round(delayMs / 1000)} seconds`);
      }
    }
  }

  async sendItem(item) {
    const lead = merchantIngestion.getMerchantLeadById(item.company_id);
    if (!lead) {
      return { success: false, skipped: true, error: `Merchant lead ${item.company_id} was not found` };
    }
    const contacts = db.getContactsByCompanyId(item.company_id);
    const contact = contacts.find((entry) => entry.email === lead.email) || contacts[0] || null;
    const leadForTemplate = {
      ...lead,
      contact_name: contact?.name || null,
      contact_email: lead.email || null,
      contact_phone: lead.normalized_phone || lead.phone || null
    };

    if (this.channel === "email") {
      if (!leadForTemplate.contact_email) {
        return { success: false, skipped: true, error: "No contact email is available" };
      }
      if (db.hasBeenContacted(leadForTemplate.contact_email, item.company_id)) {
        return { success: false, skipped: true, error: "This email or merchant has already been contacted" };
      }
      const templateId = this.templateId || await emailTemplates.getActiveTemplateId();
      const baseMailOptions = merchantTemplate.generateEmail(leadForTemplate);
      const mailOptions = await outreachEmailGenerator.generateEmail(leadForTemplate, contact, {
        templateId,
        baseMailOptions
      });
      const result = await this.sendWithGlobalDelay(() =>
        emailSender.sendMailWithRetry(mailOptions, 0, this.dryRun)
      );
      db.addEmailLog({
        company_id: item.company_id,
        contact_id: contact?.id || null,
        email: leadForTemplate.contact_email,
        subject: mailOptions.subject,
        status: result.success ? (this.dryRun ? "DRY_RUN_SENT" : "SENT") : "FAILED",
        message_id: result.messageId || null,
        error: result.error || null,
        attempts: result.attempts || 1
      });
      if (result.success && !this.dryRun) {
        db.updateCompanyStatus(item.company_id, "CONTACTED", `Merchant email sent to ${leadForTemplate.contact_email}`);
      }
      return result;
    }

    const phone = leadForTemplate.contact_phone;
    if (!phone) {
      return { success: false, skipped: true, error: "No phone number is available" };
    }
    const templateId = this.templateId || await emailTemplates.getActiveTemplateId();
    const message = whatsappGenerator.generateMessage(leadForTemplate, contact, templateId);
    if (this.dryRun) {
      logger.info(`[Merchant WhatsApp DRY RUN] Would send to ${phone}:\n${message.text}`);
      return { success: true, dryRun: true, messageId: `dry-run-${Date.now()}` };
    }
    const result = await this.sendWithGlobalDelay(() =>
      whatsappWorkflow.sendSingleMessage(item.company_id, phone, message.text, { templateId })
    );
    const skipped = Boolean(result.error) &&
      (result.error.includes("already been contacted") || result.error.includes("opted out"));
    return {
      success: Boolean(result.success),
      skipped,
      messageId: result.messageId || result.textMessageId || null,
      error: result.error || null
    };
  }

  refreshBatch(batchId) {
    const database = db.getRawDb();
    database.prepare(`
      UPDATE merchant_outreach_batches
      SET sent = (SELECT COUNT(*) FROM merchant_outreach_items WHERE batch_id = ? AND status = 'SENT'),
          failed = (SELECT COUNT(*) FROM merchant_outreach_items WHERE batch_id = ? AND status = 'FAILED'),
          skipped = (SELECT COUNT(*) FROM merchant_outreach_items WHERE batch_id = ? AND status = 'SKIPPED'),
          pending = (SELECT COUNT(*) FROM merchant_outreach_items WHERE batch_id = ? AND status IN ('PENDING', 'PROCESSING')),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(batchId, batchId, batchId, batchId, batchId);
    return this.getBatch(batchId);
  }
}

module.exports = MerchantQueue;
module.exports.getRandomDelayMs = getRandomDelayMs;
module.exports.MIN_DELAY_MS = MIN_DELAY_MS;
module.exports.MAX_DELAY_MS = MAX_DELAY_MS;
