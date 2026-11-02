const logger = require("../services/logger");

async function handleStorePerformanceAuditRoute(req, res, pathname, helpers) {
  if (!pathname.startsWith("/api/merchant/audits")) return false;
  const { parseBody, sendJson, sendError } = helpers;
  const method = req.method || "GET";
  const auditService = require("../services/storePerformanceAudit");

  if (pathname === "/api/merchant/audits" && method === "GET") {
    try {
      const audits = auditService.listAudits(new URL(req.url, "http://localhost").searchParams.get("status"));
      sendJson(res, 200, { success: true, count: audits.length, audits });
    } catch (error) {
      sendError(res, error.statusCode || 500, error.message || "Failed to list performance audits");
    }
    return true;
  }

  if (pathname === "/api/merchant/audits" && method === "POST") {
    try {
      const body = await parseBody(req);
      const audit = await auditService.createAudit({
        leadId: body.leadId,
        mode: body.mode || "short",
        strategy: body.strategy || "mobile"
      });
      sendJson(res, 201, { success: true, audit });
    } catch (error) {
      logger.error("Merchant performance audit failed:", error);
      sendError(res, error.statusCode || 500, error.message || "Failed to create performance audit");
    }
    return true;
  }

  const reportMatch = pathname.match(/^\/api\/merchant\/audits\/(\d+)\/report$/);
  if (reportMatch && method === "GET") {
    try {
      const { audit, content } = auditService.getAuditReport(Number(reportMatch[1]));
      res.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Length": content.length,
        "Content-Disposition": `attachment; filename="${String(audit.domain || "store").replace(/[^a-z0-9.-]/gi, "-")}-performance-audit.pdf"`,
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, Origin, X-Requested-With"
      });
      res.end(content);
    } catch (error) {
      sendError(res, error.statusCode || 500, error.message || "Failed to create PDF report");
    }
    return true;
  }

  const actionMatch = pathname.match(/^\/api\/merchant\/audits\/(\d+)(?:\/(approve|send))?$/);
  if (!actionMatch) return false;

  const auditId = Number(actionMatch[1]);
  const action = actionMatch[2] || null;
  if (!action && method === "GET") {
    try {
      const audit = auditService.getAudit(auditId);
      if (!audit) {
        sendError(res, 404, "Performance audit not found");
        return true;
      }
      sendJson(res, 200, { success: true, audit });
    } catch (error) {
      sendError(res, error.statusCode || 500, error.message || "Failed to fetch performance audit");
    }
    return true;
  }

  if (!action && method === "PATCH") {
    try {
      const body = await parseBody(req);
      sendJson(res, 200, { success: true, audit: auditService.updateDraft(auditId, body) });
    } catch (error) {
      sendError(res, error.statusCode || 500, error.message || "Failed to update performance audit draft");
    }
    return true;
  }

  if (action === "approve" && method === "POST") {
    try {
      sendJson(res, 200, { success: true, audit: auditService.approveAudit(auditId) });
    } catch (error) {
      sendError(res, error.statusCode || 500, error.message || "Failed to approve performance audit");
    }
    return true;
  }

  if (action === "send" && method === "POST") {
    try {
      sendJson(res, 200, { success: true, audit: await auditService.sendApprovedAudit(auditId) });
    } catch (error) {
      sendError(res, error.statusCode || 500, error.message || "Failed to send approved performance audit");
    }
    return true;
  }

  return false;
}

module.exports = { handleStorePerformanceAuditRoute };
