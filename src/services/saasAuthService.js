const crypto = require("node:crypto");
const { promisify } = require("node:util");
const nodemailer = require("nodemailer");
const config = require("../config");
const { AUTHORIZED_ADMIN_EMAIL } = require("./saasAccessService");

const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = "saas_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const RATE_WINDOW_SECONDS = 15 * 60;
const LOGIN_ATTEMPT_LIMIT = 10;
const PASSWORD_RESET_LIMIT = 5;
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_OPTIONS = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 128 * 1024 * 1024 };
const DUMMY_PASSWORD_HASH = (() => {
  const salt = Buffer.alloc(16, 0x5a);
  const key = crypto.scryptSync("dummy-password-not-used", salt, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${key.toString("hex")}`;
})();

function inputError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function normalizeEmail(email) {
  if (typeof email !== "string") throw inputError("Email is required");
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw inputError("A valid email address is required");
  }
  return normalized;
}

function hashOpaqueToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function safeEqualText(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || right.length > 512) return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

async function hashPassword(password) {
  if (typeof password !== "string" || password.length < 12 || password.length > 128) {
    throw inputError("Password must contain between 12 and 128 characters");
  }

  const salt = crypto.randomBytes(16);
  const derivedKey = await scrypt(password, salt, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${derivedKey.toString("hex")}`;
}

async function verifyPassword(password, encodedHash) {
  if (typeof password !== "string" || password.length > 128 || typeof encodedHash !== "string") return false;
  const parts = encodedHash.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, nText, rText, pText, saltHex, expectedHex] = parts;
  if (Number(nText) !== SCRYPT_N || Number(rText) !== SCRYPT_R || Number(pText) !== SCRYPT_P) {
    return false;
  }
  if (!/^[a-f0-9]{32}$/.test(saltHex) || !/^[a-f0-9]{128}$/.test(expectedHex)) return false;

  const expected = Buffer.from(expectedHex, "hex");
  const derived = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length, SCRYPT_OPTIONS);
  return crypto.timingSafeEqual(derived, expected);
}

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    registeredAt: row.registered_at,
    emailVerified: Boolean(row.email_verified_at)
  };
}

function newOpaqueToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function getClientAddress(req) {
  return req.socket?.remoteAddress || "unknown";
}

async function consumeRateLimit(pool, bucket, limit, windowSeconds = RATE_WINDOW_SECONDS) {
  const bucketHash = hashOpaqueToken(bucket);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [bucketHash]);

    const nowResult = await client.query("SELECT clock_timestamp() AS now");
    const now = new Date(nowResult.rows[0].now);
    const current = await client.query(
      "SELECT attempt_count, window_started_at, blocked_until FROM saas_auth_rate_limits WHERE bucket_hash = $1 FOR UPDATE",
      [bucketHash]
    );

    if (current.rowCount && current.rows[0].blocked_until && new Date(current.rows[0].blocked_until) > now) {
      await client.query("COMMIT");
      return false;
    }

    const windowExpired = !current.rowCount
      || now.getTime() - new Date(current.rows[0].window_started_at).getTime() >= windowSeconds * 1000;
    const attempts = windowExpired ? 1 : Number(current.rows[0].attempt_count) + 1;
    const blockedUntil = attempts >= limit
      ? new Date(now.getTime() + windowSeconds * 1000)
      : null;

    await client.query(`
      INSERT INTO saas_auth_rate_limits (bucket_hash, attempt_count, window_started_at, blocked_until)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (bucket_hash) DO UPDATE SET
        attempt_count = EXCLUDED.attempt_count,
        window_started_at = EXCLUDED.window_started_at,
        blocked_until = EXCLUDED.blocked_until
    `, [bucketHash, attempts, windowExpired ? now : current.rows[0].window_started_at, blockedUntil]);
    await client.query("COMMIT");
    return attempts <= limit;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function clearRateLimit(pool, bucket) {
  await pool.query("DELETE FROM saas_auth_rate_limits WHERE bucket_hash = $1", [hashOpaqueToken(bucket)]);
}

