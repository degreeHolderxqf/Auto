const settingsService = require("./settingsService");

/**
 * Dynamic Personalization Template Engine for Merchant B2B Pitching
 *
 * Generates highly personalized messages using the merchant's installed apps,
 * tech stack, and revenue data. Never uses generic "Hi, I am a Shopify Developer"
 * templates.
 */

const candidateProfile = () => {
  const settings = settingsService.getSettings(false);
  return {
    name: settings.candidateName || "Himanshu Soni",
    role: settings.candidateRole || "Shopify Expert",
    experience: settings.candidateExperience || "5 years",
    email: settings.candidateEmail || settings.smtpUser || "himanshusoni7899@gmail.com",
    phone: settings.candidatePhone || "",
    portfolio: settings.portfolioUrl || "",
    specialties: Array.isArray(settings.candidateSkills) && settings.candidateSkills.length
      ? settings.candidateSkills
      : ["Shopify & Shopify Plus Development", "App Integration & Optimization", "Performance & Speed Optimization"]
  };
};

const renderTemplate = (template, variables = {}) =>
  String(template).replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, key) => {
    const value = key.split(".").reduce((current, part) => current && current[part], variables);
    return value === null || value === undefined ? "" : String(value);
  });

/**
 * Detect which installed app category a plugin belongs to
 */
const detectAppCategory = (appName) => {
  const normalized = String(appName).toLowerCase();

  const emailMarketing = ["klaviyo", "omnisend", "privy", "mailchimp", "attentive", "postscript", "givesendgo", "convertkit", "mailerlite"];
  const reviewsLoyalty = ["yotpo", "judge.me", "okendo", "growave", "loyaltylion", "smile.io", "stamped.io", "loopyloyalti", "awin"];
  const checkout = ["snapmint", "zip", "affirm", "klarna", "afterpay", "sezzle", "shopify_plus_payments", "shopify_payments"];
  const pageBuilder = ["pagefly", "shogun", "gempages", "zipify", "bulkproducteditor"];
  const shippingInventory = ["shipstation", "afterShip", "easyship", "ordoro", "stocky"];
  const analytics = ["google_analytics", "hotjar", "microsoft_clarity", "pixie", "kissmetrics", "mixpanel"];
  const helpdesk = ["gorgias", "Zendesk", "helpscout", "freshdesk", "tidio", "livechat"];
  const subscriptions = ["recharge", "chargebee", "recurly", "yo_subscriptions", "paywhirl"];
  const upsellCross = ["releasit", "upcart", "candy-rack", "nawo", "vitals", "frequently-bought-together", "cross-sell", "up-sell"];
  const seo = ["seo-guru", "plugify_seo", "seo-master", "ryte"];
  const localization = ["intlified", "langify", "welcart", "geolocation"];

  for (const [category, apps] of Object.entries({
    emailMarketing, reviewsLoyalty, checkout, pageBuilder,
    shippingInventory, analytics, helpdesk, subscriptions,
    upsellCross, seo, localization
  })) {
    if (apps.some((app) => normalized.includes(app))) {
      return { category, apps };
    }
  }
  return { category: "general", apps: [] };
};

/**
 * Get app-specific value prop & action
 */
