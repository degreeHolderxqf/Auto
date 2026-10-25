const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");

const isVercelRuntime = process.env.VERCEL === "1" || process.env.VERCEL === "true" || Boolean(process.env.VERCEL_ENV);

// Do not load a local .env on Vercel. Local env files must never override the production runtime.
if (!isVercelRuntime) {
  const envPath = path.resolve(__dirname, "..", ".env");
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  } else {
    dotenv.config();
  }
}

const rootDir = path.resolve(__dirname, "..");
const runtimeMode = isVercelRuntime ? "PRODUCTION" : "LOCAL";

function getRateSetting(name, fallback) {
  const parsed = Number.parseFloat(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 1 ? parsed : fallback;
}

const dataDir = isVercelRuntime
  ? (process.env.DATA_DIR || "/tmp/data")
  : (process.env.DATA_DIR || path.join(rootDir, "data"));
const logsDir = isVercelRuntime
  ? (process.env.LOGS_DIR || "/tmp/logs")
  : (process.env.LOGS_DIR || path.join(rootDir, "logs"));
const outputDir = isVercelRuntime
  ? (process.env.OUTPUT_DIR || "/tmp/output")
  : (process.env.OUTPUT_DIR || path.join(rootDir, "output"));
const databasePath = isVercelRuntime
  ? (process.env.DATABASE_PATH || "/tmp/data/leads.sqlite")
  : (process.env.DATABASE_PATH || path.join(rootDir, "data", "leads.sqlite"));
const exclusionsPath = isVercelRuntime
  ? (process.env.EXCLUSIONS_PATH || "/tmp/data/excluded_companies.csv")
  : (process.env.EXCLUSIONS_PATH || path.join(rootDir, "data", "excluded_companies.csv"));
const resumePath = process.env.RESUME_PATH || path.join(rootDir, "26_Himanshu-Soni-Shopify.pdf");

const config = {
  // Application
  env: process.env.NODE_ENV || "development",
  runtimeMode,
  rootDir,
  dataDir,
  logsDir,
  outputDir,

  // Database & Exclusions
  databasePath,
  exclusionsPath,
  resumePath,
  resumeFallbackPath: resumePath,

  // Lead Discovery & Targeting
  shopifyDirectoryUrl: process.env.SHOPIFY_PARTNER_DIRECTORY_URL || "https://www.shopify.com/in/partners/directory/locations/india?minPrice=&maxPrice=&sort=AVERAGE_RATING",
  targetCountry: process.env.TARGET_COUNTRY || "India",
  targetLeads: parseInt(process.env.TARGET_LEADS || "100", 10),
  minAppRelevanceScore: parseInt(process.env.MIN_APP_RELEVANCE_SCORE || "70", 10),

  // Employee Size Verification Settings (Optional via .env)
  // Set MIN_EMPLOYEE_COUNT=30 for 30+ employees, or set 0 / false / disabled to make it optional
  minEmployeeCount: (() => {
    const raw = process.env.MIN_EMPLOYEE_COUNT !== undefined ? process.env.MIN_EMPLOYEE_COUNT : process.env.MIN_EMPLOYEES;
    if (raw === undefined || raw === null || raw === "") return null; // default off unless explicitly enabled
    const str = String(raw).trim().toLowerCase();
    if (str === "false" || str === "null" || str === "0" || str === "none" || str === "disabled" || str === "off") return null;
    const parsed = parseInt(str, 10);
    return isNaN(parsed) || parsed <= 0 ? null : parsed;
  })(),

  // Search Provider
  searchProvider: process.env.SEARCH_PROVIDER || "brave", // direct, brave, serpapi, google, bing
  searchApiKey: process.env.SEARCH_API_KEY || "",

  // Email & Sending
  smtp: {
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    secure: process.env.SMTP_SECURE === "true",
    user: process.env.SMTP_USER || "himanshusoni7899@gmail.com",
    pass: process.env.SMTP_PASS || "",
    from: process.env.EMAIL_FROM || "Himanshu Soni <himanshusoni7899@gmail.com>"
  },

  // Safety & Rate Limiting
  dryRun: process.env.DRY_RUN !== "false" && process.env.DRY_RUN !== "0", // default true for safety
  sendLimit: process.env.SEND_LIMIT ? parseInt(process.env.SEND_LIMIT, 10) : null,
  emailDelayMs: parseInt(process.env.EMAIL_DELAY_MS || "5000", 10),
  batchSize: parseInt(process.env.BATCH_SIZE || "10", 10),
  batchDelayMs: parseInt(process.env.BATCH_DELAY_MS || "60000", 10),
  maxRetries: parseInt(process.env.MAX_RETRIES || "2", 10),
  retryDelayMs: parseInt(process.env.RETRY_DELAY_MS || "5000", 10),

  // Evolution API WhatsApp Integration
  evolution: {
    apiUrl: (process.env.EVOLUTION_API_URL || "https://evolution-api-latest-h0yy.onrender.com").replace(/\/+$/, ""),
    apiKey: process.env.EVOLUTION_API_KEY || "",
    instanceName: process.env.EVOLUTION_INSTANCE_NAME || "job-search",
    enabled: process.env.WHATSAPP_ENABLED !== "false" && process.env.WHATSAPP_ENABLED !== "0",
    dryRun: process.env.WHATSAPP_DRY_RUN !== "false" && process.env.WHATSAPP_DRY_RUN !== "0",
    delayMs: parseInt(process.env.WHATSAPP_DELAY_MS || "15000", 10)
  },

  // Web Crawling timeouts
  httpTimeoutMs: parseInt(process.env.HTTP_TIMEOUT_MS || "12000", 10),

  // Revenue estimation is free/public-data-only by default. Set mode=paid explicitly
  // before enabling an external traffic provider that may bill per request.
  revenueEstimationMode: String(process.env.REVENUE_ESTIMATION_MODE || "free").trim().toLowerCase(),
  trafficProvider: String(process.env.TRAFFIC_PROVIDER || "").trim().toLowerCase(),
  dataForSeoLogin: process.env.DATAFORSEO_LOGIN || "",
  dataForSeoPassword: process.env.DATAFORSEO_PASSWORD || "",
  revenueBaseConversionRate: getRateSetting("REVENUE_BASE_CONVERSION_RATE", 0.015),
  revenueLowConversionRate: getRateSetting("REVENUE_LOW_CONVERSION_RATE", 0.005),
  revenueHighConversionRate: getRateSetting("REVENUE_HIGH_CONVERSION_RATE", 0.03),
  revenueEstimateRefreshDays: Math.max(1, Math.min(parseInt(process.env.REVENUE_ESTIMATE_REFRESH_DAYS || "30", 10), 365)),
  revenueFailureRetryHours: Math.max(1, Math.min(parseInt(process.env.REVENUE_FAILURE_RETRY_HOURS || "24", 10), 168)),

  // Remote Job Discovery Settings (Additive Only)
  // autoApplyDefault MUST default to OFF (human-in-the-loop for every submission)
  remoteJobDiscoveryEnabled: process.env.REMOTE_JOB_DISCOVERY_ENABLED !== "false",
  minRemoteJobRelevanceScore: parseInt(process.env.MIN_REMOTE_JOB_RELEVANCE_SCORE || "60", 10),
  maxRemoteJobsPerSource: parseInt(process.env.MAX_REMOTE_JOBS_PER_SOURCE || "100", 10),
  autoApplyDefault: process.env.AUTO_APPLY_DEFAULT === "true"
};

// Ensure required runtime directories exist without crashing in serverless mode.
[config.dataDir, config.logsDir, config.outputDir].forEach((dir) => {
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch (error) {
    console.warn(`[CONFIG] Unable to create directory ${dir}:`, error.message);
  }
});

module.exports = config;
