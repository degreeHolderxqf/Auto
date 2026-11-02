const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { parseJsonBody, parseRequestBody } = require("../src/utils/requestBody");

test("parses a platform-preparsed JSON request object", async () => {
  const body = { email: "user@example.com", password: "example-password" };
  assert.deepEqual(await parseRequestBody({ body }), body);
});

test("parses JSON strings and buffers supplied by a serverless runtime", () => {
  assert.deepEqual(parseJsonBody('{"email":"user@example.com"}'), { email: "user@example.com" });
  assert.deepEqual(parseJsonBody(Buffer.from('{"email":"user@example.com"}')), { email: "user@example.com" });
});

test("parses JSON from a regular Node request stream", async () => {
  const request = Readable.from(['{"email":"user@example.com"}']);
  assert.deepEqual(await parseRequestBody(request), { email: "user@example.com" });
});

test("rejects malformed or non-object JSON instead of silently treating it as empty", () => {
  assert.throws(() => parseJsonBody("{"), { statusCode: 400, message: "Request body contains invalid JSON" });
  assert.throws(() => parseJsonBody("[]"), { statusCode: 400, message: "Request body must be a JSON object" });
});
