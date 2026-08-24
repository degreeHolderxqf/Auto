const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");

// Load .env if present
const envPath = path.resolve(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

const rootDir = path.resolve(__dirname, "..");

const config = {
  // Application
  env: process.env.NODE_ENV || "development",
  rootDir,
  dataDir: path.resolve(rootDir, "data"),
  logsDir: path.resolve(rootDir, process.env.LOGS_DIR || "logs"),
  outputDir: path.resolve(rootDir, process.env.OUTPUT_DIR || "output"),

  // Database & Exclusions
  databasePath: path.resolve(rootDir, process.env.DATABASE_PATH || "data/leads.sqlite"),
  exclusionsPath: path.resolve(rootDir, process.env.EXCLUSIONS_PATH || "data/excluded_companies.csv"),
  resumePath: path.resolve(rootDir, process.env.RESUME_PATH || "../../26_Himanshu-Soni-Shopify.pdf"),

  // Shopify Discovery
  shopifyDirectoryUrl: process.env.SHOPIFY_PARTNER_DIRECTORY_URL || "https://www.shopify.com/in/partners/directory/locations/india?minPrice=&maxPrice=&sort=AVERAGE_RATING",
  targetCountry: process.env.TARGET_COUNTRY || "India",
  targetLeads: parseInt(process.env.TARGET_LEADS || "100", 10),
  minAppRelevanceScore: parseInt(process.env.MIN_APP_RELEVANCE_SCORE || "70", 10),

  // Search Provider
  searchProvider: process.env.SEARCH_PROVIDER || "direct", // direct, duckduckgo, serpapi, google, bing
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

  // Web Crawling timeouts
  httpTimeoutMs: parseInt(process.env.HTTP_TIMEOUT_MS || "12000", 10)
};

// Ensure required runtime directories exist
[config.dataDir, config.logsDir, config.outputDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

module.exports = config;