async function createSession(pool, userId) {
  const token = newOpaqueToken();
  await pool.query(`
    INSERT INTO saas_sessions (id, user_id, token_hash, expires_at)
    VALUES ($1, $2, $3, clock_timestamp() + make_interval(secs => $4))
  `, [crypto.randomUUID(), userId, hashOpaqueToken(token), SESSION_TTL_SECONDS]);
  return token;
}

async function registerUser(pool, email, password, clientAddress) {
  const normalizedEmail = normalizeEmail(email);
  if (!await consumeRateLimit(pool, `register:${clientAddress}`, 5)) {
    const error = new Error("Registration rate limit exceeded");
    error.statusCode = 429;
    throw error;
  }

  const passwordHash = await hashPassword(password);
  const id = crypto.randomUUID();
  let inserted;
  try {
    inserted = await pool.query(`
      INSERT INTO saas_users (id, email, email_normalized, password_hash, role)
      VALUES ($1, $2, $3, $4, 'USER')
      RETURNING id, email, role, registered_at, email_verified_at
    `, [id, email.trim(), normalizedEmail, passwordHash]);
  } catch (error) {
    if (error.code === "23505") {
      const duplicate = new Error("An account with this email already exists");
      duplicate.statusCode = 409;
      throw duplicate;
    }
    throw error;
  }

  const sessionToken = await createSession(pool, id);
  return { user: publicUser(inserted.rows[0]), sessionToken };
}

async function loginUser(pool, email, password, clientAddress) {
  const normalizedEmail = normalizeEmail(email);
  if (typeof password !== "string" || password.length > 128) {
    const error = new Error("Email or password is incorrect");
    error.statusCode = 401;
    throw error;
  }
  const bucket = `login:${clientAddress}:${normalizedEmail}`;
  if (!await consumeRateLimit(pool, bucket, LOGIN_ATTEMPT_LIMIT)) {
    const error = new Error("Too many login attempts. Try again later.");
    error.statusCode = 429;
    throw error;
  }

  const result = await pool.query(`
    SELECT id, email, email_normalized, password_hash, role, registered_at,
           email_verified_at, disabled_at
    FROM saas_users
    WHERE email_normalized = $1
  `, [normalizedEmail]);
  const row = result.rows[0];
  const passwordValid = await verifyPassword(password, row ? row.password_hash : DUMMY_PASSWORD_HASH);
  if (!row || row.disabled_at || !passwordValid) {
    const error = new Error("Email or password is incorrect");
    error.statusCode = 401;
    throw error;
  }

  await clearRateLimit(pool, bucket);
  const sessionToken = await createSession(pool, row.id);
  return { user: publicUser(row), sessionToken };
}

