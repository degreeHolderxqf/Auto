const nodemailer = require("nodemailer");
const config = require("../config");
const db = require("../db/database");
const logger = require("./logger");

class SettingsService {
  constructor() {
    this.cachedSettings = null;
  }

  /**
   * Returns default system settings initialized from .env / config
   */
  getDefaults() {
    return {
      // 1. Candidate / User Profile
      candidateName: process.env.CANDIDATE_NAME || "Himanshu Soni",
      candidateRole: process.env.CANDIDATE_ROLE || "Shopify Developer",
      candidateExperience: process.env.CANDIDATE_EXPERIENCE || "3 years",
      candidateEmail: process.env.CANDIDATE_EMAIL || config.smtp.user || "himanshusoni7899@gmail.com",
      candidatePhone: process.env.CANDIDATE_PHONE || "",
      candidateSkills: [
        "Shopify & Shopify Plus Theme Development (Liquid, Theme App Extensions, Section Rendering)",
        "Custom App & Full-Stack Development (Node.js, Remix, React, JavaScript)",
        "Shopify Admin & Storefront GraphQL / REST APIs, Webhooks, and Systems Integrations",
        "Checkout Extensibility, Functions, and Headless Commerce setups"
      ],
      resumeFilename: "Himanshu-Soni-Shopify-Developer-Resume.pdf",
      resumePath: config.resumePath,

      // 2. SMTP Server Configuration
      smtpHost: config.smtp.host || "smtp.gmail.com",
      smtpPort: config.smtp.port || 587,
      smtpSecure: config.smtp.secure || false,
      smtpUser: config.smtp.user || "himanshusoni7899@gmail.com",
      smtpPass: config.smtp.pass || "",
      emailFrom: config.smtp.from || "Himanshu Soni <himanshusoni7899@gmail.com>",

      // 3. Lead Discovery & Targeting
      shopifyDirectoryUrl: config.shopifyDirectoryUrl || "https://www.shopify.com/in/partners/directory/locations/india?minPrice=&maxPrice=&sort=AVERAGE_RATING",
      targetCountry: config.targetCountry || "India",
      targetLeads: config.targetLeads || 100,
      minAppRelevanceScore: config.minAppRelevanceScore || 70,

      // 4. Employee Size Verification (Optional)
      minEmployeeCount: config.minEmployeeCount !== undefined ? config.minEmployeeCount : 30,

      // 5. Safety & Sending Controls
      dryRun: config.dryRun !== undefined ? config.dryRun : true,
      sendLimit: config.sendLimit || 50,
      emailDelayMs: config.emailDelayMs || 5000,
      batchSize: config.batchSize || 10,
      batchDelayMs: config.batchDelayMs || 60000
    };
  }

  /**
   * Retrieves active settings, merging defaults with DB overrides.
   * @param {boolean} maskSecrets - Whether to mask passwords (e.g. for Web UI)
   */
  getSettings(maskSecrets = false) {
    const defaults = this.getDefaults();
    let dbOverrides = {};

    try {
      dbOverrides = db.getAllSettings();
    } catch {
      // Table might not be ready yet
    }

    const merged = {
      ...defaults,
      ...dbOverrides
    };

    // Ensure candidateSkills is an array
    if (typeof merged.candidateSkills === "string") {
      try {
        merged.candidateSkills = JSON.parse(merged.candidateSkills);
      } catch {
        merged.candidateSkills = merged.candidateSkills.split("\n").map((s) => s.trim()).filter(Boolean);
      }
    }

    // Ensure numeric types
    if (merged.smtpPort) merged.smtpPort = parseInt(merged.smtpPort, 10);
    if (merged.targetLeads) merged.targetLeads = parseInt(merged.targetLeads, 10);
    if (merged.minAppRelevanceScore) merged.minAppRelevanceScore = parseInt(merged.minAppRelevanceScore, 10);
    if (merged.sendLimit) merged.sendLimit = parseInt(merged.sendLimit, 10);
    if (merged.emailDelayMs) merged.emailDelayMs = parseInt(merged.emailDelayMs, 10);
    if (merged.batchSize) merged.batchSize = parseInt(merged.batchSize, 10);
    if (merged.batchDelayMs) merged.batchDelayMs = parseInt(merged.batchDelayMs, 10);

    // Normalize minEmployeeCount (null / 0 / false means disabled)
    if (merged.minEmployeeCount !== null && merged.minEmployeeCount !== undefined) {
      if (String(merged.minEmployeeCount).toLowerCase() === "false" || merged.minEmployeeCount === 0 || merged.minEmployeeCount === "0") {
        merged.minEmployeeCount = null;
      } else {
        merged.minEmployeeCount = parseInt(merged.minEmployeeCount, 10);
      }
    }

    // Sync to in-memory config object
    this.syncConfig(merged);

    if (maskSecrets) {
      return {
        ...merged,
        smtpPass: merged.smtpPass ? "••••••••" : ""
      };
    }

    return merged;
  }

