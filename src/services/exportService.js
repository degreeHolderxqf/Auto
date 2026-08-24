const fs = require("fs");
const path = require("path");
const { createObjectCsvWriter } = require("csv-writer");
const XLSX = require("xlsx");
const config = require("../config");
const db = require("../db/database");
const logger = require("./logger");

class ExportService {
  async exportAll() {
    logger.info("Generating export files in output/ directory...");

    const leads = db.getFinalQualifiedLeads(200);
    const emailLogs = db.getAllEmailLogs();
    const stats = db.getStatistics();

    // 1. Export shopify_leads.csv & shopify_leads.xlsx
    await this.exportLeadsCsv(leads);
    this.exportLeadsXlsx(leads);

    // 2. Export research_report.json & research_report.csv
    this.exportResearchReportJson(leads, stats);
    await this.exportResearchReportCsv(leads);

    // 3. Export email_queue.csv (leads with HIGH/MEDIUM contact ready to send)
    await this.exportEmailQueueCsv(leads);

    // 4. Export email_history.csv
    await this.exportEmailHistoryCsv(emailLogs);

    logger.success("All export files successfully written to " + config.outputDir);
  }

  async exportLeadsCsv(leads) {
    const filePath = path.join(config.outputDir, "shopify_leads.csv");
    const csvWriter = createObjectCsvWriter({
      path: filePath,
      header: [
        { id: "name", title: "Company" },
        { id: "shopify_partner_url", title: "Shopify Partner URL" },
        { id: "official_website", title: "Official Website" },
        { id: "domain", title: "Domain" },
        { id: "city", title: "City" },
        { id: "state", title: "State" },
        { id: "country", title: "Country" },
        { id: "partner_tier", title: "Partner Tier" },
        { id: "rating", title: "Rating" },
        { id: "reviews", title: "Reviews" },
        { id: "shopify_services", title: "Shopify Services" },
        { id: "public_apps", title: "Public Shopify Apps" },
        { id: "app_relevance_score", title: "App Relevance Score" },
        { id: "lead_score", title: "Lead Score" },
        { id: "contact_name", title: "Contact Name" },
        { id: "contact_role", title: "Contact Role" },
        { id: "email", title: "Email" },
        { id: "email_type", title: "Email Type" },
        { id: "email_confidence", title: "Email Confidence" },
        { id: "email_source", title: "Email Source" },
        { id: "email_source_url", title: "Email Source URL" },
        { id: "careers_url", title: "Careers URL" },
        { id: "linkedin_url", title: "LinkedIn URL" },
        { id: "status", title: "Status" },
        { id: "created_at", title: "Created At" },
        { id: "updated_at", title: "Updated At" }
      ]
    });

    const records = leads.map((l) => ({
      name: l.name,
      shopify_partner_url: l.shopify_partner_url || "",
      official_website: l.official_website || "",
      domain: l.domain || "",
      city: l.city || "",
      state: l.state || "",
      country: l.country || "India",
      partner_tier: l.partner_tier || "Shopify Partner",
      rating: l.rating != null ? l.rating : "",
      reviews: l.reviews || 0,
      shopify_services: l.shopify_services || "",
      public_apps: l.public_apps || "",
      app_relevance_score: l.app_relevance_score || 0,
      lead_score: l.lead_score || 0,
      contact_name: l.contact_name || "",
      contact_role: l.contact_role || "",
      email: l.email || "",
      email_type: l.email_type || "",
      email_confidence: l.email_confidence || "",
      email_source: l.email_source_url ? "Public Website / Directory" : "",
      email_source_url: l.email_source_url || "",
      careers_url: l.careers_url || "",
      linkedin_url: l.linkedin_url || "",
      status: l.status,
      created_at: l.created_at,
      updated_at: l.updated_at
    }));

    await csvWriter.writeRecords(records);
  }

