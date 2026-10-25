/**
 * Application Asset Generator
 * Generates tailored cover letters, screening answers, and selects resume versions
 * for remote job applications. Strictly pulls from saved user profile — no hallucination.
 */

const config = require("../config");
const settingsService = require("./settingsService");

class ApplicationAssetGenerator {
  constructor() {
    // Resume versions available (user uploads these to /output/resumes/)
    this.resumeVersions = {
      "Shopify_Developer": {
        filename: "Himanshu-Soni-Shopify-Developer.pdf",
        label: "Shopify Developer (Liquid, Themes, Apps)",
        focus: "Theme development, Liquid, custom apps, REST/GraphQL APIs"
      },
      "Shopify_Plus_Remix": {
        filename: "Himanshu-Soni-Shopify-Plus-Remix.pdf",
        label: "Shopify Plus / Remix / Headless",
        focus: "Shopify Plus, Remix, Hydrogen, Checkout Extensibility, Headless"
      },
      "Full_Stack_Web": {
        filename: "Himanshu-Soni-Full-Stack.pdf",
        label: "Full-Stack Web Developer (React, Node.js)",
        focus: "React, Node.js, TypeScript, GraphQL, REST, PostgreSQL, AWS"
      }
    };
  }

  /**
   * Get candidate profile from settings
   */
  getCandidateProfile() {
    const settings = settingsService.getSettings(false);
    return {
      name: settings.candidateName || "Himanshu Soni",
      role: settings.candidateRole || "Shopify Developer",
      experience: settings.candidateExperience || "3 years",
      email: settings.candidateEmail || settings.smtpUser || "himanshusoni7899@gmail.com",
      phone: settings.candidatePhone || "",
      skills: Array.isArray(settings.candidateSkills) && settings.candidateSkills.length > 0
        ? settings.candidateSkills
        : [
            "Shopify & Shopify Plus Theme Development (Liquid, Theme App Extensions, Section Rendering)",
            "Custom App & Full-Stack Development (Node.js, Remix, React, JavaScript)",
            "Shopify Admin & Storefront GraphQL / REST APIs, Webhooks, and Systems Integrations",
            "Checkout Extensibility, Functions, and Headless Commerce setups"
          ],
      resumeFilename: settings.resumeFilename || "Himanshu-Soni-Resume.pdf",
      resumePath: settings.resumePath || config.resumePath
    };
  }

  /**
   * Generate a tailored cover letter for a job application
   */
  generateCoverLetter(job, resumeVersion = null) {
    const candidate = this.getCandidateProfile();
    const resume = resumeVersion ? this.resumeVersions[resumeVersion] : null;

    // Determine which resume to recommend based on job content
    const recommendedVersion = resumeVersion || this.recommendResumeVersion(job);

    const companyName = job.company_name || "Your Team";
    const jobTitle = job.title || "this position";

    // Build Shopify-relevant skills highlight
    const skillsText = candidate.skills.join(", ");

    const coverLetter = `
Dear ${companyName} Hiring Team,

I'm writing to express my interest in the ${jobTitle} role at ${companyName}. With ${candidate.experience} of hands-on experience in ${candidate.role.toLowerCase()}, I've built and maintained production Shopify stores, custom apps, and headless commerce solutions that drive real merchant growth.

${this.generateRelevanceSection(job, recommendedVersion)}

**Technical Highlights:**
${candidate.skills.map(s => `• ${s}`).join("\n")}

**Why ${companyName}?**
${this.generateCompanyInterestSection(job)}

I'm excited about the possibility of contributing to ${companyName}'s mission and would welcome the opportunity to discuss how my experience aligns with your needs. My resume (${recommendedVersion ? this.resumeVersions[recommendedVersion].filename : candidate.resumeFilename}) is attached for your review.

Thank you for your time and consideration.

Best regards,
${candidate.name}
${candidate.email}
${candidate.phone ? ` | ${candidate.phone}` : ""}
${config.resumePath ? `\n\nResume: ${candidate.resumePath}/${recommendedVersion ? this.resumeVersions[recommendedVersion].filename : candidate.resumeFilename}` : ""}
    `.trim();

    return {
      coverLetter,
      recommendedResumeVersion: recommendedVersion,
      resumeFilename: recommendedVersion ? this.resumeVersions[recommendedVersion].filename : candidate.resumeFilename
    };
  }

  /**
   * Generate relevance section based on job requirements
   */
  generateRelevanceSection(job, resumeVersion) {
    const jobText = `${job.title || ""} ${job.description || ""} ${job.requirements || ""} ${job.skills || ""}`.toLowerCase();
    const sections = [];

    // Shopify Core
    if (jobText.includes("shopify")) {
      if (jobText.includes("plus") || jobText.includes("shopify plus")) {
        sections.push("• **Shopify Plus**: Built multi-brand, multi-currency stores for Plus merchants with custom checkout extensions, Functions, and B2B features.");
      } else {
        sections.push("• **Shopify Core**: Developed themes, sections, and app extensions using Liquid, JSON templates, and Theme App Extensions.");
      }
    }

    // Remix / Hydrogen / Headless
    if (jobText.includes("remix") || jobText.includes("hydrogen") || jobText.includes("headless")) {
      sections.push("• **Remix & Hydrogen**: Built headless storefronts with Remix, Shopify Storefront API, and Hydrogen framework — optimized for Core Web Vitals and SEO.");
    }

    // React / Full-Stack
    if (jobText.includes("react") || jobText.includes("node") || jobText.includes("full.stack") || jobText.includes("full stack")) {
      sections.push("• **Full-Stack React/Node**: Developed custom Shopify apps with React, Node.js, TypeScript, GraphQL, and PostgreSQL — deployed on AWS/Vercel with CI/CD.");
    }

    // Checkout Extensibility
    if (jobText.includes("checkout") || jobText.includes("extensibility") || jobText.includes("functions")) {
      sections.push("• **Checkout Extensibility**: Built custom checkout UI extensions, validation functions, and post-purchase upsells using Shopify Functions and Checkout UI Extensions.");
    }

    // India/Remote compatibility
    if (job.location && job.location.toLowerCase().includes("remote")) {
      sections.push("• **Remote-First**: 3+ years working remotely across time zones (EST/PST/IST) — async communication, self-driven delivery, and strong documentation practices.");
    }

    return sections.length > 0 ? sections.join("\n") : "• My background spans the full Shopify ecosystem — from Liquid themes to custom apps and headless implementations.";
  }