const getAppValueProp = (appName, category) => {
  const name = String(appName).trim();

  const valueProps = {
    // Email Marketing
    klaviyo: {
      action: "optimize its performance and loading speed so your emails don't hurt your store's Core Web Vitals",
      benefit: "I've helped several Shopify stores reduce Klaviyo's impact on page load times while actually improving email deliverability rates.",
      cta: "I'd be happy to run a free audit of your store's Klaviyo setup and show you exactly where speed and deliverability can be improved."
    },
    omnisend: {
      action: "streamline its workflows so they send faster and don't slow down your checkout flow",
      benefit: "Automation workflows can add extra requests on every page load — I optimize these so you keep the power without the performance hit.",
      cta: "Let me show you how to keep your automated flows lightning-fast while boosting your revenue per recipient."
    },
    privy: {
      action: "tune so popup triggers fire at the perfect moment without delaying content paint",
      benefit: "Popups are great for conversion, but poorly configured ones tank your Largest Contentful Paint. I fix both.",
      cta: "Want a free snapshot of how your popups are affecting your Core Web Vitals score? I can generate it in under 2 minutes."
    },
    mailchimp: {
      action: "integrate cleanly with your store so list segmentation doesn't trigger slow queries",
      benefit: "Every sync between Mailchimp and your store can add latency. I've built patterns that sync in the background without impacting customers.",
      cta: "Tell me how many products you have — I'll explain exactly how Mailchimp interacts with your catalog and how to make it faster."
    },
    attentive: {
      action: "keep SMS campaigns sending fast without adding load to your storefront",
      benefit: "SMS automation can spike requests during sales events. I implement queue patterns that keep things smooth.",
      cta: "Happy to share how other merchants keep their SMS channels blazing fast during flash sales."
    },
    postscript: {
      action: "so text campaigns load instantly even during peak traffic like Black Friday",
      benefit: "I've seen PostScript add latency during checkout. I optimize it so it stays invisible to customers.",
      cta: "Want me to review your PostScript setup and identify any performance bottlenecks? Free, no obligation."
    },
    convertkit: {
      action: "connect so your newsletter signup doesn't slow down your landing pages",
      benefit: "Forms on fast-loading pages convert better. I ensure ConvertKit adds zero noticeable delay.",
      cta: "Let's discuss how to keep your pages snappy while growing your list at the same time."
    },
    // Reviews & Loyalty
    yotpo: {
      action: "load lazy and only what's needed so review widgets don't slow down product pages",
      benefit: "Review widgets are heavy on resources. I've helped merchants cut their page load time in half while keeping 5-star trust signals front and center.",
      cta: "I'd love to share a before/after case study of how we optimized Yotpo for a store similar to yours."
    },
    judge_me: {
      action: "with lazy loading and preconnect hints so reviews don't block your main thread",
      benefit: "Judge.me adds several HTTP requests on every product page. I compress these and preconnect, making reviews invisible to your performance.",
      cta: "Want a free performance report showing exactly what Judge.me is costing you in seconds?"
    },
    okendo: {
      action: "so its heavy media galleries don't bloat your mobile page load",
      benefit: "Okendo's photo/video reviews are powerful but heavy. I implement smart caching and lazy loading that keeps pages fast.",
      cta: "Happy to run a quick diagnostic on your store and show you the impact."
    },
    growave: {
      action: "streamline its loyalty and wishlists so they load instantly on mobile",
      benefit: "Loyalty programs add real value, but they shouldn't make mobile shoppers wait. I optimize the code path so it's imperceptible.",
      cta: "Let me show you how fast your loyalty widget can be with a few targeted changes."
    },
    smile_io: {
      action: "with deferred loading so loyalty points don't block the first paint",
      benefit: "Smile.io scripts run on every page. I've built solutions that lazy-load them and cut their JavaScript payload in half.",
      cta: "I'd be glad to share my Smile.io optimization checklist — it's been used across 30+ stores."
    },
    stamped_io: {
      action: "so visual reviews load progressively without delaying your content",
      benefit: "Stamped.io can be heavy on rich snippets. I implement partial rendering so customers see reviews without waiting.",
      cta: "Want to see how much faster your product pages can get?"
    },
    // Checkout & BNPL
    snapmint: {
      action: "so buy-now-pay-later checkout stays fast and doesn't slow down conversion",
      benefit: "BNPL options boost average order value, but they add requests at checkout. I ensure your snapmint integration stays under 100ms of overhead.",
      cta: "I'd love to show you how to keep your AOV boost without trading off any speed."
    },
    affirm: {
      action: "load on demand so financing options don't delay the add-to-cart experience",
      benefit: "Affirm's calculators can slow down mobile checkout. I implement on-demand loading that only triggers when the customer needs it.",
      cta: "Let me know if you'd like to see how other merchants keep Affirm invisible until needed."
    },
    klarna: {
      action: "so payment options appear instantly and never block the checkout flow",
      benefit: "I've seen Klarna widgets delay critical requests. I refactor them to load asynchronously without affecting conversion.",
      cta: "Tell me your store name — I'll give you a free snapshot of your checkout speed."
    },
    afterpay: {
      action: "lazy-load so installment options don't add load time during peak traffic",
      benefit: "Afterpay adds network requests at checkout. I implement intelligent caching and deferred loading.",
      cta: "Would you be open to a 15-minute call where I show you exactly how to optimize your Afterpay setup?"
    },
    // Page Builders
    pagefly: {
      action: "so custom landing pages load just as fast as your default templates",
      benefit: "Page builders are notorious for bloated code. I audit and optimize PageFly pages to match native template performance.",
      cta: "I'd love to review one of your PageFly pages and give you a free optimization plan."
    },
    shogun: {
      action: "so its heavy page elements don't increase your time-to-interactive",
      benefit: "Shogun gives you power but can bloat JavaScript bundles. I implement split-loading so only what's needed ships.",
      cta: "Want a free report on how your Shogun pages compare to industry speed benchmarks?"
    },
    gempages: {
      action: "to minimize render-blocking resources on your campaign landing pages",
      benefit: "GEMpages is great for conversions but can add CSS/JS bloat. I prune and defer so campaigns load instantly.",
      cta: "Let me know if you want me to take a look at your campaign pages — free audit."
    },
    zipify: {
      action: "so your OTO/one-click-upsell funnels load instantly and convert faster",
      benefit: "Zipify Pages are built for speed but can accumulate bloat over time. I keep them lean and lightning-fast.",
      cta: "I'd be happy to benchmark your Zipify funnels against industry standards for free."
    },
    // Shipping
    shipstation: {
      action: "so order confirmations and tracking updates trigger fast without lag",
      benefit: "I ensure your shipping notifications arrive quickly and don't add friction to post-purchase experience.",
      cta: "Let's discuss how to keep your order flow seamless and fast."
    },
    // Analytics
    hotjar: {
      action: "with deferred execution so heatmaps and recordings don't slow down your storefront",
      benefit: "Analytics are essential but can be a performance tax. I implement lazy execution so your data still works without slowing visitors.",
      cta: "I can show you how to keep Hotjar fully functional while removing its impact on page speed."
    },
    microsoft_clarity: {
      action: "to run off the main thread so session recordings never block the user experience",
      benefit: "Clarity gives you insights without hurting performance when configured right. I set it up so it's truly invisible.",
      cta: "Want me to configure it optimally for you at no cost?"
    },
    // Helpdesk
    gorgias: {
      action: "so the chat widget loads instantly and its heavy snippets don't delay your page",
      benefit: "Gorgias is essential for support but adds significant code to every page. I implement selective loading so it stays invisible until needed.",
      cta: "Let me show you how to keep Gorgias powerful without the performance cost."
    },
    tidio: {
      action: "so live chat and chatbots load instantly even on slower networks",
      benefit: "Tidio's chat widget is heavy on mobile. I've helped stores cut its impact dramatically while keeping chat features working.",
      cta: "Want a free tip sheet on optimizing Tidio for Shopify?"
    },
    // Subscriptions
    recharge: {
      action: "so subscription management pages load fast and don't slow down repeat purchases",
      benefit: "Recharge adds significant overhead to manage-your-subscription flows. I optimize these pages so customers checkout faster on repeat orders.",
      cta: "Let me know if you'd like to see how other subscription stores keep their portal blazing fast."
    },
    // Upsell / Cross-sell
    vitals: {
      action: "so its many widgets (countdowns, badges, upsells) load lazily and don't combine into a slow payload",
      benefit: "Vitals bundles tons of features, but the combined payload can be huge. I implement per-widget loading so you only pay for what's on the page.",
      cta: "I'd be glad to audit how many Vitals widgets your store actually loads and how to trim them."
    },
    releasit: {
      action: "to minimize its order-form scripts and reduce mobile checkout friction",
      benefit: "Releasit One-Click Upsells are powerful but can slow down mobile checkout flows. I've built patterns that keep them fast.",
      cta: "Want to see how we cut checkout time for a store using Releasit?"
    },
    // SEO
    "seo-guru": {
      action: "so automated metadata generation doesn't slow down your store admin or storefront",
      benefit: "SEO apps can add real overhead in both the admin panel and on your storefront. I optimize them so your team stays productive.",
      cta: "Let me know if you'd like a free speed review of how SEO Guru is performing on your store."
    },
    // Localization
    langify: {
      action: "so country-specific content loads without extra redirects delaying visitors",
      benefit: "Geolocation and localization often add redirects that frustrate shoppers. I implement client-side geo-detection that's instant.",
      cta: "Want to see how to make your multi-country store feel instant to every visitor?"
    },
    intlified: {
      action: "so geo-targeting happens instantly without an extra HTTP round-trip",
      benefit: "I've built alternatives that detect location on the client, cutting load time by removing server redirects entirely.",
      cta: "Happy to show you the performance comparison — just let me know."
    }
  };

  const key = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const match = Object.entries(valueProps).find(([appKey]) =>
    appKey.toLowerCase().replace(/[^a-z0-9]/g, "") === key
  );
  return (match && match[1]) || {
    action: "so it runs efficiently and doesn't add unnecessary overhead to your store",
    benefit: "I specialize in optimizing these apps so merchants get full functionality without the performance cost.",
    cta: "I'd love to run a free, no-obligation audit of your store and show you exactly what can be improved."
  };
};

