const fs = require("node:fs");
const path = require("node:path");
const config = require("../config");

const MAX_RESUME_BYTES = 10 * 1024 * 1024;
const RESUME_TOKEN = process.env.BLOB_READ_WRITE_TOKEN || "";
const isVercel = process.env.VERCEL === "1" || process.env.VERCEL === "true";

function sanitizeFilename(filename) {
  const safeFilename = path.basename(String(filename || "")).trim();
  if (!safeFilename || !safeFilename.toLowerCase().endsWith(".pdf")) {
    throw new Error("Only PDF files are supported");
  }
  return safeFilename;
}

function isRemoteReference(reference) {
  return typeof reference === "string" && /^https:\/\//i.test(reference);
}

function localResumeDirectory() {
  return path.join(config.dataDir, "resumes");
}

async function saveResume(filename, buffer) {
  const safeFilename = sanitizeFilename(filename);
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("Resume file is empty");
  }
  if (buffer.length > MAX_RESUME_BYTES) {
    throw new Error("File size exceeds 10MB limit");
  }

  if (isVercel) {
    if (!RESUME_TOKEN) {
      throw new Error("Resume storage is not configured. Set BLOB_READ_WRITE_TOKEN before uploading.");
    }
    const { put } = require("@vercel/blob");
    const blob = await put(`resumes/${safeFilename}`, buffer, {
      access: "private",
      addRandomSuffix: true,
      contentType: "application/pdf"
    });
    return { reference: blob.url, filename: safeFilename };
  }

  const directory = localResumeDirectory();
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, safeFilename);
  fs.writeFileSync(filePath, buffer);
  return { reference: filePath, filename: safeFilename };
}

async function removeResume(reference) {
  if (!reference) return;
  if (isRemoteReference(reference)) {
    if (RESUME_TOKEN) {
      const { del } = require("@vercel/blob");
      await del(reference);
    }
    return;
  }
  try {
    if (fs.existsSync(reference)) fs.unlinkSync(reference);
  } catch {
    // Removing an old local file is best effort.
  }
}

async function readResume(reference) {
  if (!reference) return null;
  if (isRemoteReference(reference)) {
    if (!RESUME_TOKEN) throw new Error("Resume storage is not configured.");
    const response = await fetch(reference, {
      headers: { Authorization: `Bearer ${RESUME_TOKEN}` }
    });
    if (!response.ok) throw new Error(`Resume could not be fetched from storage (${response.status}).`);
    return Buffer.from(await response.arrayBuffer());
  }
  if (!fs.existsSync(reference)) return null;
  return fs.readFileSync(reference);
}

module.exports = {
  MAX_RESUME_BYTES,
  isRemoteReference,
  readResume,
  removeResume,
  sanitizeFilename,
  saveResume
};