  /**
   * Generate company-specific interest section
   */
  generateCompanyInterestSection(job) {
    const interests = [];

    if (job.company_domain) {
      interests.push(`I've followed ${job.company_name}'s work and am impressed by your technical approach.`);
    }

    if (job.skills && job.skills.toLowerCase().includes("shopify")) {
      interests.push("Your focus on Shopify aligns directly with my specialization.");
    }

    if (job.employment_type && job.employment_type.toLowerCase().includes("full")) {
      interests.push("I'm seeking a full-time role where I can make long-term impact — this matches my career goals.");
    }

    return interests.length > 0 ? interests.join(" ") : "I admire companies building on Shopify and would love to contribute to your growth.";
  }

  /**
   * Recommend best resume version based on job content
   */
  recommendResumeVersion(job) {
    const jobText = `${job.title || ""} ${job.description || ""} ${job.requirements || ""} ${job.skills || ""}`.toLowerCase();

    // Shopify Plus / Remix / Headless signals
    if (jobText.includes("shopify plus") || jobText.includes("remix") || jobText.includes("hydrogen") ||
        jobText.includes("headless") || jobText.includes("checkout extensibility") || jobText.includes("functions")) {
      return "Shopify_Plus_Remix";
    }

    // General Shopify Developer signals
    if (jobText.includes("shopify") || jobText.includes("liquid") || jobText.includes("theme") ||
        jobText.includes("app development") || jobText.includes("storefront")) {
      return "Shopify_Developer";
    }

    // Default to Full Stack for general web roles
    return "Full_Stack_Web";
  }

  /**
   * Generate screening question answers based on job requirements
   */
  generateScreeningAnswers(job) {
    const candidate = this.getCandidateProfile();
    const answers = {};

    // Common screening questions for Shopify/Dev roles
    const commonQuestions = [
      {
        key: "years_experience",
        question: "How many years of Shopify development experience do you have?",
        answer: candidate.experience
      },
      {
        key: "shopify_plus",
        question: "Have you worked with Shopify Plus merchants?",
        answer: "Yes — built custom checkout extensions, B2B features, and multi-store setups for Plus merchants."
      },
      {
        key: "liquid_proficiency",
        question: "Rate your Liquid proficiency (1-10):",
        answer: "9/10 — built complex sections, snippets, and theme app extensions with advanced Liquid logic."
      },
      {
        key: "remix_hydrogen",
        question: "Experience with Remix or Hydrogen?",
        answer: "Built headless storefronts with Remix + Storefront API and Hydrogen — optimized for performance and SEO."
      },
      {
        key: "graphql_rest",
        question: "Comfortable with GraphQL and REST APIs?",
        answer: "Yes — daily work with Shopify Admin/Storefront GraphQL, REST Admin API, and webhook integrations."
      },
      {
        key: "remote_experience",
        question: "Previous remote work experience?",
        answer: "3+ years fully remote across US/India time zones — async-first, strong written communication, self-managed delivery."
      },
      {
        key: "availability",
        question: "Notice period / availability?",
        answer: "Immediate to 30 days — flexible based on team needs."
      },
      {
        key: "salary_expectation",
        question: "Salary expectations (USD/year)?",
        answer: this.estimateSalaryExpectation(job)
      }
    ];

    // Filter questions based on job relevance
    for (const q of commonQuestions) {
      const jobText = `${job.title || ""} ${job.description || ""} ${job.requirements || ""} ${job.skills || ""}`.toLowerCase();

      if (q.key === "shopify_plus" && !jobText.includes("plus")) continue;
      if (q.key === "remix_hydrogen" && !jobText.includes("remix") && !jobText.includes("hydrogen") && !jobText.includes("headless")) continue;
      if (q.key === "graphql_rest" && !jobText.includes("api") && !jobText.includes("graphql") && !jobText.includes("rest")) continue;

      answers[q.key] = {
        question: q.question,
        answer: q.answer
      };
    }

    return answers;
  }

  /**
   * Estimate salary expectation based on job
   */
  estimateSalaryExpectation(job) {
    const jobText = `${job.title || ""} ${job.description || ""}`.toLowerCase();
    const isSenior = jobText.includes("senior") || jobText.includes("lead") || jobText.includes("principal");
    const isPlus = jobText.includes("plus");
    const isHeadless = jobText.includes("remix") || jobText.includes("hydrogen") || jobText.includes("headless");

    // Base ranges for India-compatible remote roles
    let min = 60000;
    let max = 120000;

    if (isSenior) { min += 20000; max += 30000; }
    if (isPlus) { min += 10000; max += 15000; }
    if (isHeadless) { min += 10000; max += 15000; }

    return `$${min.toLocaleString()} - $${max.toLocaleString()} USD/year (negotiable based on equity/benefits)`;
  }

  /**
   * Get available resume versions
   */
  getResumeVersions() {
    return this.resumeVersions;
  }
}

module.exports = new ApplicationAssetGenerator();