const config = require("../config");
const db = require("../db/database");
const logger = require("./logger");
const settingsService = require("./settingsService");
const freelanceEmailGenerator = require("./freelanceEmailGenerator");
const outreachEmailGenerator = require("./outreachEmailGenerator");
const emailTemplates = require("./emailTemplates");
const whatsappGenerator = require("./whatsappGenerator");
const resumeStorage = require("./resumeStorage");
const path = require("node:path");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Freelance Sender Service
 *
 * Handles sending emails and WhatsApp messages for freelance outreach
 * batches. Uses a batch-item processing pattern consistent with emailSender.js
 * but targeting freelance_companies / freelance_contacts / freelance_email_logs.
 *
 * Completely separate from merchant/merchant-lead and job-application sending.
 */

class FreelanceSender {
  constructor() {
    this.transporter = null;
    this.isVerified = false;
    this.lastTransportKey = null;
    this._runningBatches = new Set();
  }

  // ── SMTP Transport ──────────────────────────────────────────────────────

  getTransporter() {
    const settings = settingsService.getSettings(false);
    const currentKey = `${settings.smtpHost}:${settings.smtpPort}:${settings.smtpSecure}:${settings.smtpUser}:${settings.smtpPass}`;

    if (!this.transporter || this.lastTransportKey !== currentKey) {
      this.lastTransportKey = currentKey;
      this.isVerified = false;
      const nodemailer = require("nodemailer");
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
          logger.error("SMTP verification failed for freelance outreach", error);
          reject(error);
        } else {
          logger.success("SMTP connection verified and ready for freelance outreach.");
          this.isVerified = true;
          resolve(true);
        }
      });
    });
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

  async verifyResumeAttachment() {
    const settings = settingsService.getSettings(false);
    const reference = settings.resumePath || config.resumeFallbackPath || config.resumePath;
    const content = await resumeStorage.readResume(reference);
    if (!content) {
      throw new Error("Resume not found. Please select/upload a valid resume before starting freelance outreach.");
    }
    return { reference, content, filename: settings.resumeFilename || require("path").basename(reference) };
  }

  /**
   * Send a single email with retry logic and safety handling.
   */
  async sendMailWithRetry(mailOptions, retryCount = 0, isDryRun = false) {
    if (isDryRun) {
      logger.info(`[DRY RUN] Freelance email to: ${mailOptions.to} | Subject: "${mailOptions.subject}"`);
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
        logger.warn(`Retryable freelance send error to ${mailOptions.to}. Retrying in ${delay}ms...`);
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

  // ── Batch Processing ────────────────────────────────────────────────────

  /**
   * Process a chunk of freelance outreach batch items (email channel).
   * Returns { processed, success, failed, moreWork }.
   */
  async processBatchChunk(batchId, options = {}) {
    const verify = options.verify !== false; // default true
    const dryRun = options.dryRun !== undefined ? options.dryRun : config.dryRun;

    if (this._runningBatches.has(batchId)) {
      return { processed: 0, success: 0, failed: 0, moreWork: false };
    }
    this._runningBatches.add(batchId);

    try {
      const batch = db.getFreelanceOutreachBatch(batchId);
      if (!batch) {
        logger.error(`Freelance batch ${batchId} not found`);
        return { processed: 0, success: 0, failed: 0, moreWork: false };
      }

      const items = db.getNextFreelanceBatchItems(batchId, batch.chunk_size || 10);
      if (!items || items.length === 0) {
        db.completeFreelanceOutreachBatch(batchId);
        return { processed: 0, success: 0, failed: 0, moreWork: false };
      }

      if (verify && !dryRun) {
        await this.verifyTransporter();
      }

      let sentCount = 0;
      let failedCount = 0;
      const settings = settingsService.getSettings(false);
      const templateId = await emailTemplates.getActiveTemplateId();

      for (const item of items) {
        const { company_id, contact_id, email } = item;
        const company = db.getFreelanceCompanyById(company_id);
        const contact = contact_id ? db.getFreelanceContactById(contact_id) : null;

        if (!company) {
          db.markFreelanceBatchItemFailed(batchId, company_id, "Company not found", 1);
          failedCount++;
          continue;
        }

        if (db.hasFreelanceBeenContacted(email, company_id)) {
          db.markFreelanceBatchItemSent(batchId, company_id, "already-contacted", 0);
          continue;
        }

        // Generate email
        const baseMailOptions = freelanceEmailGenerator.generateEmail(company, contact);
        const mailOptions = await outreachEmailGenerator.generateEmail(company, contact, {
          templateId,
          baseMailOptions
        });
        const prepared = await this.prepareMailOptions(mailOptions);

        const result = await this.sendMailWithRetry(prepared, 0, dryRun);

        if (result.success) {
          db.markFreelanceBatchItemSent(batchId, company_id, result.messageId, result.attempts);
          db.addFreelanceEmailLog({
            company_id,
            contact_id: contact_id || null,
            email,
            subject: mailOptions.subject,
            status: dryRun ? "DRY_RUN_SENT" : "SENT",
            message_id: result.messageId,
            attempts: result.attempts
          });
          if (company_id) {
            db.prepare("UPDATE freelance_companies SET whatsapp_status = 'SENT', updated_at = datetime('now') WHERE id = ?").run(company_id);
          }
          sentCount++;
        } else {
          db.markFreelanceBatchItemFailed(batchId, company_id, result.error, result.attempts);
          db.addFreelanceEmailLog({
            company_id,
            contact_id: contact_id || null,
            email,
            subject: mailOptions.subject,
            status: "FAILED",
            message_id: null,
            error: result.error,
            attempts: result.attempts
          });
          failedCount++;
        }

        if (!dryRun) {
          const delayMs = settings.emailDelayMs || config.emailDelayMs || 5000;
          await sleep(delayMs);
        }
      }

      db.refreshFreelanceBatchCounters(batchId);
      const updatedBatch = db.getFreelanceOutreachBatch(batchId);
      const moreWork = updatedBatch && updatedBatch.pending > 0;

      return {
        processed: items.length,
        success: sentCount,
        failed: failedCount,
        moreWork: moreWork && !process.env.VERCEL
      };
    } catch (err) {
      logger.error(`Freelance batch chunk failed for ${batchId}:`, err);
      db.failFreelanceOutreachBatch(batchId, err.message);
      return { processed: 0, success: 0, failed: 0, moreWork: false };
    } finally {
      this._runningBatches.delete(batchId);
    }
  }

  /**
   * Process a chunk of freelance WhatsApp batch items.
   */
  async processWhatsAppBatchChunk(batchId, options = {}) {
    const dryRun = options.dryRun !== undefined ? options.dryRun : config.evolution.dryRun;

    if (this._runningBatches.has(batchId)) {
      return { processed: 0, success: 0, failed: 0, moreWork: false };
    }
    this._runningBatches.add(batchId);

    try {
      const batch = db.getFreelanceOutreachBatch(batchId);
      if (!batch) {
        logger.error(`Freelance WhatsApp batch ${batchId} not found`);
        return { processed: 0, success: 0, failed: 0, moreWork: false };
      }

      const items = db.getNextFreelanceBatchItems(batchId, batch.chunk_size || 10);
      if (!items || items.length === 0) {
        db.completeFreelanceOutreachBatch(batchId);
        return { processed: 0, success: 0, failed: 0, moreWork: false };
      }

      const evolutionClient = require("./evolutionGoClient");
      const settings = settingsService.getSettings(false);
      const templateId = options.templateId || await emailTemplates.getActiveTemplateId();
      const evolutionConfig = {
        apiUrl: settings.evolutionApiUrl || config.evolution.apiUrl,
        apiKey: settings.evolutionApiKey || config.evolution.apiKey,
        instanceName: settings.evolutionInstanceName || config.evolution.instanceName,
        dryRun
      };

      let sentCount = 0;
      let failedCount = 0;

      for (const item of items) {
        const { company_id, contact_id, recipient } = item;
        const company = db.getFreelanceCompanyById(company_id);
        const contact = contact_id ? db.getFreelanceContactById(contact_id) : null;

        if (!company) {
          db.markFreelanceBatchItemFailed(batchId, company_id, "Company not found", 1);
          failedCount++;
          continue;
        }

        const phone = contact?.normalized_phone || contact?.phone || company.normalized_phone || company.phone;
        if (!phone) {
          db.markFreelanceBatchItemFailed(batchId, company_id, "No phone number available", 1);
          failedCount++;
          continue;
        }

        if (db.isFreelanceWhatsAppOptedOut(phone)) {
          db.markFreelanceBatchItemSent(batchId, company_id, "opted-out", 0);
          continue;
        }

        if (db.isFreelanceWhatsAppContacted(company_id, phone)) {
          db.markFreelanceBatchItemSent(batchId, company_id, "already-contacted", 0);
          continue;
        }

        const message = whatsappGenerator.generateMessage(company, contact, templateId);

        let result;
        let resumeBuffer = null;
        let resumeFilename = null;
        if (message.includeResume) {
          const resumeReference = settings.resumePath || config.resumeFallbackPath || config.resumePath;
          try {
            resumeBuffer = await resumeStorage.readResume(resumeReference);
          } catch (error) {
            result = { success: false, error: `Resume could not be loaded. ${error.message || "Please upload the resume again before sending WhatsApp outreach."}` };
          }
          if (!resumeBuffer && !result) {
            result = { success: false, error: "Resume not found. Please select/upload a valid resume before sending WhatsApp outreach." };
          }
          resumeFilename = settings.resumeFilename || (resumeReference ? path.basename(resumeReference) : "resume.pdf");
        }

        if (dryRun) {
          if (!result) {
            logger.info(`[DRY RUN] Freelance WhatsApp to: ${phone}`);
            if (message.includeResume) logger.info(`[DRY RUN] Would attach resume ${resumeFilename} to ${phone}`);
            result = { success: true, dryRun: true, messageId: "dry-run-" + Date.now() };
          }
        } else if (!result) {
          try {
            const evolutionResult = await evolutionClient.sendTextMessage(
              phone,
              message.text,
              evolutionConfig.instanceName,
              evolutionConfig
            );
            if (!evolutionResult.ok) throw new Error(evolutionResult.error || "Failed to send WhatsApp message");

            let resumeMessageId = null;
            if (message.includeResume) {
              const resumeResult = await evolutionClient.sendDocumentMessage(
                phone,
                resumeBuffer,
                resumeFilename,
                "",
                evolutionConfig.instanceName,
                evolutionConfig
              );
              if (!resumeResult.ok) throw new Error(`WhatsApp message sent, but resume attachment failed: ${resumeResult.error}`);
              resumeMessageId = resumeResult.messageId || null;
            }
            result = {
              success: true,
              dryRun: Boolean(evolutionResult.dryRun),
              messageId: evolutionResult.messageId || Date.now().toString(),
              resumeMessageId
            };
          } catch (err) {
            result = { success: false, error: err.message };
          }
        }

        if (result.success) {
          db.markFreelanceBatchItemSent(batchId, company_id, result.messageId, 1);
          db.logFreelanceWhatsAppMessage({
            company_id,
            contact_id: contact_id || null,
            phone,
            message: message.text,
            status: dryRun ? "DRY_RUN_SENT" : "SENT",
            message_id: result.messageId
          });
          sentCount++;
        } else {
          db.markFreelanceBatchItemFailed(batchId, company_id, result.error, 1);
          db.logFreelanceWhatsAppMessage({
            company_id,
            contact_id: contact_id || null,
            phone,
            message: message.text,
            status: "FAILED",
            error: result.error
          });
          failedCount++;
        }

        if (!dryRun) {
          const delayMs = settings.whatsAppDelayMs || config.evolution.delayMs || 15000;
          await sleep(delayMs);
        }
      }

      db.refreshFreelanceBatchCounters(batchId);
      const updatedBatch = db.getFreelanceOutreachBatch(batchId);
      const moreWork = updatedBatch && updatedBatch.pending > 0;

      return {
        processed: items.length,
        success: sentCount,
        failed: failedCount,
        moreWork: moreWork && !process.env.VERCEL
      };
    } catch (err) {
      logger.error(`Freelance WhatsApp batch chunk failed for ${batchId}:`, err);
      db.failFreelanceOutreachBatch(batchId, err.message);
      return { processed: 0, success: 0, failed: 0, moreWork: false };
    } finally {
      this._runningBatches.delete(batchId);
    }
  }
}

module.exports = new FreelanceSender();
