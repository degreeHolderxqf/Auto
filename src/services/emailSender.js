const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
const config = require("../config");
const db = require("../db/database");
const logger = require("./logger");
const outreachEmailGenerator = require("./outreachEmailGenerator");
const resumeStorage = require("./resumeStorage");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Maximum wall-clock time a single chunk is allowed to run before it returns.
// On Vercel the function will likely be killed well before this, but having
// the bound lets us also test locally. Tuned so 10 emails with 5s delay
// (~50s of sleep) fits comfortably.
const DEFAULT_CHUNK_WALL_MS = parseInt(process.env.EMAIL_BATCH_CHUNK_WALL_MS || "50000", 10);

function mailOptionsRequireResume(mailOptions) {
  return !mailOptions || !Array.isArray(mailOptions.attachments) || mailOptions.attachments.length > 0;
}

function batchRequiresResumeAttachment(batchId) {
  const pendingItems = db.getRawDb().prepare(`
    SELECT mail_options_json FROM email_batch_items
    WHERE batch_id = ? AND status IN ('PENDING', 'PROCESSING')
  `).all(batchId);

  return pendingItems.some((item) => {
    try {
      return mailOptionsRequireResume(JSON.parse(item.mail_options_json));
    } catch {
      return true;
    }
  });
}

class EmailSender {
  constructor() {
    this.transporter = null;
    this.isVerified = false;
    this.lastTransportKey = null;
    // Per-batch execution lock — prevents multiple concurrent chunks for the same batch.
    this._runningBatches = new Set();
  }

  getTransporter() {
    const settings = require("./settingsService").getSettings(false);
    const currentKey = `${settings.smtpHost}:${settings.smtpPort}:${settings.smtpSecure}:${settings.smtpUser}:${settings.smtpPass}`;

    if (!this.transporter || this.lastTransportKey !== currentKey) {
      this.lastTransportKey = currentKey;
      this.isVerified = false;
      this.transporter = nodemailer.createTransport({
        host: settings.smtpHost,
        port: settings.smtpPort,
        secure: settings.smtpSecure,
        auth: {
          user: settings.smtpUser,
          pass: settings.smtpPass
        },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000,
        tls: {
          rejectUnauthorized: false
        }
      });
    }
    return this.transporter;
  }

  async verifyTransporter() {
    if (this.isVerified) return true;
    const transporter = this.getTransporter();

    return new Promise((resolve, reject) => {
      transporter.verify((error, success) => {
        if (error) {
          logger.error("SMTP verification failed. Check credentials in .env", error);
          reject(error);
        } else {
          logger.success("SMTP connection verified and ready.");
          this.isVerified = true;
          resolve(true);
        }
      });
    });
  }

  async verifyResumeAttachment() {
    const settings = require("./settingsService").getSettings(false);
    const reference = settings.resumePath || config.resumeFallbackPath || config.resumePath;
    const content = await resumeStorage.readResume(reference);
    if (!content) {
      throw new Error("Resume not found. Please select/upload a valid resume before starting outreach.");
    }
    return { reference, content, filename: settings.resumeFilename || path.basename(reference) };
  }

  async prepareMailOptions(mailOptions) {
    if (Array.isArray(mailOptions.attachments) && mailOptions.attachments.length === 0) {
      return mailOptions;
    }
    const resume = await this.verifyResumeAttachment();
    return {
      ...mailOptions,
      attachments: [{
        filename: resume.filename,
        content: resume.content,
        contentType: "application/pdf"
      }]
    };
  }

  /**
   * Sends an email with retry logic and safety handling.
   * The same logic as before — unchanged.
   */
  async sendMailWithRetry(mailOptions, retryCount = 0, isDryRun = false) {
    if (isDryRun) {
      logger.info(`[DRY RUN] Would send to: ${mailOptions.to} | Subject: "${mailOptions.subject}"`);
      return {
        success: true,
        dryRun: true,
        messageId: "dry-run-" + Date.now(),
        attempts: 1
      };
    }

    try {
      const transporter = this.getTransporter();
      const info = await transporter.sendMail(mailOptions);
      return {
        success: true,
        dryRun: false,
        messageId: info.messageId,
        attempts: retryCount + 1
      };
    } catch (error) {
      const errMsg = error.message || "";
      const isUserUnknown =
        errMsg.includes("550") ||
        errMsg.includes("does not exist") ||
        errMsg.includes("NoSuchUser") ||
        errMsg.includes("recipient rejected");

      const isAuthFail = error.code === "EAUTH" || error.responseCode === 535;

      if (isAuthFail) {
        return {
          success: false,
          error: error.message,
          failReason: "AUTH_FAILED",
          permanent: true,
          attempts: retryCount + 1
        };
      }

      if (isUserUnknown) {
        return {
          success: false,
          error: error.message,
          failReason: "USER_DOES_NOT_EXIST",
          permanent: true,
          attempts: retryCount + 1
        };
      }

      const isRetryable =
        retryCount < config.maxRetries &&
        ["timed out", "ETIMEDOUT", "ECONNREFUSED", "socket hang up", "rate limit"].some((t) =>
          errMsg.toLowerCase().includes(t)
        );

      if (isRetryable) {
        const delay = config.retryDelayMs * (retryCount + 1);
        logger.warn(`Retryable error sending to ${mailOptions.to}. Retrying in ${delay}ms...`);
        await sleep(delay);
        return this.sendMailWithRetry(mailOptions, retryCount + 1, isDryRun);
      }

      return {
        success: false,
        error: error.message,
        failReason: "OTHER_ERROR",
        permanent: !isRetryable,
        attempts: retryCount + 1
      };
    }
  }