/**
 * Build personalized message for email
 */
const generateEmail = (lead) => {
  const profile = candidateProfile();
  const storeName = lead.store_name || "your store";
  const domain = lead.domain || "";

  // Find the best installed app to personalize around
  const apps = Array.isArray(lead.installed_apps) ? lead.installed_apps : [];
  const techStack = Array.isArray(lead.tech_stack) ? lead.tech_stack : [];

  // Prioritize high-value, recognizable apps for personalization
  const highPriority = ["klaviyo", "yotpo", "recharge", "releasit", "pagefly", "shogun", "gempages", "snapmint", "postscript", "attentive", "privy", "smile", "okendo", "judge", "growave", "zipify", "gorgias", "hotjar", "hotjar", "langify", "intlified", "affirm", "klarna", "afterpay"];

  let primaryApp = null;
  for (const app of apps) {
    const appLower = String(app).toLowerCase();
    if (highPriority.some((hp) => appLower.includes(hp))) {
      primaryApp = app;
      break;
    }
  }

  // Fallback: first app or first tech stack item
  if (!primaryApp && apps.length > 0) {
    primaryApp = apps[0];
  } else if (!primaryApp && techStack.length > 0) {
    primaryApp = techStack[0];
  }

  let subject;
  let body;

  if (primaryApp) {
    const category = detectAppCategory(primaryApp);
    const valueProp = getAppValueProp(primaryApp, category.category);

    const appDisplayName = primaryApp; // Keep the exact app name as merchant knows it

    subject = `Quick question about ${appDisplayName} on ${storeName}`;

    body = renderTemplate(`Hi {{ first_name }},

I noticed you're using {{ app_name }} on {{ store_name }}{{ domain_phrase }}. I help Shopify merchants review app integrations and identify opportunities to improve storefront performance without losing useful functionality.

I can review whether {{ app_name }} is configured efficiently and suggest a practical improvement:

- {{ action }}

Would you be open to a brief conversation? I can share what I find first, with no obligation. If you prefer no follow-up, just let me know.

Best regards,
{{ sender_name }}
{{ sender_role }} | {{ sender_experience }} of Shopify experience
Email: {{ sender_email }}{{ sender_phone_line }}
{{ portfolio_line }}`, {
      first_name: lead.contact_name ? lead.contact_name.split(" ")[0] : "",
      app_name: appDisplayName,
      store_name: storeName,
      domain_phrase: domain ? ` (${domain})` : "",
      action: valueProp.action,
      sender_name: profile.name,
      sender_role: profile.role,
      sender_experience: profile.experience,
      sender_email: profile.email,
      sender_phone_line: profile.phone ? ` | Phone: ${profile.phone}` : "",
      portfolio_line: profile.portfolio ? `Portfolio: ${profile.portfolio}` : ""
    }).replace(/^Hi ,\n/, "Hi there,\n");
  } else {
    // Fallback: tech stack personalization
    const techStr = techStack.length > 0 ? techStack.slice(0, 2).join(", ") : "Shopify";

    subject = `Making ${storeName} faster and more profitable`;

    body = `Hi ${lead.contact_name ? lead.contact_name.split(" ")[0] : "there"},

I came across ${storeName} and noticed your Shopify setup includes ${techStr}. I'm ${profile.name}, and I help merchants review integrations and identify practical improvements to their storefront.

Would you be open to a brief conversation about areas worth reviewing? I can share a few suggestions tailored to your setup, with no obligation. If you prefer no follow-up, just let me know.

Best,
${profile.name}
${profile.role} | ${profile.experience}
Email: ${profile.email}${profile.phone ? ` | Phone: ${profile.phone}` : ""}
${profile.portfolio ? `Portfolio: ${profile.portfolio}` : ""}`;
  }

  return {
    to: lead.contact_email,
    from: profile.email,
    subject,
    body,
    html: buildHtmlEmail(body, subject, lead, profile),
    leadId: lead.id,
    storeName,
    domain,
    primaryApp
  };
};