  /**
   * Updates settings and saves them to DB.
   * If smtpPass is "••••••••" or empty, preserves existing password.
   */
  updateSettings(newSettings = {}) {
    const current = this.getSettings(false);
    const updated = { ...current, ...newSettings };

    // Prevent overwriting actual password with masked placeholder
    if (newSettings.smtpPass === "••••••••" || newSettings.smtpPass === undefined || newSettings.smtpPass === "") {
      updated.smtpPass = current.smtpPass;
    }

    // Format candidateSkills array
    if (Array.isArray(updated.candidateSkills)) {
      updated.candidateSkills = updated.candidateSkills.filter((s) => typeof s === "string" && s.trim().length > 0);
    } else if (typeof updated.candidateSkills === "string") {
      updated.candidateSkills = updated.candidateSkills.split("\n").map((s) => s.trim()).filter(Boolean);
    }

    // Format numeric and boolean fields
    if (updated.smtpPort) updated.smtpPort = parseInt(updated.smtpPort, 10);
    if (updated.smtpSecure !== undefined) updated.smtpSecure = Boolean(updated.smtpSecure);
    if (updated.dryRun !== undefined) updated.dryRun = Boolean(updated.dryRun);
    if (updated.targetLeads) updated.targetLeads = parseInt(updated.targetLeads, 10);
    if (updated.minAppRelevanceScore) updated.minAppRelevanceScore = parseInt(updated.minAppRelevanceScore, 10);

    if (updated.minEmployeeCount === 0 || String(updated.minEmployeeCount).toLowerCase() === "false" || updated.minEmployeeCount === "" || updated.minEmployeeCount === null) {
      updated.minEmployeeCount = null;
    } else if (updated.minEmployeeCount) {
      updated.minEmployeeCount = parseInt(updated.minEmployeeCount, 10);
    }

    // Save to DB
    db.saveAllSettings(updated);

    // Sync in-memory config
    this.syncConfig(updated);

    logger.success("Dynamic settings successfully updated.");
    return this.getSettings(true);
  }

  /**
   * Updates global in-memory config dynamically
   */
  syncConfig(settings) {
    config.smtp.host = settings.smtpHost;
    config.smtp.port = settings.smtpPort;
    config.smtp.secure = settings.smtpSecure;
    config.smtp.user = settings.smtpUser;
    config.smtp.pass = settings.smtpPass;
    config.smtp.from = settings.emailFrom;

    config.shopifyDirectoryUrl = settings.shopifyDirectoryUrl;
    config.targetCountry = settings.targetCountry;
    config.targetLeads = settings.targetLeads;
    config.minAppRelevanceScore = settings.minAppRelevanceScore;
    config.minEmployeeCount = settings.minEmployeeCount;

    config.dryRun = settings.dryRun;
    config.sendLimit = settings.sendLimit;
    config.emailDelayMs = settings.emailDelayMs;
    config.batchSize = settings.batchSize;
    config.batchDelayMs = settings.batchDelayMs;

    if (settings.resumePath) {
      config.resumePath = settings.resumePath;
    }
  }

  /**
   * Tests SMTP Connection live with nodemailer.verify()
   */
  async testSmtpConnection(customSmtp = {}) {
    const current = this.getSettings(false);
    const host = customSmtp.smtpHost || current.smtpHost;
    const port = parseInt(customSmtp.smtpPort || current.smtpPort, 10);
    const secure = customSmtp.smtpSecure !== undefined ? Boolean(customSmtp.smtpSecure) : current.smtpSecure;
    const user = customSmtp.smtpUser || current.smtpUser;
    let pass = customSmtp.smtpPass;

    if (!pass || pass === "••••••••") {
      pass = current.smtpPass;
    }

    if (!host || !user || !pass) {
      return {
        success: false,
        error: "Missing required SMTP credentials (Host, Username, or App Password)."
      };
    }

    try {
      const transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: {
          user,
          pass
        },
        connectionTimeout: 10000,
        greetingTimeout: 10000
      });

      await transporter.verify();

      return {
        success: true,
        message: `Successfully connected and authenticated with ${host}:${port} as ${user}`
      };
    } catch (err) {
      return {
        success: false,
        error: err.message || "Failed to authenticate with SMTP server. Check credentials."
      };
    }
  }
}

module.exports = new SettingsService();
