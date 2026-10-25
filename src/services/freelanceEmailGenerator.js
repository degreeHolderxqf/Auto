const config = require("../config");
const settingsService = require("./settingsService");
const normalizer = require("./normalizer");

/**
 * Freelance Opportunity Outreach Email Generator
 *
 * Generates personalized emails for freelance/agency outreach based on
 * deep qualification evidence (service offerings, portfolio, tech stack,
 * client testimonials, etc.). Completely separate from merchant/merchant-lead
 * and job-application email generators.
 */

const freelanceEmailGenerator = {
  /**
   * Generates a tailored subject and body based on the researched freelance
   * agency/company, contact, and active candidate settings.
   * Uses deep qualification evidence for personalization.
   */
  generateEmail(company, contact = null) {
    const settings = settingsService.getSettings(false);

    const candidateName = settings.candidateName || "Himanshu Soni";
    const candidateRole = settings.candidateRole || "Shopify Expert";
    const candidateExperience = settings.candidateExperience || "5 years";
    const candidateEmail = settings.candidateEmail || settings.smtpUser || "himanshusoni7899@gmail.com";
    const candidatePhone = settings.candidatePhone || "";
    const skills = Array.isArray(settings.candidateSkills) && settings.candidateSkills.length > 0
      ? settings.candidateSkills
      : [
          "Shopify & Shopify Plus Theme Development (Liquid, Theme App Extensions, Section Rendering)",
          "Custom Shopify App Development (Node.js, Ruby on Rails, PHP)",
          "Headless Commerce (Hydrogen, Remix, GraphQL, Storefront API)",
          "Shopify Plus Migration & Checkout Extensibility",
          "Performance & Speed Optimization (Core Web Vitals, Lighthouse)",
          "Third-party App Integration & Optimization",
          "E-commerce UX/UI Design & Conversion Rate Optimization"
        ];

    const resumeFilename = settings.resumeFilename || `${candidateName.replace(/\s+/g, "-")}-Resume.pdf`;
    const resumePath = settings.resumePath || config.resumeFallbackPath || config.resumePath;

    const companyName = company.name || company.store_name || "Your Team";
    const recipientName = contact && contact.name ? contact.name : "Hiring Team";

    // Extract deep qualification evidence
    const leadDetails = company.leadDetails || {};
    const serviceOfferings = Array.isArray(leadDetails.service_offerings) ? leadDetails.service_offerings : [];
    const portfolioItems = Array.isArray(leadDetails.portfolio_items) ? leadDetails.portfolio_items : [];
    const clientTestimonials = Array.isArray(leadDetails.client_testimonials) ? leadDetails.client_testimonials : [];
    const serviceGaps = Array.isArray(leadDetails.service_gaps) ? leadDetails.service_gaps : [];
    const techStackEvidence = Array.isArray(leadDetails.tech_stack_evidence) ? leadDetails.tech_stack_evidence : [];
    const geographicEvidence = Array.isArray(leadDetails.geographic_evidence) ? leadDetails.geographic_evidence : [];

    // Determine primary focus for personalization
    let focusArea = "";
    let personalizationHook = "";

    if (serviceOfferings.length > 0) {
      const topServices = serviceOfferings.slice(0, 3).map(s => s.toLowerCase());
      if (topServices.some(s => s.includes("app") || s.includes("development") || s.includes("custom"))) {
        focusArea = "custom Shopify app development";
        personalizationHook = `I noticed your team specializes in ${serviceOfferings.slice(0, 2).join(" and ")}`;
      } else if (topServices.some(s => s.includes("theme") || s.includes("design") || s.includes("ux"))) {
        focusArea = "Shopify theme design and development";
        personalizationHook = `I saw your impressive work on Shopify themes, particularly ${serviceOfferings[0] || "your recent projects"}`;
      } else if (topServices.some(s => s.includes("plus") || s.includes("enterprise") || s.includes("migration"))) {
        focusArea = "Shopify Plus enterprise solutions";
        personalizationHook = `Your expertise in Shopify Plus migrations and enterprise implementations caught my attention`;
      }
    }

    if (!personalizationHook && portfolioItems.length > 0) {
      personalizationHook = `I've been reviewing your portfolio and was particularly impressed by ${portfolioItems[0].name || "your recent work"}`;
    }

    if (!personalizationHook && clientTestimonials.length > 0) {
      personalizationHook = `I noticed your clients consistently praise your ${clientTestimonials[0].theme || "work quality and communication"}`;
    }

    if (!personalizationHook && techStackEvidence.length > 0) {
      personalizationHook = `I see you're working with ${techStackEvidence.slice(0, 2).join(", ")} - that's exactly the stack I specialize in optimizing`;
    }

    // Fallback to basic company info
    if (!personalizationHook) {
      personalizationHook = `I came across ${companyName} and noticed your strong presence in the Shopify ecosystem`;
    }

    // Subject line personalization
    let subject = `${candidateRole} — Collaboration Opportunity with ${companyName}`;
    if (focusArea) {
      subject = `${candidateRole} — ${focusArea} Specialist Available for ${companyName}`;
    }
    if (serviceOfferings.length > 0 && serviceOfferings.some(s => s.toLowerCase().includes("app"))) {
      subject = `${candidateRole} — Shopify App Development Partnership Opportunity`;
    }

    // Email body
    const textSkills = skills.map((s) => `- ${s}`).join("\n");

    let appContext = "";
    if (company.shopify_store_url) {
      appContext = `\n\nP.S. I visited your Shopify store at ${company.shopify_store_url} and have some specific ideas for optimization.`;
    }

    const text = `Hi ${recipientName},

I hope this email finds you well.

My name is ${candidateName}, and I am a ${candidateRole} with approximately ${candidateExperience} of experience building high-performance e-commerce solutions, custom apps, and tailored merchant experiences.

${personalizationHook}. I specialize in helping Shopify agencies and development shops like yours scale their capabilities and take on more complex projects.

My technical experience includes:
${textSkills}

I have attached my resume for your review. If you're looking to expand your team's capabilities or need expert support on complex Shopify projects, I would welcome the opportunity to connect and discuss how I can contribute to ${companyName}.

Thank you for your time and consideration.

Best regards,
${candidateName}
${candidateRole}
Email: ${candidateEmail}${candidatePhone ? `\nPhone: ${candidatePhone}` : ""}${appContext}
`;

    // HTML Email
    const htmlSkills = skills.map((s) => `<li style="margin-bottom: 4px;">${s}</li>`).join("\n");

    let focusBadge = "";
    if (focusArea) {
      focusBadge = `
        <div style="background: #f0fdf4; border: 1px solid #86efac; border-radius: 6px; padding: 10px 14px; margin: 16px 0;">
          <p style="margin: 0; font-size: 12px; color: #166534;">
            <strong>Focus:</strong> ${focusArea}
          </p>
        </div>
      `;
    }

    let portfolioHighlight = "";
    if (portfolioItems.length > 0) {
      portfolioHighlight = `
        <div style="background: #f8fafc; border-left: 4px solid #3b82f6; padding: 14px 18px; margin: 20px 0; border-radius: 0 6px 6px 0;">
          <p style="margin: 0 0 8px 0; font-weight: 600; color: #0f172a;">Recent Portfolio Highlights:</p>
          <ul style="margin: 0; padding-left: 18px; color: #475569;">
            ${portfolioItems.slice(0, 3).map(item => `
              <li style="margin-bottom: 4px;">${item.name || item.description || "Shopify project"}</li>
            `).join("")}
          </ul>
        </div>
      `;
    }

    let testimonialsSection = "";
    if (clientTestimonials.length > 0) {
      testimonialsSection = `
        <div style="background: #f0fdf4; border: 1px solid #86efac; border-radius: 6px; padding: 16px; margin: 20px 0;">
          <p style="margin: 0 0 8px 0; font-weight: 600; color: #0f172a;">What Clients Say:</p>
          <p style="margin: 0; color: #475569; font-style: italic;">
            "${clientTestimonials[0].quote || clientTestimonials[0].text || "Excellent communication and delivery"}"
          </p>
          <p style="margin: 4px 0 0 0; font-size: 13px; color: #64748b;"> — ${clientTestimonials[0].client || "Satisfied Client"}</p>
        </div>
      `;
    }

    const html = `
      <div style="font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #1e293b; max-width: 620px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
        <div style="background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%); padding: 24px 28px; color: #ffffff;">
          <h2 style="margin: 0 0 6px 0; font-size: 20px; font-weight: 600; color: #ffffff;">${candidateRole} Collaboration Inquiry</h2>
          <p style="margin: 0; font-size: 14px; opacity: 0.9;">Hi ${recipientName},</p>
        </div>
        <div style="background: #ffffff; padding: 28px; font-size: 14px; color: #334155;">
          <p style="margin-top: 0;">I hope you are doing well.</p>
          <p>My name is <strong>${candidateName}</strong>. I am a ${candidateRole} with approximately <strong>${candidateExperience}</strong> specializing in Shopify & Shopify Plus development, custom applications, and e-commerce integrations.</p>
          <p>${personalizationHook}, and I am writing to explore potential collaboration opportunities with your team.</p>

          ${focusBadge}
          ${portfolioHighlight}
          ${testimonialsSection}

          <div style="background: #f8fafc; border-left: 4px solid #3b82f6; padding: 14px 18px; margin: 20px 0; border-radius: 0 6px 6px 0;">
            <p style="margin: 0 0 8px 0; font-weight: 600; color: #0f172a;">Core Technical Expertise:</p>
            <ul style="margin: 0; padding-left: 18px; color: #475569;">
              ${htmlSkills}
            </ul>
          </div>

          <p>I have attached my updated resume for your review. If you have project overflow, need specialist support, or are looking to expand your team's capabilities, I would be grateful for the opportunity to speak with you.</p>
          <p>Thank you very much for your time and consideration.</p>

          <div style="margin-top: 24px; padding-top: 18px; border-top: 1px solid #e2e8f0;">
            <p style="margin: 0; font-weight: 600; color: #0f172a;">Best regards,</p>
            <p style="margin: 2px 0 0 0; color: #1e293b; font-size: 15px;"><strong>${candidateName}</strong></p>
            <p style="margin: 2px 0 0 0; color: #64748b; font-size: 13px;">${candidateRole}</p>
            ${candidatePhone ? `<p style="margin: 2px 0 0 0; color: #64748b; font-size: 12px;">Phone: ${candidatePhone}</p>` : ""}
          </div>
        </div>
      </div>
    `;

    return {
      from: settings.emailFrom || config.smtp.from,
      to: contact ? contact.email : null,
      subject,
      text,
      html,
      attachments: [
        {
          filename: resumeFilename,
          path: resumePath,
          contentType: "application/pdf"
        }
      ]
    };
  }
};

module.exports = freelanceEmailGenerator;