  exportLeadsXlsx(leads) {
    const filePath = path.join(config.outputDir, "shopify_leads.xlsx");
    const records = leads.map((l) => ({
      Company: l.name,
      "Shopify Partner URL": l.shopify_partner_url || "",
      "Official Website": l.official_website || "",
      Domain: l.domain || "",
      City: l.city || "",
      Country: l.country || "India",
      "Partner Tier": l.partner_tier || "Shopify Partner",
      Rating: l.rating != null ? l.rating : "",
      Reviews: l.reviews || 0,
      "Shopify Services": l.shopify_services || "",
      "Public Shopify Apps": l.public_apps || "",
      "App Relevance Score": l.app_relevance_score || 0,
      "Lead Score": l.lead_score || 0,
      "Contact Name": l.contact_name || "",
      "Contact Role": l.contact_role || "",
      Email: l.email || "",
      "Email Type": l.email_type || "",
      "Email Confidence": l.email_confidence || "",
      "Email Source URL": l.email_source_url || "",
      "Careers URL": l.careers_url || "",
      "LinkedIn URL": l.linkedin_url || "",
      Status: l.status
    }));

    const worksheet = XLSX.utils.json_to_sheet(records);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Shopify Leads");
    XLSX.writeFile(workbook, filePath);
  }

  exportResearchReportJson(leads, stats) {
    const filePath = path.join(config.outputDir, "research_report.json");
    const data = {
      generatedAt: new Date().toISOString(),
      statistics: stats,
      leads
    };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  }

  async exportResearchReportCsv(leads) {
    const filePath = path.join(config.outputDir, "research_report.csv");
    const csvWriter = createObjectCsvWriter({
      path: filePath,
      header: [
        { id: "name", title: "Company" },
        { id: "lead_score", title: "Lead Score" },
        { id: "app_relevance_score", title: "App Relevance" },
        { id: "email", title: "Email Found" },
        { id: "confidence", title: "Confidence" },
        { id: "status", title: "Status" },
        { id: "website", title: "Website" },
        { id: "careers", title: "Careers Page" }
      ]
    });

    const records = leads.map((l) => ({
      name: l.name,
      lead_score: l.lead_score,
      app_relevance_score: l.app_relevance_score,
      email: l.email || "No Public Contact",
      confidence: l.email_confidence || "NONE",
      status: l.status,
      website: l.official_website || "",
      careers: l.careers_url || ""
    }));

    await csvWriter.writeRecords(records);
  }

  async exportEmailQueueCsv(leads) {
    const filePath = path.join(config.outputDir, "email_queue.csv");
    const csvWriter = createObjectCsvWriter({
      path: filePath,
      header: [
        { id: "id", title: "Company ID" },
        { id: "name", title: "Company Name" },
        { id: "email", title: "Target Email" },
        { id: "email_type", title: "Email Type" },
        { id: "confidence", title: "Confidence" },
        { id: "lead_score", title: "Lead Score" },
        { id: "status", title: "Status" }
      ]
    });

    const eligible = leads.filter((l) => l.email && ["HIGH", "MEDIUM"].includes(l.email_confidence));
    const records = eligible.map((l) => ({
      id: l.id,
      name: l.name,
      email: l.email,
      email_type: l.email_type,
      confidence: l.email_confidence,
      lead_score: l.lead_score,
      status: l.status
    }));

    await csvWriter.writeRecords(records);
  }

  async exportEmailHistoryCsv(logs) {
    const filePath = path.join(config.outputDir, "email_history.csv");
    const csvWriter = createObjectCsvWriter({
      path: filePath,
      header: [
        { id: "id", title: "Log ID" },
        { id: "company_id", title: "Company ID" },
        { id: "email", title: "Email" },
        { id: "subject", title: "Subject" },
        { id: "status", title: "Status" },
        { id: "message_id", title: "Message ID" },
        { id: "error", title: "Error" },
        { id: "sent_at", title: "Sent At" }
      ]
    });

    await csvWriter.writeRecords(logs);
  }
}

module.exports = new ExportService();