  /**
   * Compatibility shim: send a list of pre-generated batch items in one pass.
   * Used by the CLI workflow. The new /api/email/send path uses processBatchChunk
   * instead, but we keep this method so the CLI still works.
   */
  async sendBatch(leadsToSend, options = {}) {
    const isDryRun = options.dryRun !== undefined ? options.dryRun : config.dryRun;
    const limit = options.limit || config.sendLimit || leadsToSend.length;
    const items = leadsToSend.slice(0, limit);

    logger.section(`Starting Outreach Batch (${items.length} emails, DryRun: ${isDryRun})`);

    if (items.some((item) => mailOptionsRequireResume(item.mailOptions))) {
      await this.verifyResumeAttachment();
    }
    if (!isDryRun) {
      await this.verifyTransporter();
    }

    let sentCount = 0;
    let failedCount = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const { company, contact, mailOptions } = item;

      if (db.hasBeenContacted(contact.email, company.id)) {
        logger.warn(`Skipping ${company.name} (${contact.email}) - already recorded as SENT.`);
        continue;
      }

      logger.progress(i + 1, items.length, company.name, `Sending to: ${contact.email} (${contact.confidence})`);

      const result = await this.sendMailWithRetry(await this.prepareMailOptions(mailOptions), 0, isDryRun);

      if (result.success) {
        sentCount++;
        db.updateCompanyStatus(company.id, "CONTACTED", `Email sent to ${contact.email}`);
        db.addEmailLog({
          company_id: company.id,
          contact_id: contact.id,
          email: contact.email,
          subject: mailOptions.subject,
          status: isDryRun ? "DRY_RUN_SENT" : "SENT",
          message_id: result.messageId,
          attempts: result.attempts
        });
        try {
          const exclusionService = require("./exclusionService");
          exclusionService.addExclusion(company.name, company.domain, `Contacted Lead (${contact.email})`);
        } catch (e) {
          // ignore
        }
        logger.success(`Email ${isDryRun ? "simulated" : "sent"} to ${contact.email} -> Company marked as CONTACTED`);
      } else {
        failedCount++;
        db.updateCompanyStatus(company.id, "FAILED", result.error);
        db.addEmailLog({
          company_id: company.id,
          contact_id: contact.id,
          email: contact.email,
          subject: mailOptions.subject,
          status: "FAILED",
          error: result.error,
          attempts: result.attempts
        });
        logger.error(`Failed to send to ${contact.email}`, new Error(result.error));
      }

      if (i < items.length - 1) {
        const delay = config.emailDelayMs;
        if (!isDryRun) {
          logger.info(`Waiting ${delay}ms before next email...`);
          await sleep(delay);
        }
      }
    }

    logger.section("Batch Outreach Finished");
    logger.info(`Sent / Simulated: ${sentCount} | Failed: ${failedCount}`);

