const {
  authenticateRequest,
  bootstrapAdmin,
  consumeEmailToken,
  getClientAddress,
  loginUser,
  registerUser,
  requestEmailVerification,
  requestPasswordReset,
  revokeSession,
  sessionCookie
} = require("../services/saasAuthService");
const {
  getAccessSummary,
  listUserLeads,
  saveUniqueLeads
} = require("../services/saasAccessService");
const { getSaasPool } = require("../db/saasDatabase");
const crypto = require("node:crypto");

const PUBLIC_POST_ROUTES = new Set([
  "/api/auth/register",
  "/api/auth/login",
  "/api/auth/password-reset/request",
  "/api/auth/password-reset/complete",
  "/api/auth/verify-email"
]);

function isAuthRoute(pathname) {
  return pathname === "/api/auth" || pathname.startsWith("/api/auth/");
}

function isAccountRoute(pathname) {
  return pathname === "/api/account" || pathname.startsWith("/api/account/");
}

function authorizeCronRequest(req) {
  const expectedToken = process.env.CRON_SECRET;
  const authorization = req.headers.authorization;
  if (typeof expectedToken !== "string" || expectedToken.length < 32
    || typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    return false;
  }
  const presentedToken = authorization.slice("Bearer ".length);
  const expected = Buffer.from(expectedToken);
  const presented = Buffer.from(presentedToken);
  return expected.length === presented.length && crypto.timingSafeEqual(expected, presented);
}

function sendRouteError(res, error) {
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (status >= 500) {
    console.error("[SAAS_AUTH] Authentication request failed:", error.message);
  }
  const message = status >= 500 ? "Authentication service is unavailable" : error.message;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify({ success: false, error: message }));
}

async function handleSaasAuthRoute(req, res, pathname, { parseBody, sendJson }) {
  if (!isAuthRoute(pathname) && !isAccountRoute(pathname)) return false;
  res.setHeader("Cache-Control", "no-store");
  const method = req.method || "GET";

  if (method === "POST" && pathname === "/api/auth/logout") {
    try {
      await revokeSession(getSaasPool(), req);
      res.setHeader("Set-Cookie", sessionCookie(null));
      res.setHeader("Cache-Control", "no-store");
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendRouteError(res, error);
    }
    return true;
  }

  if (method !== "GET" && method !== "POST") {
    sendJson(res, 405, { success: false, error: "Method not allowed" });
    return true;
  }

  try {
    const pool = getSaasPool();
    const body = method === "POST" ? await parseBody(req) : {};
    let user = null;
    if (!PUBLIC_POST_ROUTES.has(pathname)) {
      user = await authenticateRequest(pool, req);
      if (!user) {
        sendJson(res, 401, { success: false, error: "Authentication required" });
        return true;
      }
    }

    if (method === "POST" && pathname === "/api/auth/register") {
      const result = await registerUser(pool, body.email, body.password, getClientAddress(req));
      const access = await getAccessSummary(pool, result.user.id);
      res.setHeader("Set-Cookie", sessionCookie(result.sessionToken));
      res.setHeader("Cache-Control", "no-store");
      sendJson(res, 201, { success: true, user: result.user, access });
      return true;
    }

    if (method === "POST" && pathname === "/api/auth/login") {
      const result = await loginUser(pool, body.email, body.password, getClientAddress(req));
      const access = await getAccessSummary(pool, result.user.id);
      res.setHeader("Set-Cookie", sessionCookie(result.sessionToken));
      res.setHeader("Cache-Control", "no-store");
      sendJson(res, 200, { success: true, user: result.user, access });
      return true;
    }

    if (method === "GET" && pathname === "/api/auth/me") {
      const access = await getAccessSummary(pool, user.id);
      res.setHeader("Cache-Control", "no-store");
      sendJson(res, 200, { success: true, user, access });
      return true;
    }

    if (method === "GET" && pathname === "/api/account/leads") {
      const leads = await listUserLeads(pool, user.id);
      res.setHeader("Cache-Control", "no-store");
      sendJson(res, 200, { success: true, leads });
      return true;
    }

    if (method === "POST" && pathname === "/api/account/leads") {
      if (!Array.isArray(body.leads) || body.leads.length > 100) {
        const error = new Error("Provide an array of no more than 100 leads");
        error.statusCode = 400;
        throw error;
      }
      const result = await saveUniqueLeads(pool, user.id, body.leads);
      const status = result.blocked ? 402 : 200;
      sendJson(res, status, { success: !result.blocked, ...result });
      return true;
    }

    if (method === "POST" && pathname === "/api/auth/password-reset/request") {
      await requestPasswordReset(pool, body.email, getClientAddress(req));
      res.setHeader("Cache-Control", "no-store");
      sendJson(res, 202, {
        success: true,
        message: "If an account exists for that email, password reset instructions will be sent."
      });
      return true;
    }

    if (method === "POST" && pathname === "/api/auth/password-reset/complete") {
      await consumeEmailToken(pool, body.token, "RESET_PASSWORD", body.password);
      res.setHeader("Cache-Control", "no-store");
      sendJson(res, 200, { success: true, message: "Password has been reset. Please sign in again." });
      return true;
    }

    if (method === "POST" && pathname === "/api/auth/email-verification/request") {
      await requestEmailVerification(pool, user);
      sendJson(res, 200, { success: true, message: "Verification email sent if the account requires verification." });
      return true;
    }

    if (method === "POST" && pathname === "/api/auth/verify-email") {
      await consumeEmailToken(pool, body.token, "VERIFY_EMAIL");
      sendJson(res, 200, { success: true, message: "Email address verified." });
      return true;
    }

    if (method === "POST" && pathname === "/api/auth/admin/bootstrap") {
      const admin = await bootstrapAdmin(pool, user, body.bootstrapToken);
      sendJson(res, 200, { success: true, user: admin });
      return true;
    }

    sendJson(res, 404, { success: false, error: "Authentication route not found" });
  } catch (error) {
    sendRouteError(res, error);
  }
  return true;
}

async function authenticateLegacyRequest(req, res, sendJson) {
  try {
    const user = await authenticateRequest(getSaasPool(), req);
    if (!user) {
      sendJson(res, 401, { success: false, error: "Authentication required" });
      return false;
    }
    if (user.role !== "ADMIN") {
      sendJson(res, 403, {
        success: false,
        error: "This feature is not available until user-scoped data access is enabled."
      });
      return false;
    }
    req.saasUser = user;
    return true;
  } catch (error) {
    console.error("[SAAS_AUTH] Legacy API authorization failed:", error.message);
    const status = Number.isInteger(error.statusCode) ? error.statusCode : 503;
    sendJson(res, status, {
      success: false,
      error: "Authentication service is unavailable"
    });
    return false;
  }
}

module.exports = {
  authenticateLegacyRequest,
  authorizeCronRequest,
  handleSaasAuthRoute,
  isAccountRoute,
  isAuthRoute
};
