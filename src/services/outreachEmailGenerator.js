const emailGenerator = require("./emailGenerator");
const emailTemplates = require("./emailTemplates");

function parsePublicApps(company) {
  if (!company || !company.public_apps) return [];
  try {
    const apps = typeof company.public_apps === "string"
      ? JSON.parse(company.public_apps)
      : company.public_apps;
    return Array.isArray(apps) ? apps : [];
  } catch {
    return [];
  }
}

function cleanVariable(value, fallback) {
  const cleaned = String(value || fallback || "Your Shopify business")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 200);
  return cleaned || "Your Shopify business";
}

function getTemplateVariable(templateId, company = {}) {
  const apps = parsePublicApps(company);
  if (templateId === "appDevelopers") {
    const appName = company.app_name || apps[0]?.app_name || company.name;
    return { app_name: cleanVariable(appName, "your Shopify app") };
  }
  if (templateId === "agencies") {
    return { agency_name: cleanVariable(company.agency_name || company.name, "your agency") };
  }
  return { store_name: cleanVariable(company.store_name || company.name, "your Shopify store") };
}

function toPlainTextHtml(text) {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
  return `<div style="font-family: Arial, sans-serif; line-height: 1.6; white-space: pre-wrap;">${escaped}</div>`;
}

async function generateEmail(company, contact = null, options = {}) {
  const templateId = options.templateId || await emailTemplates.getActiveTemplateId();
  const variables = getTemplateVariable(templateId, company);
  const rendered = await emailTemplates.renderTemplate(templateId, variables);
  const baseMailOptions = options.baseMailOptions || emailGenerator.generateEmail(company, contact);
  const attachments = Array.isArray(baseMailOptions.attachments) ? baseMailOptions.attachments : [];

  return {
    ...baseMailOptions,
    subject: rendered.subject,
    text: rendered.body,
    html: toPlainTextHtml(rendered.body),
    attachments: templateId === "freelancingStores" ? [] : attachments
  };
}

module.exports = {
  generateEmail,
  getTemplateVariable,
  toPlainTextHtml
};
