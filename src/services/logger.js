const fs = require("fs");
const path = require("path");
const config = require("../config");

function formatTimestamp() {
  return new Date().toISOString();
}

function writeToFile(filename, line) {
  try {
    const fullPath = path.join(config.logsDir, filename);
    fs.appendFileSync(fullPath, `[${formatTimestamp()}] ${line}\n`, "utf8");
  } catch (err) {
    // Non-blocking log write failure
  }
}

const logger = {
  info(message, meta = null) {
    const text = meta ? `${message} ${JSON.stringify(meta)}` : message;
    console.log(`ℹ️  ${message}`);
    writeToFile("research.log", text);
  },

  success(message, meta = null) {
    const text = meta ? `${message} ${JSON.stringify(meta)}` : message;
    console.log(`✅ ${message}`);
    writeToFile("research.log", text);
  },

  warn(message, meta = null) {
    const text = meta ? `${message} ${JSON.stringify(meta)}` : message;
    console.warn(`⚠️  ${message}`);
    writeToFile("research.log", `WARN: ${text}`);
  },

  error(message, error = null) {
    const errText = error ? `${message} - ${error.stack || error.message || error}` : message;
    console.error(`❌ ${message}`);
    if (error && error.message) console.error(`   Details: ${error.message}`);
    writeToFile("errors.log", errText);
  },

  debug(message, meta = null) {
    if (process.env.NODE_ENV === "development" || process.env.DEBUG === "true") {
      const text = meta ? `${message} ${JSON.stringify(meta)}` : message;
      console.log(`🔍 ${message}`);
    }
  },

  email(message, meta = null) {
    const text = meta ? `${message} ${JSON.stringify(meta)}` : message;
    console.log(`📧 ${message}`);
    writeToFile("email.log", text);
  },

  progress(current, total, companyName, details = "") {
    console.log(`\n[${current}/${total}] 🏢 Company: ${companyName}`);
    if (details) {
      console.log(details);
    }
  },

  section(title) {
    console.log("\n" + "=".repeat(60));
    console.log(`🌟 ${title.toUpperCase()}`);
    console.log("=".repeat(60));
  }
};

module.exports = logger;
