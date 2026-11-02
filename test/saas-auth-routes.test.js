const test = require("node:test");
const assert = require("node:assert/strict");

process.env.DATABASE_URL = "";
const {
  authenticateLegacyRequest,
  authorizeCronRequest,
  handleSaasAuthRoute
} = require("../src/api/saasAuthRoutes");

function makeResponse() {
  return {
    headers: {},
    statusCode: null,
    body: "",
    setHeader(name, value) {
      this.headers[name] = value;
    },
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      Object.assign(this.headers, headers);
    },
    end(body) {
      this.body = body;
    }
  };
}

function sendJson(res, statusCode, data) {
  res.statusCode = statusCode;
  res.body = JSON.stringify(data);
}

test("auth endpoints fail closed when durable PostgreSQL is not configured", async () => {
  const res = makeResponse();
  const handled = await handleSaasAuthRoute(
    { method: "GET", headers: {} },
    res,
    "/api/auth/me",
    { parseBody: async () => ({}), sendJson }
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 503);
  assert.equal(JSON.parse(res.body).success, false);
  assert.equal(res.headers["Cache-Control"], "no-store");
});

test("legacy data endpoints fail closed without an authenticated SaaS database", async () => {
  const res = makeResponse();
  const authorized = await authenticateLegacyRequest(
    { headers: {} },
    res,
    sendJson
  );

  assert.equal(authorized, false);
  assert.equal(res.statusCode, 503);
  assert.equal(JSON.parse(res.body).success, false);
});

test("scheduled worker authorization requires the configured bearer secret", () => {
  const previousSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "a".repeat(32);
  try {
    assert.equal(authorizeCronRequest({ headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }), true);
    assert.equal(authorizeCronRequest({ headers: { authorization: "Bearer wrong" } }), false);
    assert.equal(authorizeCronRequest({ headers: {} }), false);
  } finally {
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
  }
});
