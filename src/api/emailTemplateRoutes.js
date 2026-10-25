const emailTemplates = require("../services/emailTemplates");

function expressError(res, error, fallback) {
  const statusCode = error.statusCode || 500;
  return res.status(statusCode).json({ success: false, error: error.message || fallback });
}

// Express adapter for deployments using Express. The local app currently calls
// the native HTTP adapter below, so Express remains an optional integration.
function registerExpressTemplateRoutes(router) {
  router.get("/", async (_req, res) => {
    try {
      const [templates, activeTemplateId] = await Promise.all([
        emailTemplates.getTemplates(),
        emailTemplates.getActiveTemplateId()
      ]);
      res.json({ success: true, templates, activeTemplateId });
    } catch (error) {
      expressError(res, error, "Could not load email templates.");
    }
  });

  router.post("/update", async (req, res) => {
    try {
      const template = await emailTemplates.updateTemplate(req.body?.id, req.body?.subject, req.body?.body);
      res.json({ success: true, template });
    } catch (error) {
      expressError(res, error, "Could not save email template.");
    }
  });

  router.post("/active", async (req, res) => {
    try {
      const activeTemplateId = await emailTemplates.setActiveTemplateId(req.body?.templateId);
      res.json({ success: true, activeTemplateId });
    } catch (error) {
      expressError(res, error, "Could not select the active email template.");
    }
  });

  return router;
}

async function handleEmailTemplateRoute(req, res, pathname, helpers) {
  const { parseBody, sendJson, sendError } = helpers;

  if (pathname === "/api/templates" && req.method === "GET") {
    try {
      const [templates, activeTemplateId] = await Promise.all([
        emailTemplates.getTemplates(),
        emailTemplates.getActiveTemplateId()
      ]);
      sendJson(res, 200, { success: true, templates, activeTemplateId });
    } catch (error) {
      sendError(res, error.statusCode || 500, error.message || "Could not load email templates.");
    }
    return true;
  }

  if (pathname === "/api/templates/update" && req.method === "POST") {
    try {
      const body = await parseBody(req);
      const template = await emailTemplates.updateTemplate(body.id, body.subject, body.body);
      sendJson(res, 200, { success: true, template });
    } catch (error) {
      sendError(res, error.statusCode || 500, error.message || "Could not save email template.");
    }
    return true;
  }

  if (pathname === "/api/templates/active" && req.method === "POST") {
    try {
      const body = await parseBody(req);
      const activeTemplateId = await emailTemplates.setActiveTemplateId(body.templateId);
      sendJson(res, 200, { success: true, activeTemplateId });
    } catch (error) {
      sendError(res, error.statusCode || 500, error.message || "Could not select the active email template.");
    }
    return true;
  }

  if (pathname === "/api/templates" || pathname === "/api/templates/update" || pathname === "/api/templates/active") {
    sendJson(res, 405, { success: false, error: "Method not allowed." });
    return true;
  }

  return false;
}

module.exports = { handleEmailTemplateRoute, registerExpressTemplateRoutes };
