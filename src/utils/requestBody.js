const MAX_REQUEST_BODY_BYTES = 15 * 1024 * 1024;

function bodyError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function parseJsonBody(value) {
  if (value === undefined || value === null || value === "") return {};

  if (typeof value === "object" && !Buffer.isBuffer(value)) {
    if (ArrayBuffer.isView(value)) {
      value = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    } else {
      const serialized = JSON.stringify(value);
      if (Buffer.byteLength(serialized, "utf8") > MAX_REQUEST_BODY_BYTES) {
        throw bodyError("Request body too large", 413);
      }
      return value;
    }
  }

  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BODY_BYTES) {
    throw bodyError("Request body too large", 413);
  }
  if (!text.trim()) return {};

  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw bodyError("Request body must be a JSON object", 400);
    }
    return parsed;
  } catch (error) {
    if (error.statusCode) throw error;
    throw bodyError("Request body contains invalid JSON", 400);
  }
}

async function parseRequestBody(req) {
  if (req.body !== undefined) return parseJsonBody(req.body);

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_REQUEST_BODY_BYTES) {
      throw bodyError("Request body too large", 413);
    }
    chunks.push(buffer);
  }

  return parseJsonBody(Buffer.concat(chunks, totalBytes));
}

module.exports = { MAX_REQUEST_BODY_BYTES, parseJsonBody, parseRequestBody };
