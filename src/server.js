const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const db = require("./db/database");
const logger = require("./services/logger");
const config = require("./config");

function startServer(port = process.env.PORT || 3000) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health Check
    if (pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "healthy", uptime: process.uptime(), timestamp: new Date().toISOString() }));
      return;
    }

    // JSON Stats API
    if (pathname === "/api/stats") {
      try {
        const stats = db.getStatistics();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, stats }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    // JSON Preview API
    if (pathname === "/api/preview") {
      try {
        const limit = parseInt(url.searchParams.get("limit") || "25", 10);
        const leads = db.getFinalQualifiedLeads(limit);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, count: leads.length, leads }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    // Download CSV
    if (pathname === "/download/csv") {
      const filePath = path.join(config.outputDir, "shopify_leads.csv");
      if (fs.existsSync(filePath)) {
        res.writeHead(200, {
          "Content-Type": "text/csv",
          "Content-Disposition": "attachment; filename=\"shopify_leads.csv\""
        });
        fs.createReadStream(filePath).pipe(res);
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("File not generated yet. Run lead generation first.");
      }
      return;
    }

    // Download XLSX
    if (pathname === "/download/xlsx") {
      const filePath = path.join(config.outputDir, "shopify_leads.xlsx");
      if (fs.existsSync(filePath)) {
        res.writeHead(200, {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": "attachment; filename=\"shopify_leads.xlsx\""
        });
        fs.createReadStream(filePath).pipe(res);
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("File not generated yet. Run lead generation first.");
      }
      return;
    }

    // Default Status Dashboard
    try {
      const stats = db.getStatistics();
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Shopify Lead Generation System — Dashboard</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --primary: #38bdf8;
      --accent: #10b981;
      --border: #334155;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; }
    body { background: var(--bg); color: var(--text); padding: 2rem 1rem; }
    .container { max-width: 900px; margin: 0 auto; }
    header { margin-bottom: 2rem; }
    h1 { font-size: 1.8rem; margin-bottom: 0.5rem; color: var(--primary); }
    p.sub { color: var(--text-muted); font-size: 0.95rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
    .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 1.25rem; }
    .card-title { font-size: 0.85rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem; }
    .card-value { font-size: 1.8rem; font-weight: 700; color: #fff; }
    .card-value.highlight { color: var(--accent); }
    .actions { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 2rem; }
    .btn { display: inline-flex; align-items: center; padding: 0.6rem 1.2rem; background: var(--primary); color: #0f172a; font-weight: 600; text-decoration: none; border-radius: 6px; font-size: 0.9rem; transition: opacity 0.2s; }
    .btn:hover { opacity: 0.9; }
    .btn.secondary { background: var(--card-bg); color: var(--text); border: 1px solid var(--border); }
    .status-badge { display: inline-block; padding: 0.25rem 0.6rem; background: #064e3b; color: #34d399; border-radius: 9999px; font-size: 0.8rem; font-weight: 600; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
        <h1>Shopify Partner Lead Generation Engine</h1>
        <span class="status-badge">● LIVE & HEALTHY</span>
      </div>
      <p class="sub">Automated Shopify Partner research, HR discovery, qualification, and outreach system.</p>
    </header>

    <div class="grid">
      <div class="card">
        <div class="card-title">Total Discovered</div>
        <div class="card-value">${stats.totalDiscovered}</div>
      </div>
      <div class="card">
        <div class="card-title">Qualified Leads (Score >= 70)</div>
        <div class="card-value highlight">${stats.qualified}</div>
      </div>
      <div class="card">
        <div class="card-title">Public Contacts Found</div>
        <div class="card-value">${stats.totalContacts}</div>
      </div>
      <div class="card">
        <div class="card-title">Ready for Outreach</div>
        <div class="card-value highlight">${stats.readyToSend}</div>
      </div>
      <div class="card">
        <div class="card-title">Emails Sent</div>
        <div class="card-value">${stats.sent}</div>
      </div>
      <div class="card">
        <div class="card-title">Excluded Companies</div>
        <div class="card-value">${stats.excluded}</div>
      </div>
    </div>

    <div class="actions">
      <a href="/download/csv" class="btn">📥 Download Leads CSV</a>
      <a href="/download/xlsx" class="btn">📊 Download Leads Excel</a>
      <a href="/api/stats" class="btn secondary">⚙️ JSON Stats</a>
      <a href="/api/preview" class="btn secondary">🔍 Preview Leads API</a>
    </div>
  </div>
</body>
</html>`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`Internal Server Error: ${err.message}`);
    }
  });

  server.listen(port, () => {
    logger.success(`Server listening on port ${port} (Health check: http://localhost:${port}/health)`);
  });

  return server;
}

module.exports = { startServer };