function getCookieValue(req, name) {
  const cookieHeader = req.headers.cookie || "";
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

async function authenticateRequest(pool, req) {
  const token = getCookieValue(req, SESSION_COOKIE);
  if (!token || token.length > 128) return null;

  const result = await pool.query(`
    SELECT u.id, u.email, u.email_normalized, u.role, u.registered_at,
           u.email_verified_at, u.disabled_at, b.admin_user_id, s.id AS session_id
    FROM saas_sessions s
    JOIN saas_users u ON u.id = s.user_id
    CROSS JOIN saas_bootstrap_state b
    WHERE s.token_hash = $1
      AND s.revoked_at IS NULL
      AND s.expires_at > clock_timestamp()
      AND u.disabled_at IS NULL
      AND b.singleton = TRUE
  `, [hashOpaqueToken(token)]);
  if (result.rowCount !== 1) return null;

  const row = result.rows[0];
  if (row.role === "ADMIN"
    && (row.email_normalized !== AUTHORIZED_ADMIN_EMAIL || String(row.id) !== String(row.admin_user_id))) {
    return null;
  }
  await pool.query(
    "UPDATE saas_sessions SET last_seen_at = clock_timestamp() WHERE id = $1",
    [row.session_id]
  );
  return publicUser(row);
}

async function revokeSession(pool, req) {
  const token = getCookieValue(req, SESSION_COOKIE);
  if (!token || token.length > 128) return;
  await pool.query(
    "UPDATE saas_sessions SET revoked_at = clock_timestamp() WHERE token_hash = $1 AND revoked_at IS NULL",
    [hashOpaqueToken(token)]
  );
}

function sessionCookie(token, secure = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL)) {
  if (!token) {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
  }
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure ? "; Secure" : ""}`;
}

function getAppOrigin() {
  const origin = process.env.APP_PUBLIC_URL || process.env.FRONTEND_URL;
  if (!origin) {
    const error = new Error("APP_PUBLIC_URL must be configured for account email links");
    error.statusCode = 503;
    throw error;
  }
  const parsed = new URL(origin);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    const error = new Error("APP_PUBLIC_URL must be a valid HTTP(S) origin");
    error.statusCode = 503;
    throw error;
  }
  if (parsed.protocol !== "https:" && process.env.NODE_ENV === "production") {
    const error = new Error("APP_PUBLIC_URL must use HTTPS in production");
    error.statusCode = 503;
    throw error;
  }
  return parsed.origin;
}

async function sendAccountEmail(to, subject, text) {
  if (!config.smtp.user || !config.smtp.pass) {
    const error = new Error("SMTP_USER and SMTP_PASS must be configured to send account emails");
    error.statusCode = 503;
    throw error;
  }
  const transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.pass }
  });
  await transporter.sendMail({ from: config.smtp.from, to, subject, text });
}

async function issueEmailToken(pool, userId, email, purpose) {
  const token = newOpaqueToken();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      UPDATE saas_email_tokens
      SET consumed_at = clock_timestamp()
      WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL
    `, [userId, purpose]);
    await client.query(`
      INSERT INTO saas_email_tokens (token_hash, user_id, purpose, expires_at)
      VALUES ($1, $2, $3, clock_timestamp() + make_interval(hours => $4))
    `, [hashOpaqueToken(token), userId, purpose, purpose === "RESET_PASSWORD" ? 1 : 24]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const route = purpose === "RESET_PASSWORD" ? "/reset-password" : "/verify-email";
  const link = new URL(`${route}?token=${encodeURIComponent(token)}`, getAppOrigin());
  const message = purpose === "RESET_PASSWORD"
    ? `Use this one-time link to reset your password: ${link.href}\nIf you did not request this, ignore this email.`
    : `Use this one-time link to verify your email: ${link.href}\n`;
  await sendAccountEmail(email, purpose === "RESET_PASSWORD" ? "Reset your password" : "Verify your email", message);
}

async function requestPasswordReset(pool, email, clientAddress) {
  const normalizedEmail = normalizeEmail(email);
  const ipAllowed = await consumeRateLimit(pool, `password-reset-ip:${clientAddress}`, PASSWORD_RESET_LIMIT);
  const emailAllowed = await consumeRateLimit(pool, `password-reset-email:${normalizedEmail}`, PASSWORD_RESET_LIMIT);
  if (!ipAllowed || !emailAllowed) {
    const error = new Error("Password reset rate limit exceeded");
    error.statusCode = 429;
    throw error;
  }

  const result = await pool.query(
    "SELECT id, email FROM saas_users WHERE email_normalized = $1 AND disabled_at IS NULL",
    [normalizedEmail]
  );
  if (result.rowCount) {
    await issueEmailToken(pool, result.rows[0].id, result.rows[0].email, "RESET_PASSWORD");
  }
}

async function requestEmailVerification(pool, user) {
  if (!await consumeRateLimit(pool, `email-verification:${user.id}`, 3, 60 * 60)) {
    const error = new Error("Email verification rate limit exceeded");
    error.statusCode = 429;
    throw error;
  }
  const result = await pool.query(
    "SELECT email_verified_at FROM saas_users WHERE id = $1 AND disabled_at IS NULL",
    [user.id]
  );
  if (result.rowCount !== 1) throw new Error("Account was not found");
  if (result.rows[0].email_verified_at) return;
  await issueEmailToken(pool, user.id, user.email, "VERIFY_EMAIL");
}

