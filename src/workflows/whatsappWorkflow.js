const db = require("../db/database");
const evolutionGoClient = require("../services/evolutionGoClient");
const whatsappGenerator = require("../services/whatsappGenerator");
const emailTemplates = require("../services/emailTemplates");
const settingsService = require("../services/settingsService");
const logger = require("../services/logger");
const config = require("../config");
const resumeStorage = require("../services/resumeStorage");
const path = require("node:path");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const whatsappWorkflow = {
  /**
   * Sends a single WhatsApp message with duplicate protection and opt-out checks
   */
  async sendSingleMessage(companyId, customPhone = null, customMessage = null, options = {}) {
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
    const templateId = options.templateId || await emailTemplates.getActiveTemplateId();
    const generated = whatsappGenerator.generateMessage(company, contact, templateId);
    const messageText = customMessage || generated.text;
    const settings = settingsService.getSettings(false);
    const includeResume = typeof options.includeResume === "boolean"
      ? options.includeResume
      : generated.includeResume;
    let resumeBuffer = null;
    let resumeFilename = null;
    if (includeResume) {
      const resumeReference = settings.resumePath || config.resumeFallbackPath || config.resumePath;
      try {
        resumeBuffer = await resumeStorage.readResume(resumeReference);
      } catch (error) {
        logger.error("Unable to load resume for WhatsApp outreach", error);
        return {
          success: false,
          error: `Resume could not be loaded. ${error.message || "Please upload the resume again before sending WhatsApp outreach."}`
        };
      }
      if (!resumeBuffer) {
        return { success: false, error: "Resume not found. Please select/upload a valid resume before sending WhatsApp outreach." };
      }
      resumeFilename = settings.resumeFilename || path.basename(resumeReference);
    }

    // 4. Send the existing text message via EvolutionGoClient
    const result = await evolutionGoClient.sendTextMessage(targetPhone, messageText);

    if (result.ok) {
      let resumeResult = null;
      if (includeResume) {
        try {
          resumeResult = await evolutionGoClient.sendDocumentMessage(targetPhone, resumeBuffer, resumeFilename);
        } catch (error) {
          resumeResult = { ok: false, error: error.message || "Unexpected resume delivery error" };
        }
        if (!resumeResult.ok) {
          logger.warn(`WhatsApp text sent to ${targetPhone}, but resume delivery failed: ${resumeResult.error}`);
          return {
            success: false,
            partial: true,
            textMessageId: result.messageId,
            error: `WhatsApp message sent, but resume attachment failed: ${resumeResult.error}`
          };
        }
      }
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
        resumeMessageId: resumeResult?.messageId || null,
        resumeFilename,
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
  async sendBatch(companyIds = [], onProgress = null, options = {}) {
    const settings = settingsService.getSettings(false);
    const delayMs = settings.whatsAppDelayMs || 15000;
    const templateId = options.templateId || await emailTemplates.getActiveTemplateId();
    const template = whatsappGenerator.getTemplateDetails(templateId);
    if (!template) throw new Error("Unknown outreach template target.");

    const results = {
      total: companyIds.length,
      sent: 0,
      failed: 0,
      skipped: 0,
      templateId,
      templateTarget: template.target,
      details: []
    };

    logger.info(`Starting WhatsApp batch send for ${companyIds.length} lead(s) with ${delayMs}ms delay...`);

    for (let i = 0; i < companyIds.length; i++) {
      const companyId = companyIds[i];
      try {
        const sendRes = await this.sendSingleMessage(companyId, null, null, { templateId });
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
