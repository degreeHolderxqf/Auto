const config = require("../config");

const emailGenerator = {
  /**
   * Generates a tailored subject and body based on the researched company and contact
   */
  generateEmail(company, contact = null) {
    const companyName = company.name || "Your Team";
    const recipientName = contact && contact.name ? contact.name : "Hiring Team";
    
    // Parse services
    let servicesList = [];
    if (company.shopify_services) {
      try {
        servicesList = typeof company.shopify_services === "string" ? JSON.parse(company.shopify_services) : company.shopify_services;
      } catch (e) {
        servicesList = company.shopify_services.split(",").map(s => s.trim());
      }
    }

    const isAppFocused = company.app_relevance_score >= 85 || (servicesList && servicesList.some(s => s.toLowerCase().includes("app")));
    const isPlus = (company.partner_tier && company.partner_tier.toLowerCase().includes("plus")) || (servicesList && servicesList.some(s => s.toLowerCase().includes("plus") || s.toLowerCase().includes("headless")));

    let focusSentence = "I have been following your work in the Shopify ecosystem";
    if (isAppFocused) {
      focusSentence = `I noticed ${companyName}'s strong focus on custom Shopify apps, extensions, and technical integrations`;
    } else if (isPlus) {
      focusSentence = `I came across ${companyName}'s work in high-growth Shopify Plus and enterprise commerce implementations`;
    } else if (servicesList.length > 0) {
      focusSentence = `I came across ${companyName}'s specialized services in ${servicesList.slice(0, 2).join(" & ")}`;
    }

    const subject = `Shopify Developer — Application for Opportunities at ${companyName}`;

    const text = `Hi ${recipientName},

I hope this email finds you well.

My name is Himanshu Soni, and I am a Shopify Developer with approximately 3 years of experience building high-performance e-commerce solutions, custom apps, and tailored merchant experiences.

${focusSentence}, and I would love to explore potential developer openings with your engineering team.

My technical experience includes:
- Shopify & Shopify Plus Theme Development (Liquid, Theme App Extensions, Section Rendering)
- Custom App & Full-Stack Development (Node.js, Remix, React, JavaScript)
- Shopify Admin & Storefront GraphQL / REST APIs, Webhooks, and Systems Integrations
- Checkout Extensibility, Functions, and Headless Commerce setups

I have attached my resume for your review. If there is an active opening or upcoming opportunity that aligns with my background, I would welcome the opportunity to connect and discuss how I can contribute to ${companyName}.

Thank you for your time and consideration.

Best regards,
Himanshu Soni
Shopify Developer
Email: himanshusoni7899@gmail.com
`;

    const html = `
      <div style="font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #1e293b; max-width: 620px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
        <div style="background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%); padding: 24px 28px; color: #ffffff;">
          <h2 style="margin: 0 0 6px 0; font-size: 20px; font-weight: 600; color: #ffffff;">Shopify Developer Opportunity Inquiry</h2>
          <p style="margin: 0; font-size: 14px; opacity: 0.9;">Hi ${recipientName},</p>
        </div>
        <div style="background: #ffffff; padding: 28px; font-size: 14px; color: #334155;">
          <p style="margin-top: 0;">I hope you are doing well.</p>
          <p>My name is <strong>Himanshu Soni</strong>. I am a Shopify Developer with approximately <strong>3 years of experience</strong> specializing in Shopify & Shopify Plus development, custom applications, and e-commerce integrations.</p>
          <p>${focusSentence}, and I am writing to express my strong interest in joining your development team.</p>
          
          <div style="background: #f8fafc; border-left: 4px solid #3b82f6; padding: 14px 18px; margin: 20px 0; border-radius: 0 6px 6px 0;">
            <p style="margin: 0 0 8px 0; font-weight: 600; color: #0f172a;">Core Technical Expertise:</p>
            <ul style="margin: 0; padding-left: 18px; color: #475569;">
              <li style="margin-bottom: 4px;"><strong>Shopify & Plus:</strong> Liquid, Theme Customization, Theme App Extensions</li>
              <li style="margin-bottom: 4px;"><strong>App Development:</strong> Node.js, Remix, React, JavaScript</li>
              <li style="margin-bottom: 4px;"><strong>APIs & Architecture:</strong> GraphQL, REST APIs, Webhooks, Custom Integrations</li>
              <li><strong>Modern Commerce:</strong> Checkout Extensibility, Functions, Performance Optimization</li>
            </ul>
          </div>

          <p>I have attached my updated resume for your review. If you have an open role or are planning to expand your Shopify engineering team, I would be grateful for the opportunity to speak with you.</p>
          <p>Thank you very much for your time and consideration.</p>
          
          <div style="margin-top: 24px; padding-top: 18px; border-top: 1px solid #e2e8f0;">
            <p style="margin: 0; font-weight: 600; color: #0f172a;">Best regards,</p>
            <p style="margin: 2px 0 0 0; color: #1e293b; font-size: 15px;"><strong>Himanshu Soni</strong></p>
            <p style="margin: 2px 0 0 0; color: #64748b; font-size: 13px;">Shopify Developer</p>
          </div>
        </div>
      </div>
    `;

    return {
      from: config.smtp.from,
      to: contact ? contact.email : null,
      subject,
      text,
      html,
      attachments: [
        {
          filename: "Himanshu-Soni-Shopify-Developer-Resume.pdf",
          path: config.resumePath,
          contentType: "application/pdf"
        }
      ]
    };
  }
};

module.exports = emailGenerator;
