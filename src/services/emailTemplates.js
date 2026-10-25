const fs = require("node:fs/promises");
const path = require("node:path");

const TEMPLATE_FILE = path.resolve(__dirname, "../../templates/email-templates.json");
const ACTIVE_TEMPLATE_FILE = path.resolve(__dirname, "../../templates/active-email-template.json");
const PORTFOLIO_URL = "https://himanshusoni-lilac.vercel.app/";
const DEFAULT_ACTIVE_TEMPLATE_ID = "freelancingStores";

const TEMPLATE_DEFINITIONS = Object.freeze({
  freelancingStores: Object.freeze({
    id: "freelancingStores",
    target: "Freelancing Stores",
    audience: "Store Owners",
    variable: "store_name"
  }),
  appDevelopers: Object.freeze({
    id: "appDevelopers",
    target: "App Developers",
    audience: "Shopify App Developers / SaaS",
    variable: "app_name"
  }),
  agencies: Object.freeze({
    id: "agencies",
    target: "Agencies",
    audience: "Shopify Partner Agencies",
    variable: "agency_name"
  })
});

const DEFAULT_CONTENT = Object.freeze({
  freelancingStores: Object.freeze({
    subject: "A lighter custom feature for {{store_name}}",
    body: `Hi there,\n\nI came across {{store_name}} and wanted to reach out. If your team is paying for third-party apps to cover store features that could live directly in the theme, I can help replace the slow or expensive pieces with clean, maintainable custom Liquid functionality.\n\nI am a full-stack developer focused on Shopify, custom Liquid, React, Remix, GraphQL, Node.js, and Shopify Admin APIs. I have delivered 50+ custom Shopify stores and focus on improving the storefront without adding unnecessary app overhead.\n\nIf you have one feature in mind, send it over and I can suggest whether a custom build would be a good fit. You can see examples of my work here: ${PORTFOLIO_URL}\n\nWould a short conversation next week be useful?\n\nBest,\nHimanshu\nShopify Full-Stack Developer`
  }),
  appDevelopers: Object.freeze({
    subject: "Extra Shopify app development capacity for {{app_name}}",
    body: `Hi {{app_name}} team,\n\nI am a Shopify-focused full-stack developer and can help clear development backlogs across Remix, React, GraphQL, Shopify Admin APIs, and Admin UI extensions.\n\nI have delivered 50+ custom Shopify stores and am comfortable joining an existing codebase, following its conventions, and taking a scoped item through implementation and review.\n\nIf there is a queued feature, extension, or integration that needs extra capacity, I would be glad to compare notes and see where I can help.\n\nBest,\nHimanshu\nFull-Stack Shopify Developer`
  }),
  agencies: Object.freeze({
    subject: "White-label Shopify development support for {{agency_name}}",
    body: `Hello {{agency_name}} team,\n\nI provide reliable white-label Shopify development support for agencies when client timelines exceed in-house capacity. I strictly adhere to your Figma-to-Liquid specifications, including layout, responsive behavior, design details, and interactions, and I raise questions early to avoid rework.\n\nMy work includes custom Liquid sections, Shopify theme builds, React, Remix, GraphQL, Node.js, and Shopify Admin APIs. I have delivered 50+ custom Shopify stores and can take on clearly scoped overflow work while keeping communication and delivery aligned with your agency.\n\nIf you have upcoming overflow work, I would be happy to discuss how I can support your team.\n\nBest regards,\nHimanshu\nWhite-Label Shopify Development`
  })
});

class TemplateValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "TemplateValidationError";
    this.statusCode = 400;
  }
}

class TemplateConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "TemplateConfigError";
    this.statusCode = 500;
  }
}

function validateContent(templateId, subject, body) {
  const definition = TEMPLATE_DEFINITIONS[templateId];
  if (!definition) throw new TemplateValidationError("Unknown email template target.");
  if (typeof subject !== "string" || !subject.trim()) {
    throw new TemplateValidationError("Subject is required.");
  }
  if (subject.trim().length > 200) {
    throw new TemplateValidationError("Subject must be 200 characters or fewer.");
  }
  if (typeof body !== "string" || !body.trim()) {
    throw new TemplateValidationError("Email body is required.");
  }
  if (body.length > 10000) {
    throw new TemplateValidationError("Email body must be 10,000 characters or fewer.");
  }

  const placeholders = `${subject}\n${body}`.match(/{{\s*[a-zA-Z_][a-zA-Z0-9_]*\s*}}/g) || [];
  const allowedPlaceholder = `{{${definition.variable}}}`;
  if (placeholders.some((placeholder) => placeholder.replace(/\s/g, "") !== allowedPlaceholder)) {
    throw new TemplateValidationError(`This template only supports the {{${definition.variable}}} variable.`);
  }
  if (!body.includes(allowedPlaceholder)) {
    throw new TemplateValidationError(`Email body must include {{${definition.variable}}}.`);
  }
  if (templateId === "freelancingStores" && !body.includes(PORTFOLIO_URL)) {
    throw new TemplateValidationError(`The Freelancing Stores template must include ${PORTFOLIO_URL}`);
  }

  return { subject: subject.trim(), body: body.trim() };
}

