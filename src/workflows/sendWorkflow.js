const readline = require("readline");
const db = require("../db/database");
const emailGenerator = require("../services/emailGenerator");
const emailSender = require("../services/emailSender");
const exportService = require("../services/exportService");
const logger = require("../services/logger");
const config = require("../config");

function askConfirmation(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const normalized = (answer || "").trim().toLowerCase();
      resolve(normalized === "y" || normalized === "yes");
    });
  });
}

async function showPreview(options = {}) {
  const limit = options.limit || 15;
  const leads = db.getFinalQualifiedLeads(limit);

  logger.section(`Lead Outreach Preview (Top ${leads.length} Leads)`);

  const previewItems = [];
  leads.forEach((l, idx) => {
    const contact = {
      id: l.contact_id,
      name: l.contact_name,
      role: l.contact_role,
      email: l.email,
      email_type: l.email_type,
      confidence: l.email_confidence
    };

    const hasEmail = Boolean(l.email);
    const emailData = hasEmail ? emailGenerator.generateEmail(l, contact) : null;

    previewItems.push({
      "No.": idx + 1,
      Company: l.name.slice(0, 22),
      Employees: l.employee_size_range || (l.employee_count ? `${l.employee_count}+` : "30+"),
      Verified: l.employee_count_verified ? "✓ Verified" : "Unverified",
      Source: (l.employee_count_source || "LinkedIn").slice(0, 15),
      ContactEmail: l.email || "[No Public Contact]",
      Confidence: l.email_confidence || "NONE",
      Status: l.status
    });
  });

  console.table(previewItems);

  const stats = db.getStatistics();
  console.log(`\n📊 Total Ready in Queue: ${stats.readyToSend} | Verified (>= 30): ${stats.employeeVerified} | High Confidence: ${stats.highConfidence}`);

  return leads;
}

async function runSend(options = {}) {
  const isDryRun = options.dryRun !== undefined ? options.dryRun : config.dryRun;
  const limit = options.limit !== undefined ? options.limit : (config.sendLimit || null);
  const autoConfirm = options.yes || false;

  const threshold = config.minEmployeeCount;
  const leads = db.getFinalQualifiedLeads(limit ? limit * 3 : null);
  const eligibleLeads = leads.filter((l) => {
    if (!l.email || !["HIGH", "MEDIUM"].includes(l.email_confidence) || db.hasBeenContacted(l.email, l.id)) {
      return false;
    }
    if (threshold && threshold > 0) {
      const passesVerified = l.employee_count_verified === 1 || l.employee_count_status === "QUALIFIED";
      const passesCount = (l.employee_count !== null && l.employee_count >= threshold) || (l.employee_count_min !== null && l.employee_count_min >= threshold);
      return passesVerified && passesCount;
    }
    return true;
  });

  if (eligibleLeads.length === 0) {
    logger.warn("No eligible uncontacted leads found in the database. Run `npm run leads` first.");
    return;
  }

  const selectedLeads = limit ? eligibleLeads.slice(0, limit) : eligibleLeads;
  logger.section(`Outreach Sender (Total: ${selectedLeads.length} Leads, Mode: ${isDryRun ? "🧪 DRY RUN" : "🚀 LIVE SEND"})`);

  const batchToSend = selectedLeads.map((l) => {
    const contact = {
      id: l.contact_id,
      name: l.contact_name,
      role: l.contact_role,
      email: l.email,
      email_type: l.email_type,
      confidence: l.email_confidence
    };

    return {
      company: l,
      contact,
      mailOptions: emailGenerator.generateEmail(l, contact)
    };
  });

  console.log(`\n📋 Prepared ${batchToSend.length} emails for sending:`);
  batchToSend.forEach((item, i) => {
    console.log(`  [${i + 1}] ${item.company.name} -> ${item.contact.email} (${item.contact.confidence}, ${item.contact.email_type})`);
  });

  if (!autoConfirm) {
    const promptText = isDryRun
      ? `\n🧪 Simulate sending ${batchToSend.length} dry-run emails? [y/N]: `
      : `\n⚠️  Are you sure you want to SEND ${batchToSend.length} LIVE emails via Gmail SMTP? [y/N]: `;

    const confirmed = await askConfirmation(promptText);
    if (!confirmed) {
      logger.warn("Outreach batch aborted by user.");
      return;
    }
  }

  const result = await emailSender.sendBatch(batchToSend, {
    dryRun: isDryRun,
    limit: batchToSend.length
  });

  // Re-export files after sending to update statuses
  await exportService.exportAll();

  return result;
}

module.exports = { showPreview, runSend };
