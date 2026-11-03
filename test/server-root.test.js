const test = require("node:test");
const assert = require("node:assert/strict");
const handler = require("../src/server.cjs");

test("GET / returns public API information without authentication", async () => {
  const res = {
    headers: {},
    statusCode: null,
    body: "",
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body) {
      this.body = body;
    }
  };

  await handler(
    { method: "GET", url: "/", headers: { host: "localhost" } },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {
    status: "ok",
    service: "Bulk Leads API",
    health: "/health"
  });
});
