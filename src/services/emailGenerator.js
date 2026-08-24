const config = require("../config");
const settingsService = require("./settingsService");

const emailGenerator = {
  /**
   * Generates a tailored subject and body based on the researched company, contact, and active candidate settings
   */
  generateEmail(company, contact = null) {
    const settings = settingsService.getSettings(false);

    const candidateName = settings.candidateName || "Himanshu Soni";
    const candidateRole = settings.candidateRole || "Shopify Developer";
    const candidateExperience = settings.candidateExperience || "3 years";
    const candidateEmail = settings.candidateEmail || settings.smtpUser || "himanshusoni7899@gmail.com";
    const candidatePhone = settings.candidatePhone || "";
    const skills = Array.isArray(settings.candidateSkills) && settings.candidateSkills.length > 0
      ? settings.candidateSkills
      : [
          "Shopify & Shopify Plus Theme Development (Liquid, Theme App Extensions, Section Rendering)",
          "Custom App & Full-Stack Development (Node.js, Remix, React, JavaScript)",
          "Shopify Admin & Storefront GraphQL / REST APIs, Webhooks, and Systems Integrations",
          "Checkout Extensibility, Functions, and Headless Commerce setups"
        ];

    const resumeFilename = settings.resumeFilename || `${candidateName.replace(/\s+/g, "-")}-Resume.pdf`;
    const resumePath = settings.resumePath || config.resumePath;

    const companyName = company.name || "Your Team";
    const recipientName = contact && contact.name ? contact.name : "Hiring Team";
    
    // Parse services
    let servicesList = [];
    if (company.shopify_services) {
      try {
        servicesList = typeof company.shopify_services === "string" ? JSON.parse(company.shopify_services) : company.shopify_services;
      } catch (e) {
        servicesList = company.shopify_services.split(",").map((s) => s.trim());
      }
    }

    const isAppFocused = company.app_relevance_score >= 85 || (servicesList && servicesList.some((s) => s.toLowerCase().includes("app")));
    const isPlus = (company.partner_tier && company.partner_tier.toLowerCase().includes("plus")) || (servicesList && servicesList.some((s) => s.toLowerCase().includes("plus") || s.toLowerCase().includes("headless")));

    let focusSentence = "I have been following your work in the Shopify ecosystem";
    if (isAppFocused) {
      focusSentence = `I noticed ${companyName}'s strong focus on custom Shopify apps, extensions, and technical integrations`;
    } else if (isPlus) {
      focusSentence = `I came across ${companyName}'s work in high-growth Shopify Plus and enterprise commerce implementations`;
    } else if (servicesList.length > 0) {
      focusSentence = `I came across ${companyName}'s specialized services in ${servicesList.slice(0, 2).join(" & ")}`;
    }

    const subject = `${candidateRole} — Application for Opportunities at ${companyName}`;

    const textSkills = skills.map((s) => `- ${s}`).join("\n");

    const text = `Hi ${recipientName},

I hope this email finds you well.

My name is ${candidateName}, and I am a ${candidateRole} with approximately ${candidateExperience} of experience building high-performance e-commerce solutions, custom apps, and tailored merchant experiences.

${focusSentence}, and I would love to explore potential developer openings with your engineering team.

My technical experience includes:
${textSkills}

I have attached my resume for your review. If there is an active opening or upcoming opportunity that aligns with my background, I would welcome the opportunity to connect and discuss how I can contribute to ${companyName}.

Thank you for your time and consideration.

Best regards,
${candidateName}
${candidateRole}
Email: ${candidateEmail}${candidatePhone ? `\nPhone: ${candidatePhone}` : ""}
`;

    const htmlSkills = skills.map((s) => `<li style="margin-bottom: 4px;">${s}</li>`).join("\n");

    const html = `
      <div style="font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #1e293b; max-width: 620px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
        <div style="background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%); padding: 24px 28px; color: #ffffff;">
          <h2 style="margin: 0 0 6px 0; font-size: 20px; font-weight: 600; color: #ffffff;">${candidateRole} Opportunity Inquiry</h2>
          <p style="margin: 0; font-size: 14px; opacity: 0.9;">Hi ${recipientName},</p>
        </div>
        <div style="background: #ffffff; padding: 28px; font-size: 14px; color: #334155;">
          <p style="margin-top: 0;">I hope you are doing well.</p>
          <p>My name is <strong>${candidateName}</strong>. I am a ${candidateRole} with approximately <strong>${candidateExperience}</strong> specializing in Shopify & Shopify Plus development, custom applications, and e-commerce integrations.</p>
          <p>${focusSentence}, and I am writing to express my strong interest in joining your development team.</p>
          
          <div style="background: #f8fafc; border-left: 4px solid #3b82f6; padding: 14px 18px; margin: 20px 0; border-radius: 0 6px 6px 0;">
            <p style="margin: 0 0 8px 0; font-weight: 600; color: #0f172a;">Core Technical Expertise:</p>
            <ul style="margin: 0; padding-left: 18px; color: #475569;">
              ${htmlSkills}
            </ul>
          </div>

          <p>I have attached my updated resume for your review. If you have an open role or are planning to expand your engineering team, I would be grateful for the opportunity to speak with you.</p>
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

module.exports = emailGenerator;