/**
 * Build HTML version of the email
 */
const buildHtmlEmail = (text, subject, lead, profile) => {
  const appName = lead.primary_app || (lead.installed_apps && lead.installed_apps.length ? lead.installed_apps[0] : "your apps");

  const safe = (str) => String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b; line-height: 1.6;">
      <tr>
        <td align="center" style="padding: 40px 20px;">
          <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.08);">
            <tr>
              <td style="background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); padding: 32px 40px;">
                <h1 style="margin: 0; font-size: 22px; font-weight: 600; color: #ffffff;">${safe(subject)}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding: 40px;">
                <div style="background: #f8fafc; border-left: 4px solid #2563eb; padding: 18px 24px; margin: 24px 0; border-radius: 0 8px 8px 0;">
                  <p style="margin: 0; font-size: 14px; color: #334155;">
                    <strong style="color: #1e40af;">Personalized for ${safe(lead.store_name || "your store")}:</strong> ${safe(appName ? `I noticed your store uses ${appName}; I can help review its configuration and identify performance improvements.` : "I can help review your storefront and identify practical performance improvements.")}
                  </p>
                </div>
                <div>
                  ${safe(text)
                    .replace(/\n\n/g, "</p><p>")
                    .replace(/\n/g, "<br>")}
                </div>
              </td>
            </tr>
            <tr>
              <td style="background: #f1f5f9; padding: 24px 40px; border-top: 1px solid #e2e8f0;">
                <p style="margin: 0; font-size: 13px; color: #64748b;">
                  ${safe(profile.name)} · ${safe(profile.role)} · ${safe(profile.experience)}
                </p>
                <p style="margin: 6px 0 0 0; font-size: 13px; color: #64748b;">
                  ${safe(profile.email)}${safe(profile.phone) ? ` · ${safe(profile.phone)}` : ""}
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  `.trim();
};

/**
 * Build personalized message for WhatsApp
 */
const generateWhatsApp = (lead) => {
  const profile = candidateProfile();
  const storeName = lead.store_name || "your store";
  const appName = lead.primary_app || (lead.installed_apps && lead.installed_apps.length ? lead.installed_apps[0] : null);

  let text;
  const hasApp = appName && appName.length;

  if (hasApp) {
    const category = detectAppCategory(appName);
    const valueProp = getAppValueProp(appName, category.category);

    text = `Hey${lead.contact_name ? ` ${lead.contact_name.split(" ")[0]}` : "there"} 👋