async function writeConfig(config) {
  await fs.mkdir(path.dirname(TEMPLATE_FILE), { recursive: true });
  const tempPath = `${TEMPLATE_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, TEMPLATE_FILE);
}

async function ensureConfigFile() {
  await fs.mkdir(path.dirname(TEMPLATE_FILE), { recursive: true });
  try {
    await fs.access(TEMPLATE_FILE);
  } catch {
    await writeConfig(DEFAULT_CONTENT);
  }
}

async function readConfig() {
  await ensureConfigFile();
  let config;
  try {
    config = JSON.parse(await fs.readFile(TEMPLATE_FILE, "utf8"));
  } catch (error) {
    throw new TemplateConfigError(`Could not read email template configuration: ${error.message}`);
  }

  const expectedIds = Object.keys(TEMPLATE_DEFINITIONS).sort();
  const actualIds = config && typeof config === "object" && !Array.isArray(config)
    ? Object.keys(config).sort()
    : [];
  if (actualIds.length !== expectedIds.length || actualIds.some((id, index) => id !== expectedIds[index])) {
    throw new TemplateConfigError("Template configuration must contain exactly the three supported template targets.");
  }

  for (const id of expectedIds) {
    try {
      validateContent(id, config[id]?.subject, config[id]?.body);
    } catch (error) {
      throw new TemplateConfigError(`Invalid ${TEMPLATE_DEFINITIONS[id].target} template: ${error.message}`);
    }
  }
  return config;
}

async function getTemplates() {
  const config = await readConfig();
  return Object.values(TEMPLATE_DEFINITIONS).map((definition) => ({
    ...definition,
    ...config[definition.id]
  }));
}

async function getActiveTemplateId() {
  try {
    const parsed = JSON.parse(await fs.readFile(ACTIVE_TEMPLATE_FILE, "utf8"));
    if (!parsed || !TEMPLATE_DEFINITIONS[parsed.templateId]) {
      throw new TemplateConfigError("Active email template selection is invalid.");
    }
    return parsed.templateId;
  } catch (error) {
    if (error.code !== "ENOENT") {
      if (error instanceof TemplateConfigError) throw error;
      throw new TemplateConfigError(`Could not read active email template selection: ${error.message}`);
    }
    await writeActiveTemplateId(DEFAULT_ACTIVE_TEMPLATE_ID);
    return DEFAULT_ACTIVE_TEMPLATE_ID;
  }
}

async function writeActiveTemplateId(templateId) {
  await fs.mkdir(path.dirname(ACTIVE_TEMPLATE_FILE), { recursive: true });
  const tempPath = `${ACTIVE_TEMPLATE_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify({ templateId }, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, ACTIVE_TEMPLATE_FILE);
}

async function setActiveTemplateId(templateId) {
  if (!TEMPLATE_DEFINITIONS[templateId]) {
    throw new TemplateValidationError("Unknown email template target.");
  }
  await writeActiveTemplateId(templateId);
  return templateId;
}

let updateQueue = Promise.resolve();

function updateTemplate(templateId, subject, body) {
  const operation = updateQueue.then(async () => {
    if (!TEMPLATE_DEFINITIONS[templateId]) throw new TemplateValidationError("Unknown email template target.");
    const validated = validateContent(templateId, subject, body);
    const config = await readConfig();
    config[templateId] = validated;
    await writeConfig(config);
    const definition = TEMPLATE_DEFINITIONS[templateId];
    return { ...definition, ...validated };
  });
  updateQueue = operation.catch(() => {});
  return operation;
}

async function renderTemplate(templateId, variables = {}) {
  const definition = TEMPLATE_DEFINITIONS[templateId];
  if (!definition) throw new TemplateValidationError("Unknown email template target.");
  const template = (await getTemplates()).find((item) => item.id === templateId);
  const value = variables[definition.variable];
  if (typeof value !== "string" || !value.trim()) {
    throw new TemplateValidationError(`A value for {{${definition.variable}}} is required.`);
  }
  if (value.length > 200) throw new TemplateValidationError("Template variable values must be 200 characters or fewer.");

  const variablePattern = new RegExp(`{{\\s*${definition.variable}\\s*}}`, "g");
  const replaceVariable = (text) => text.replace(variablePattern, value.trim());
  return {
    id: template.id,
    target: template.target,
    subject: replaceVariable(template.subject),
    body: replaceVariable(template.body)
  };
}

module.exports = {
  PORTFOLIO_URL,
  TEMPLATE_DEFINITIONS,
  TemplateValidationError,
  TemplateConfigError,
  getTemplates,
  getActiveTemplateId,
  setActiveTemplateId,
  updateTemplate,
  renderTemplate
};
