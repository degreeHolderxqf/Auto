const db = require("../db/database");
const evolutionGoClient = require("../services/evolutionGoClient");
const whatsappGenerator = require("../services/whatsappGenerator");
const settingsService = require("../services/settingsService");
const logger = require("../services/logger");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const whatsappWorkflow = {
  /**
   * Sends a single WhatsApp message with duplicate protection and opt-out checks
   */
  async sendSingleMessage(companyId, customPhone = null, customMessage = null) {
    const company = db.getCompanyById(parseInt(companyId, 10));
    if (!company) {
      return { success: false, error: "Company not found" };
    }

    const contacts = db.getContactsByCompanyId(company.id);
    const contact = contacts[0] || null;

    const targetPhone = customPhone || contact?.normalized_phone || contact?.phone || company.normalized_phone || company.phone;

    if (!targetPhone) {
      return { success: false, error: `No valid phone number found for company: ${company.name}` };
    }

    // 1. Opt-out check
    if (db.isWhatsAppOptedOut(targetPhone)) {
      return { success: false, error: `Phone ${targetPhone} is opted out from WhatsApp messaging.` };
    }

    // 2. Duplicate check (skip if already sent)
    if (db.isWhatsAppContacted(company.id, targetPhone)) {
      return { success: false, error: `Company "${company.name}" or phone ${targetPhone} has already been contacted on WhatsApp.` };
    }

    // 3. Message payload
    const generated = whatsappGenerator.generateMessage(company, contact);
    const messageText = customMessage || generated.text;

    // 4. Send via EvolutionGoClient
    const result = await evolutionGoClient.sendTextMessage(targetPhone, messageText);

    if (result.ok) {
      const status = result.dryRun ? "DRY_RUN_SENT" : "SENT";
      const logId = db.logWhatsAppMessage({
        company_id: company.id,
        contact_id: contact?.id || null,
        phone: targetPhone,
        message: messageText,
        status,
        message_id: result.messageId || null,
        error: null
      });

      return {
        success: true,
        dryRun: result.dryRun,
        messageId: result.messageId,
        logId,
        phone: targetPhone,
        message: result.message || "Message sent successfully"
      };
    } else {
      db.logWhatsAppMessage({
        company_id: company.id,
        contact_id: contact?.id || null,
        phone: targetPhone,
        message: messageText,
        status: "FAILED",
        message_id: null,
        error: result.error
      });

      return {
        success: false,
        error: result.error || "Failed to deliver message via Evolution API"
      };
    }
  },

  /**
   * Sequentially sends WhatsApp messages to a list of company IDs with configured delay
   */
  async sendBatch(companyIds = [], onProgress = null) {
    const settings = settingsService.getSettings(false);
    const delayMs = settings.whatsAppDelayMs || 15000;

    const results = {
      total: companyIds.length,
      sent: 0,
      failed: 0,
      skipped: 0,
      details: []
    };

    logger.info(`Starting WhatsApp batch send for ${companyIds.length} lead(s) with ${delayMs}ms delay...`);

    for (let i = 0; i < companyIds.length; i++) {
      const companyId = companyIds[i];
      try {
        const sendRes = await this.sendSingleMessage(companyId);
        if (sendRes.success) {
          results.sent++;
          results.details.push({ companyId, success: true, dryRun: sendRes.dryRun, phone: sendRes.phone });
        } else {
          if (sendRes.error.includes("already been contacted") || sendRes.error.includes("opted out")) {
            results.skipped++;
          } else {
            results.failed++;
          }
          results.details.push({ companyId, success: false, error: sendRes.error });
        }

        if (onProgress) {
          onProgress({
            current: i + 1,
            total: companyIds.length,
            result: sendRes
          });
        }

        // Delay between messages (if not the last one)
        if (i < companyIds.length - 1) {
          await sleep(delayMs);
        }
      } catch (err) {
        results.failed++;
        results.details.push({ companyId, success: false, error: err.message });
      }
    }

    logger.success(`WhatsApp batch complete: ${results.sent} sent, ${results.failed} failed, ${results.skipped} skipped.`);
    return results;
  }
};

module.exports = whatsappWorkflow;