I noticed you're using ${appName} on ${storeName}. I help Shopify merchants review app integrations and find ways to improve storefront performance while keeping useful functionality.

For ${appName}, I would look at how to ${valueProp.action}.

Would you be open to a brief conversation? I can share a few practical ideas, with no obligation. Reply STOP if you'd prefer no further WhatsApp messages.

${profile.name}
${profile.role}`;
  } else {
    text = `Hey${lead.contact_name ? ` ${lead.contact_name.split(" ")[0]}` : "there"} 👋

Quick question — I was looking at ${storeName} and noticed a few quick wins that could boost your speed & conversions.

I'm a Shopify expert and I do free store audits (no pitch, just honest feedback).

Worth a 15-min chat this week?

- ${profile.name}
${profile.role}`;
  }

  return {
    to: lead.contact_phone,
    text,
    leadId: lead.id,
    storeName,
    domain: lead.domain
  };
};

/**
 * Generate a preview of the personalized message for a lead
 */
const previewMessage = (lead, channel) => {
  if (channel === "email") {
    return generateEmail(lead);
  } else if (channel === "whatsapp") {
    return generateWhatsApp(lead);
  }
  return null;
};

/**
 * Get the app list for display/reporting
 */
const getPersonalizationDetails = (lead) => {
  const apps = Array.isArray(lead.installed_apps) ? lead.installed_apps : [];
  const techStack = Array.isArray(lead.tech_stack) ? lead.tech_stack : [];

  return {
    storeName: lead.store_name,
    domain: lead.domain,
    installedApps: apps,
    techStack: techStack,
    primaryApp: lead.primary_app || (apps.length ? apps[0] : null),
    hasEmail: Boolean(lead.contact_email),
    hasPhone: Boolean(lead.contact_phone)
  };
};

module.exports = {
  generateEmail,
  generateWhatsApp,
  previewMessage,
  getPersonalizationDetails,
  detectAppCategory,
  getAppValueProp,
  candidateProfile,
  renderTemplate
};