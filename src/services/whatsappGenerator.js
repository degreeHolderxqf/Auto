const settingsService = require("./settingsService");
const emailTemplates = require("./emailTemplates");

const TEMPLATE_COPY = Object.freeze({
  freelancingStores: {
    target: "Freelancing Stores",
    includeResume: false
  },
  appDevelopers: {
    target: "App Developers",
    includeResume: true
  },
  agencies: {
    target: "Agencies",
    includeResume: true
  }
});

const whatsappGenerator = {
  getTemplateDetails(templateId) {
    return TEMPLATE_COPY[templateId] || null;
  },

  /** Generates WhatsApp outreach copy for the selected email outreach audience. */
  generateMessage(company, contact = null, templateId = "freelancingStores") {
    const template = TEMPLATE_COPY[templateId];
    if (!template) throw new Error("Unknown outreach template target.");

    const settings = settingsService.getSettings(false);
    const candidateName = settings.candidateName || "Himanshu Soni";
    const candidateRole = settings.candidateRole || "Shopify Developer";
    const candidateExperience = settings.candidateExperience || "3 years";
    const companyName = company.name || company.store_name || "Your Team";
    const contactName = typeof contact?.name === "string"
      ? contact.name.trim()
      : typeof company.contact_name === "string" ? company.contact_name.trim() : "";
    const greeting = contactName && !["Hiring Team", "Team"].includes(contactName)
      ? `Hi ${contactName},`
      : `Hi ${companyName} team,`;

    let body;
    if (templateId === "freelancingStores") {
      body = `I am ${candidateName}, a Shopify developer with around ${candidateExperience} of experience. I help stores build custom Shopify features and improve storefronts without adding unnecessary app overhead.\n\nIf you have a feature or store improvement in mind, I would be happy to suggest an approach. Here is my portfolio: ${emailTemplates.PORTFOLIO_URL}`;
    } else if (templateId === "appDevelopers") {
      body = `I am ${candidateName}, a ${candidateRole} with around ${candidateExperience} of experience. I can help Shopify app teams with feature work across React, Remix, GraphQL, Shopify APIs, and app extensions.\n\nIf your team needs extra development capacity, I would be glad to connect. I have attached my resume for context.`;
    } else {
      body = `I am ${candidateName}, a ${candidateRole} with around ${candidateExperience} of experience. I provide white-label Shopify development support for agency client work, including theme development, Liquid sections, React, Remix, and Shopify APIs.\n\nIf you have upcoming overflow work, I would be glad to discuss how I can support your team. I have attached my resume for context.`;
    }

    const text = `${greeting}\n\n${body}\n\nBest,\n${candidateName}`;

    return {
      recipientName: contactName || `${companyName} Team`,
      companyName,
      phone: contact?.normalized_phone || contact?.phone || company.contact_phone || company.normalized_phone || company.phone || null,
      templateId,
      templateTarget: template.target,
      includeResume: template.includeResume,
      text
    };
  },

  async generateActiveMessage(company, contact = null, templateId = null) {
    const selectedTemplateId = templateId || await emailTemplates.getActiveTemplateId();
    return this.generateMessage(company, contact, selectedTemplateId);
  }
};

module.exports = whatsappGenerator;
