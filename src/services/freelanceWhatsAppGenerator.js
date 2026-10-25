const settingsService = require("./settingsService");
const normalizer = require("./normalizer");

/**
 * Freelance Opportunity Outreach WhatsApp Message Generator
 *
 * Generates personalized WhatsApp outreach messages for freelance/agency
 * outreach based on deep qualification evidence. Completely separate from
 * merchant/merchant-lead and job-application WhatsApp generators.
 */

const freelanceWhatsAppGenerator = {
  /**
   * Generates a concise, personalized WhatsApp outreach message
   */
  generateMessage(company, contact = null) {
    const settings = settingsService.getSettings(false);

    const candidateName = settings.candidateName || "Himanshu Soni";
    const candidateRole = settings.candidateRole || "Shopify Expert";
    const candidateExperience = settings.candidateExperience || "5 years";

    const companyName = company.name || company.store_name || "Your Team";
    const greeting = contact && contact.name && contact.name.trim().length > 0 && !["Hiring Team", "Team"].includes(contact.name)
      ? `Hey ${contact.name.trim()},`
      : `Hey ${companyName} Team,`;

    // Extract deep qualification evidence
    const leadDetails = company.leadDetails || {};
    const serviceOfferings = Array.isArray(leadDetails.service_offerings) ? leadDetails.service_offerings : [];
    const portfolioItems = Array.isArray(leadDetails.portfolio_items) ? leadDetails.portfolio_items : [];
    const clientTestimonials = Array.isArray(leadDetails.client_testimonials) ? leadDetails.client_testimonials : [];
    const techStackEvidence = Array.isArray(leadDetails.tech_stack_evidence) ? leadDetails.tech_stack_evidence : [];

    // Determine primary focus for personalization
    let focusArea = "";
    let personalizationHook = "";

    if (serviceOfferings.length > 0) {
      const topServices = serviceOfferings.slice(0, 3).map(s => s.toLowerCase());
      if (topServices.some(s => s.includes("app") || s.includes("development") || s.includes("custom"))) {
        focusArea = "Shopify app development";
        personalizationHook = `I noticed your team works on ${serviceOfferings.slice(0, 2).join(" and ")}`;
      } else if (topServices.some(s => s.includes("theme") || s.includes("design") || s.includes("ux"))) {
        focusArea = "Shopify theme & design";
        personalizationHook = `I saw your recent Shopify theme work and was impressed`;
      } else if (topServices.some(s => s.includes("plus") || s.includes("enterprise"))) {
        focusArea = "Shopify Plus enterprise solutions";
        personalizationHook = `Your Shopify Plus expertise stands out`;
      }
    }

    if (!personalizationHook && portfolioItems.length > 0) {
      personalizationHook = `I reviewed your portfolio and loved ${portfolioItems[0].name || "your recent projects"}`;
    }

    if (!personalizationHook && clientTestimonials.length > 0) {
      personalizationHook = `Clients consistently praise your ${clientTestimonials[0].theme || "work quality"}`;
    }

    if (!personalizationHook && techStackEvidence.length > 0) {
      personalizationHook = `I see you're using ${techStackEvidence.slice(0, 2).join(", ")}`;
    }

    // Fallback to basic company info
    if (!personalizationHook) {
      personalizationHook = `I came across ${companyName} and noticed your Shopify presence`;
    }

    const text = `${greeting}

I'm ${candidateName}, a ${candidateRole} with around ${candidateExperience} of experience building high-performance Shopify solutions, custom apps, and tailored merchant experiences.

${personalizationHook}. I help agencies and development shops like yours scale their capabilities and take on more complex projects.

I'm currently exploring Shopify Developer / freelance opportunities. If you're looking to expand your team's capabilities or need expert support on complex Shopify projects, I'd love to connect.

Best,
${candidateName}
${candidateRole}`;

    return {
      recipientName: contact && contact.name ? contact.name : `${companyName} Team`,
      companyName,
      text,
      phone: contact?.normalized_phone || contact?.phone || company.normalized_phone || company.phone || ""
    };
  }
};

module.exports = freelanceWhatsAppGenerator;