async function consumeEmailToken(pool, token, purpose, newPassword) {
  if (typeof token !== "string" || token.length < 32 || token.length > 128) {
    throw inputError("A valid one-time token is required");
  }
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const tokenResult = await client.query(`
      SELECT token_hash, user_id
      FROM saas_email_tokens
      WHERE token_hash = $1 AND purpose = $2
        AND consumed_at IS NULL AND expires_at > clock_timestamp()
      FOR UPDATE
    `, [hashOpaqueToken(token), purpose]);
    if (tokenResult.rowCount !== 1) {
      const error = inputError("Token is invalid, expired, or already used");
      throw error;
    }

    const userId = tokenResult.rows[0].user_id;
    if (purpose === "VERIFY_EMAIL") {
      await client.query(
        "UPDATE saas_users SET email_verified_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1",
        [userId]
      );
    } else {
      const passwordHash = await hashPassword(newPassword);
      await client.query(
        "UPDATE saas_users SET password_hash = $2, updated_at = clock_timestamp() WHERE id = $1",
        [userId, passwordHash]
      );
      await client.query(
        "UPDATE saas_sessions SET revoked_at = clock_timestamp() WHERE user_id = $1 AND revoked_at IS NULL",
        [userId]
      );
    }

    await client.query(`
      UPDATE saas_email_tokens
      SET consumed_at = clock_timestamp()
      WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL
    `, [userId, purpose]);
    await client.query("COMMIT");
    return { userId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function bootstrapAdmin(pool, user, presentedToken) {
  const expectedToken = process.env.ADMIN_BOOTSTRAP_TOKEN;
  if (!expectedToken || !safeEqualText(presentedToken, expectedToken)) {
    const error = new Error("Administrator bootstrap is not authorized");
    error.statusCode = 403;
    throw error;
  }

  if (normalizeEmail(user.email) !== AUTHORIZED_ADMIN_EMAIL || !user.emailVerified) {
    const error = new Error("The authorized email must be verified before admin bootstrap");
    error.statusCode = 403;
    throw error;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const state = await client.query(
      "SELECT admin_user_id, admin_bootstrap_completed_at FROM saas_bootstrap_state WHERE singleton = TRUE FOR UPDATE"
    );
    if (state.rowCount !== 1 || state.rows[0].admin_bootstrap_completed_at) {
      throw new Error("Administrator bootstrap has already been completed");
    }
    if (state.rows[0].admin_user_id) {
      throw new Error("An administrator is already bound to this system");
    }

    const updated = await client.query(`
      UPDATE saas_users
      SET role = 'ADMIN', updated_at = clock_timestamp()
      WHERE id = $1 AND email_normalized = $2 AND role = 'USER'
        AND email_verified_at IS NOT NULL AND disabled_at IS NULL
      RETURNING id, email, email_normalized, role, registered_at, email_verified_at
    `, [user.id, AUTHORIZED_ADMIN_EMAIL]);
    if (updated.rowCount !== 1) throw new Error("Eligible admin account was not found");

    await client.query(`
      UPDATE saas_bootstrap_state
      SET admin_user_id = $1, admin_bootstrap_completed_at = clock_timestamp()
      WHERE singleton = TRUE
    `, [user.id]);
    await client.query(`
      INSERT INTO saas_admin_audit (id, admin_user_id, admin_email, action, previous_value, new_value, reason)
      VALUES ($1, $2, $3, 'ADMIN_BOOTSTRAP', $4::jsonb, $5::jsonb, $6)
    `, [
      crypto.randomUUID(),
      user.id,
      AUTHORIZED_ADMIN_EMAIL,
      JSON.stringify({ role: "USER" }),
      JSON.stringify({ role: "ADMIN" }),
      "One-time out-of-band bootstrap with verified email and server-side token"
    ]);

    await client.query("COMMIT");
    return publicUser(updated.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  AUTHORIZED_ADMIN_EMAIL,
  SESSION_COOKIE,
  authenticateRequest,
  bootstrapAdmin,
  consumeEmailToken,
  getClientAddress,
  hashOpaqueToken,
  hashPassword,
  loginUser,
  normalizeEmail,
  publicUser,
  registerUser,
  requestEmailVerification,
  requestPasswordReset,
  revokeSession,
  sessionCookie,
  verifyPassword
};
