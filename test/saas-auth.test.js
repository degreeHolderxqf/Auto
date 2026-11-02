const test = require("node:test");
const assert = require("node:assert/strict");
const {
  hashOpaqueToken,
  hashPassword,
  normalizeEmail,
  sessionCookie,
  verifyPassword
} = require("../src/services/saasAuthService");

test("normalizes email without changing password semantics", () => {
  assert.equal(normalizeEmail("  User@Example.com "), "user@example.com");
  assert.throws(() => normalizeEmail("invalid"), /valid email/);
});

test("hashes passwords with unique salts and verifies only the matching password", async () => {
  const firstHash = await hashPassword("correct horse battery staple");
  const secondHash = await hashPassword("correct horse battery staple");
  assert.notEqual(firstHash, secondHash);
  assert.equal(await verifyPassword("correct horse battery staple", firstHash), true);
  assert.equal(await verifyPassword("incorrect password", firstHash), false);
  assert.equal(await verifyPassword("correct horse battery staple", "invalid"), false);
  await assert.rejects(() => hashPassword("short"), /12 and 128/);
});

test("hashes opaque tokens and emits an HttpOnly session cookie", () => {
  assert.equal(hashOpaqueToken("token").length, 64);
  const cookie = sessionCookie("opaque-token", false);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  assert.doesNotMatch(cookie, /opaque-token;.*Secure/);
});
