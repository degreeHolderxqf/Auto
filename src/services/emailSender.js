const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
const config = require("../config");
const db = require("../db/database");
const logger = require("./logger");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class EmailSender {
  constructor() {
    this.transporter = null;
    this.isVerified = false;
  }

  getTransporter() {
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        auth: {
          user: config.smtp.user,
          pass: config.smtp.pass
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

  verifyResumeAttachment() {
    if (!fs.existsSync(config.resumePath)) {
      throw new Error(`Resume PDF file not found at: ${config.resumePath}`);
    }
    return true;
  }

  /**
   * Sends an email with retry logic and safety handling
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
   * Sends a batch of approved leads
   */
  async sendBatch(leadsToSend, options = {}) {
    const isDryRun = options.dryRun !== undefined ? options.dryRun : config.dryRun;
    const limit = options.limit || config.sendLimit || 10;
    const items = leadsToSend.slice(0, limit);

    logger.section(`Starting Outreach Batch (${items.length} emails, DryRun: ${isDryRun})`);

    this.verifyResumeAttachment();
    if (!isDryRun) {
      await this.verifyTransporter();
    }

    let sentCount = 0;
    let failedCount = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const { company, contact, mailOptions } = item;

      // Check if already contacted in database
      if (db.hasBeenContacted(contact.email, company.id)) {
        logger.warn(`Skipping ${company.name} (${contact.email}) - already recorded as SENT.`);
        continue;
      }

      logger.progress(i + 1, items.length, company.name, `Sending to: ${contact.email} (${contact.confidence})`);

      const result = await this.sendMailWithRetry(mailOptions, 0, isDryRun);

      if (result.success) {
        sentCount++;
        db.updateCompanyStatus(company.id, "SENT", `Email sent to ${contact.email}`);
        db.addEmailLog({
          company_id: company.id,
          contact_id: contact.id,
          email: contact.email,
          subject: mailOptions.subject,
          status: isDryRun ? "DRY_RUN_SENT" : "SENT",
          message_id: result.messageId,
          attempts: result.attempts
        });
        logger.success(`Email ${isDryRun ? "simulated" : "sent"} to ${contact.email}`);
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

      // Delay between emails
      if (i < items.length - 1) {
        const delay = config.emailDelayMs;
        if (!isDryRun) {
          logger.info(`Waiting ${delay}ms before next email...`);
          await sleep(delay);
        }
      }

      // Batch pause if batch size reached
      if ((i + 1) % config.batchSize === 0 && i < items.length - 1) {
        if (!isDryRun) {
          logger.info(`Batch size of ${config.batchSize} reached. Pausing for ${config.batchDelayMs}ms...`);
          await sleep(config.batchDelayMs);
        }
      }
    }

    logger.section("Batch Outreach Finished");
    logger.info(`Sent / Simulated: ${sentCount} | Failed: ${failedCount}`);

    return { sentCount, failedCount, total: items.length };
  }
}

module.exports = new EmailSender();