    return { sent: sentCount, failed: failedCount, total: items.length };
  }

  // ─── Resumable Batch System ──────────────────────────────────────────────────

  /**
   * Create a new batch. Returns the batch id.
   * Items are pre-loaded into email_batch_items with status='PENDING'.
   * The batch row itself starts in 'PROCESSING' status.
   *
   * The actual sending happens via processBatchChunk(), which the API
   * invokes synchronously (so the first chunk starts right away) and
   * then schedules a self-resume if more items remain.
   */
  createBatch(items, options = {}) {
    const isDryRun = options.dryRun !== undefined ? options.dryRun : config.dryRun;
    const chunkSize = options.chunkSize || parseInt(process.env.EMAIL_BATCH_CHUNK_SIZE || "10", 10);

    const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const mode = isDryRun ? "DRY_RUN" : "LIVE";

    const database = db.getRawDb();
    const insertBatch = database.prepare(`
      INSERT INTO email_batches (id, mode, status, total, pending, lead_ids_json, chunk_size)
      VALUES (?, ?, 'PROCESSING', ?, ?, ?, ?)
    `);
    const insertItem = database.prepare(`
      INSERT OR IGNORE INTO email_batch_items
        (batch_id, company_id, contact_id, email, subject, mail_options_json, position, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING')
    `);

    database.exec("BEGIN TRANSACTION;");
    try {
      insertBatch.run(batchId, mode, items.length, items.length, JSON.stringify(items.map(i => i.company.id)), chunkSize);
      items.forEach((item, idx) => {
        const company = item.company;
        const contact = item.contact;
        const mailOptions = item.mailOptions;
        insertItem.run(
          batchId,
          company.id,
          contact && contact.id ? contact.id : null,
          contact && contact.email ? contact.email : (mailOptions && mailOptions.to) || "",
          (mailOptions && mailOptions.subject) || null,
          JSON.stringify(mailOptions || {}),
          idx
        );
      });
      database.exec("COMMIT;");
    } catch (e) {
      database.exec("ROLLBACK;");
      throw e;
    }

    logger.section(`Created ${mode} batch ${batchId} (${items.length} emails, chunk=${chunkSize})`);
    return batchId;
  }

  /**
   * Process up to `chunkSize` items from a batch, then return.
   * Bounded by chunkSize AND a wall-clock budget, so a single invocation
   * can only do a fixed amount of work. If items remain after the chunk,
   * the caller can resume later.
   *
   * The function is safe to call multiple times concurrently for the same
   * batch — the email_batch_items UNIQUE(batch_id, company_id) + status
   * check ensures no lead is sent twice.
   */
  async processBatchChunk(batchId, options = {}) {
    // Per-batch concurrency guard. If another invocation is already processing
    // this batch, return immediately — that one will continue the work.
    if (this._runningBatches.has(batchId)) {
      logger.info(`Batch ${batchId} is already being processed. Skipping.`);
      return { alreadyRunning: true };
    }
    this._runningBatches.add(batchId);

    try {
      return await this._processBatchChunkInner(batchId, options);
    } finally {
      this._runningBatches.delete(batchId);
    }
  }

  async _processBatchChunkInner(batchId, options = {}) {
    const chunkSize = options.chunkSize || parseInt(process.env.EMAIL_BATCH_CHUNK_SIZE || "10", 10);
    const wallMs = options.wallMs || DEFAULT_CHUNK_WALL_MS;

    const batch = db.getEmailBatch(batchId);
    if (!batch) {
      throw new Error(`Batch ${batchId} not found.`);
    }
    if (batch.status === "COMPLETED" || batch.status === "FAILED") {
      logger.info(`Batch ${batchId} already ${batch.status.toLowerCase()}.`);
      return { alreadyDone: true, batch };
    }

    const isDryRun = batch.mode === "DRY_RUN";

    if (options.verify !== false) {
      if (batchRequiresResumeAttachment(batchId)) {
        try {
          await this.verifyResumeAttachment();
        } catch (e) {
          db.failEmailBatch(batchId, e.message);
          throw e;
        }
      }
      if (!isDryRun) {
        // Check SMTP credentials are present before attempting to send.
        const settings = require("./settingsService").getSettings(false);
        if (!settings.smtpHost || !settings.smtpUser || !settings.smtpPass) {
          const err = new Error("SMTP credentials are not configured. Please configure your email settings before starting email outreach.");
          db.failEmailBatch(batchId, err.message);
          throw err;
        }
        try {
          await this.verifyTransporter();
        } catch (e) {
          db.failEmailBatch(batchId, e.message);
          throw e;
        }
      }
    }

    // Atomically claim up to chunkSize pending items.
    const items = db.getNextBatchItems(batchId, chunkSize);
    if (items.length === 0) {
      // Nothing left to do — close out the batch.
      const refreshed = db.refreshEmailBatchCounters(batchId);
      if (refreshed.pending === 0 && refreshed.processing === 0) {
        db.completeEmailBatch(batchId);
        return { alreadyDone: true, batch: db.getEmailBatch(batchId) };
      }
      // All remaining items are stuck in PROCESSING (a prior crash). Reset them.
      db.getRawDb().prepare(`
        UPDATE email_batch_items SET status = 'PENDING'
        WHERE batch_id = ? AND status = 'PROCESSING'
      `).run(batchId);
      db.refreshEmailBatchCounters(batchId);
      return { alreadyDone: true, batch: db.getEmailBatch(batchId) };
    }

    const startedAt = Date.now();
    let processed = 0;
    let sent = 0;
    let failed = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      // Wall-clock check: if we've burned our budget, release the rest and stop.
      if (Date.now() - startedAt > wallMs) {
        logger.info(`Batch ${batchId} chunk wall-clock limit reached after ${i} of ${items.length}. Releasing remaining items back to PENDING.`);
        db.getRawDb().prepare(`
          UPDATE email_batch_items SET status = 'PENDING'
          WHERE batch_id = ? AND status = 'PROCESSING'
        `).run(batchId);
        break;
      }

      // Re-hydrate the mailOptions JSON for this item.
      let mailOptions;
      try {
        mailOptions = item.mail_options_json ? JSON.parse(item.mail_options_json) : null;
      } catch {
        mailOptions = null;
      }
      if (!mailOptions || !mailOptions.to) {
        // Re-generate from current settings; user may have edited the candidate
        // profile since the batch was started.
        const company = db.getCompanyById(item.company_id);
        const contact = company ? db.getContactsByCompanyId(company.id)[0] : null;
        if (!company || !contact || !contact.email) {
          db.markBatchItemFailed(batchId, item.company_id, "Missing company or contact data", 1);
          failed++;
          processed++;
          continue;
        }
        mailOptions = await outreachEmailGenerator.generateEmail(company, contact);
      }

      logger.progress(i + 1, items.length, item.company_name || `Company #${item.company_id}`, `Sending to: ${item.email}`);

      const result = await this.sendMailWithRetry(await this.prepareMailOptions(mailOptions), 0, isDryRun);

      if (result.success) {
        sent++;
        db.markBatchItemSent(batchId, item.company_id, result.messageId, result.attempts);
        // Mirror the existing side effects: company status, exclusion list.
        try {
          db.updateCompanyStatus(item.company_id, "CONTACTED", `Email sent to ${item.email}`);
          const company = db.getCompanyById(item.company_id);
          if (company) {
            const exclusionService = require("./exclusionService");
            exclusionService.addExclusion(company.name, company.domain, `Contacted Lead (${item.email})`);
          }
        } catch (e) {
          // best-effort; the email is already recorded
        }
        logger.success(`Email ${isDryRun ? "simulated" : "sent"} to ${item.email}`);
      } else {
        failed++;
        db.markBatchItemFailed(batchId, item.company_id, result.error || "unknown", result.attempts);
        try {
          db.updateCompanyStatus(item.company_id, "FAILED", result.error || "unknown");
        } catch (e) {
          // ignore
        }
        logger.error(`Failed to send to ${item.email}: ${result.error}`);
      }
      processed++;

      // Rate-limit between emails (only between items within the chunk —
      // the wall-clock budget is what governs the overall chunk length).
      if (i < items.length - 1 && config.emailDelayMs > 0) {
        const delay = config.emailDelayMs;
        if (!isDryRun) {
          logger.info(`Waiting ${delay}ms before next email...`);
          await sleep(delay);
        }
      }
    }

    const refreshed = db.refreshEmailBatchCounters(batchId);

    // If everything is done, close out the batch.
    if (refreshed.pending === 0 && refreshed.processing === 0) {
      db.completeEmailBatch(batchId);
      logger.section(`Batch ${batchId} complete: sent=${refreshed.sent} failed=${refreshed.failed}`);
      return {
        batch: db.getEmailBatch(batchId),
        processedInChunk: processed,
        sentInChunk: sent,
        failedInChunk: failed,
        moreWork: false
      };
    }

    logger.info(`Batch ${batchId} chunk done: sent=${sent} failed=${failed} remaining=${refreshed.pending}`);
    return {
      batch: db.getEmailBatch(batchId),
      processedInChunk: processed,
      sentInChunk: sent,
      failedInChunk: failed,
      moreWork: true
    };
  }

  /**
   * Self-resume: if a batch still has work, schedule another chunk.
   * Uses setImmediate so we don't blow the call stack; the Vercel
   * function may be killed at any time, in which case the user can
   * resume manually or on their next poll.
   */
  scheduleNextChunk(batchId, delayMs = 100) {
    setTimeout(() => {
      this.processBatchChunk(batchId, { verify: false })
        .then((result) => {
          if (result && result.moreWork) {
            this.scheduleNextChunk(batchId, 100);
          }
        })
        .catch((err) => {
          logger.error(`Auto-resume failed for batch ${batchId}:`, err);
          db.failEmailBatch(batchId, err.message);
        });
    }, delayMs);
  }
}

module.exports = new EmailSender();
