const settingsService = require("./settingsService");

const whatsappGenerator = {
  /**
   * Generates a concise, personalized WhatsApp outreach message
   */
  generateMessage(company, contact = null) {
    const settings = settingsService.getSettings(false);

    const candidateName = settings.candidateName || "Himanshu Soni";
    const candidateRole = settings.candidateRole || "Shopify Developer";
    const candidateExperience = settings.candidateExperience || "3 years";

    const companyName = company.name || "Your Team";
    const greeting = contact && contact.name && contact.name.trim().length > 0 && !["Hiring Team", "Team"].includes(contact.name)
      ? `Hi ${contact.name.trim()},`
      : `Hi ${companyName} Team,`;

    const text = `${greeting}

I’m ${candidateName}, a ${candidateRole} with around ${candidateExperience} of experience in Shopify, Shopify Plus, custom apps, APIs, GraphQL, JavaScript and Node.js.

I came across your Shopify work and I’m currently exploring Shopify Developer opportunities.

I’d be happy to share my resume if there is any relevant opening.

Thanks,
${candidateName}`;

    return {
      recipientName: contact && contact.name ? contact.name : `${companyName} Team`,
      companyName,
      phone: contact?.normalized_phone || contact?.phone || company.normalized_phone || company.phone,
      text
    };
  }
};

module.exports = whatsappGenerator;
