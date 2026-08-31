const http = require("http");
const https = require("https");
const { URL } = require("url");
const QRCode = require("qrcode");
const config = require("../config");
const logger = require("./logger");

const PROFILE_GO = "evolution-go";
const PROFILE_V2 = "evolution-api-v2";

const MASKED_VALUE = "<redacted>";
const QR_VALUE = "<qr-data>";
const SENSITIVE_KEY_RE = /(api[-_]?key|apikey|authorization|auth|bearer|token|password|passwd|secret|cookie|jwt|session)/i;
const QR_KEY_RE = /^(qrcode|qr|qrCode|base64|code|pairingCode|pairing_code)$/i;

class EvolutionGoClient {
  constructor() {
    this.defaultTimeout = 15000;
    this.isSimulatedConnected = false;
    this.lastProfile = null;
  }

  getApiConfig(overrides = null) {
    const settingsService = require("./settingsService");
    const settings = settingsService.getSettings(false);
    const merged = {
      apiUrl: settings.evolutionApiUrl || config.evolution.apiUrl || "https://evolution-api-latest-h0yy.onrender.com",
      apiKey: settings.evolutionApiKey !== undefined ? settings.evolutionApiKey : config.evolution.apiKey,
      instanceName: settings.evolutionInstanceName || config.evolution.instanceName || "job-search",
      enabled: settings.whatsAppEnabled !== undefined ? settings.whatsAppEnabled : config.evolution.enabled,
      dryRun: settings.whatsAppDryRun !== undefined ? settings.whatsAppDryRun : config.evolution.dryRun,
      delayMs: settings.whatsAppDelayMs || config.evolution.delayMs || 15000,
      ...overrides
    };

    return {
      ...merged,
      apiUrl: String(merged.apiUrl || "").trim().replace(/\/+$/, ""),
      apiKey: merged.apiKey ? String(merged.apiKey).trim() : "",
      instanceName: String(merged.instanceName || "job-search").trim() || "job-search",
      enabled: merged.enabled !== undefined ? Boolean(merged.enabled) : true,
      dryRun: merged.dryRun !== undefined ? Boolean(merged.dryRun) : true,
      delayMs: parseInt(merged.delayMs || 15000, 10)
    };
  }

  validateApiConfig(apiConfig) {
    if (!apiConfig.apiUrl) {
      return {
        ok: false,
        status: 0,
        error: "EVOLUTION_INVALID_URL",
        message: "Evolution API URL is missing."
      };
    }

    try {
      const parsed = new URL(apiConfig.apiUrl);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error("Unsupported protocol");
      }
    } catch {
      return {
        ok: false,
        status: 0,
        error: "EVOLUTION_INVALID_URL",
        message: `Invalid Evolution API URL: ${apiConfig.apiUrl}`
      };
    }

    return { ok: true };
  }

  encodeInstanceName(instanceName) {
    return encodeURIComponent(instanceName);
  }

  /**
   * Helper to perform HTTP/HTTPS requests to Evolution API.
   * Logs method, endpoint, status, safe response body, and QR field names without secrets.
   */
  async request(endpoint, method = "GET", body = null, customHeaders = {}, customConfig = null) {
    const apiConfig = this.getApiConfig(customConfig);
    const valid = this.validateApiConfig(apiConfig);
    if (!valid.ok) {
      logger.error(`[EVOLUTION] ${method} ${endpoint} | ${valid.error}: ${valid.message}`);
      return {
        status: valid.status,
        ok: false,
        error: valid.message,
        errorCode: valid.error,
        data: null,
        endpoint,
        method
      };
    }

    const fullUrl = `${apiConfig.apiUrl}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;

    return new Promise((resolve) => {
      try {
        const parsed = new URL(fullUrl);
        const mod = parsed.protocol === "https:" ? https : http;
        const headers = {
          Accept: "application/json",
          ...customHeaders
        };

        if (body !== null && body !== undefined) {
          headers["Content-Type"] = "application/json";
        }
        if (apiConfig.apiKey && !headers.apikey && !headers.ApiKey && !headers.apiKey) {
          headers.apikey = apiConfig.apiKey;
        }

        const payload = body !== null && body !== undefined ? JSON.stringify(body) : null;
        if (payload) {
          headers["Content-Length"] = Buffer.byteLength(payload);
        }

        const instance = apiConfig.instanceName ? ` | instance: ${apiConfig.instanceName}` : "";
        logger.debug(`[EVOLUTION] ${method} ${endpoint}${instance}`);

        const req = mod.request(
          fullUrl,
          {
            method,
            headers,
            timeout: this.defaultTimeout
          },
          (res) => {
            let rawBody = "";
            res.on("data", (chunk) => {
              rawBody += chunk;
            });
            res.on("end", () => {
              const parsedData = this.parseResponseBody(rawBody);
              const ok = res.statusCode >= 200 && res.statusCode < 300;
              const errorMessage = ok ? null : this.extractErrorMessage(parsedData, res.statusCode);
              const errorCode = ok ? null : this.classifyFailure(res.statusCode, errorMessage);
              const responseKeys = this.describeResponseKeys(parsedData);
              const qrFields = this.extractQrFieldNames(parsedData);

              logger.debug(`[EVOLUTION] ${method} ${endpoint} | status: ${res.statusCode} | success: ${ok}`);
              logger.debug(`[EVOLUTION] response keys: ${responseKeys.length ? responseKeys.join(",") : "(none)"}`);
              if (qrFields.length) {
                logger.debug(`[EVOLUTION] extracted QR field names: ${qrFields.join(",")}`);
              }
              logger.debug(`[EVOLUTION] response body: ${this.safeStringify(parsedData, 1200)}`);

              resolve({
                status: res.statusCode,
                ok,
                data: parsedData,
                rawBody,
                endpoint,
                method,
                error: errorMessage,
                errorCode
              });
            });
          }
        );

        req.on("error", (err) => {
          const errorCode = /timeout/i.test(err.message) ? "EVOLUTION_TIMEOUT" : "EVOLUTION_OFFLINE";
          logger.error(`[EVOLUTION] ${method} ${endpoint} | ${errorCode}: ${err.message}`);
          resolve({
            status: 0,
            ok: false,
            error: err.message || "Connection failed",
            errorCode,
            data: null,
            endpoint,
            method
          });
        });

        req.on("timeout", () => {
          req.destroy();
          logger.error(`[EVOLUTION] ${method} ${endpoint} | EVOLUTION_TIMEOUT after ${this.defaultTimeout}ms`);
          resolve({
            status: 0,
            ok: false,
            error: "Evolution API request timed out",
            errorCode: "EVOLUTION_TIMEOUT",
            data: null,
            endpoint,
            method
          });
        });

        if (payload) {
          req.write(payload);
        }
        req.end();
      } catch (err) {
        logger.error(`[EVOLUTION] ${method} ${endpoint} | Exception: ${err.message}`);
        resolve({
          status: 0,
          ok: false,
          error: err.message,
          errorCode: "EVOLUTION_OFFLINE",
          data: null,
          endpoint,
          method
        });
      }
    });
  }

  parseResponseBody(rawBody) {
    if (!rawBody) return {};
    try {
      return JSON.parse(rawBody);
    } catch {
      return { raw: rawBody };
    }
  }

  extractErrorMessage(data, statusCode) {
    const candidates = [
      data?.response?.message,
      data?.message,
      data?.error?.message,
      data?.error,
      data?.details,
      data?.raw
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      if (Array.isArray(candidate)) return candidate.join(", ");
      if (typeof candidate === "object") return this.safeStringify(candidate, 500);
      return String(candidate);
    }
    return `HTTP ${statusCode}`;
  }

  classifyFailure(status, message = "") {
    if (status === 0) return /timeout/i.test(message) ? "EVOLUTION_TIMEOUT" : "EVOLUTION_OFFLINE";
    if (status === 400) return "EVOLUTION_BAD_REQUEST";
    if (status === 401 || status === 403) return "EVOLUTION_AUTH_ERROR";
    if (status === 404) return "EVOLUTION_NOT_FOUND";
    if (status === 409) return "EVOLUTION_CONFLICT";
    if (status === 429) return "EVOLUTION_RATE_LIMIT";
    // Detect "Service Suspended" responses from Render/hosting providers
    if (status === 503 && /service suspended/i.test(message)) {
      return "EVOLUTION_SERVICE_SUSPENDED";
    }
    if (status >= 500) return "EVOLUTION_API_SERVER_ERROR";
    return "EVOLUTION_API_ERROR";
  }

  describeResponseKeys(data) {
    if (!data || typeof data !== "object") return [];
    const keys = new Set(Object.keys(data));
    if (data.data && typeof data.data === "object" && !Array.isArray(data.data)) {
      Object.keys(data.data).forEach((key) => keys.add(`data.${key}`));
    }
    if (data.instance && typeof data.instance === "object") {
      Object.keys(data.instance).forEach((key) => keys.add(`instance.${key}`));
    }
    return [...keys];
  }

  extractQrFieldNames(value, prefix = "", result = []) {
    if (!value || typeof value !== "object") return result;
    if (Array.isArray(value)) {
      value.slice(0, 3).forEach((item, index) => this.extractQrFieldNames(item, `${prefix}[${index}]`, result));
      return result;
    }

    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (QR_KEY_RE.test(key) && child !== null && child !== undefined && child !== "") {
        result.push(path);
      }
      if (child && typeof child === "object") {
        this.extractQrFieldNames(child, path, result);
      }
    }

    return [...new Set(result)];
  }

  safeStringify(value, maxLength = 1000) {
    let output;
    try {
      output = JSON.stringify(this.sanitizeForLog(value));
    } catch {
      output = String(value);
    }
    return output.length > maxLength ? `${output.slice(0, maxLength)}...` : output;
  }

  sanitizeForLog(value, depth = 0, parentKey = "") {
    if (depth > 6) return "...";
    if (value === null || value === undefined) return value;

    if (typeof value === "string") {
      if (SENSITIVE_KEY_RE.test(parentKey)) return MASKED_VALUE;
      if (QR_KEY_RE.test(parentKey)) return `${QR_VALUE}:${value.length}`;
      if (this.looksLikeLongBase64(value)) return `<base64:${value.length}>`;
      return value.length > 500 ? `${value.slice(0, 500)}...` : value;
    }

    if (typeof value !== "object") return value;
    if (Array.isArray(value)) {
      return value.slice(0, 10).map((item) => this.sanitizeForLog(item, depth + 1, parentKey));
    }

    const safe = {};
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE_KEY_RE.test(key)) {
        safe[key] = MASKED_VALUE;
      } else {
        safe[key] = this.sanitizeForLog(child, depth + 1, key);
      }
    }
    return safe;
  }

  looksLikeLongBase64(value) {
    const clean = String(value || "").replace(/\s/g, "");
    return clean.length > 300 && /^[A-Za-z0-9+/]+={0,2}$/.test(clean);
  }

  isAlreadyExistsResponse(res) {
    if (!res) return false;
    if (res.status === 409) return true;
    if (res.status === 401 || res.status === 403) return false;
    const text = `${res.error || ""} ${this.safeStringify(res.data || {}, 2000)}`.toLowerCase();
    return /already\s+(exists|exist|in use|registered|created)|instance\s+already|duplicat/.test(text);
  }

  chooseHealthFailure(results) {
    const auth = results.find((item) => item.res.status === 401 || item.res.status === 403);
    if (auth) return auth;
    const offline = results.find((item) => item.res.status === 0);
    if (offline) return offline;
    const unavailable = results.find((item) => [502, 503, 504].includes(item.res.status));
    if (unavailable) return unavailable;
    const server = results.find((item) => item.res.status >= 500);
    if (server) return server;
    const badRequest = results.find((item) => item.res.status === 400);
    if (badRequest) return badRequest;
    const notFound = results.find((item) => item.res.status === 404 || item.res.status === 405);
    if (notFound) return notFound;
    return results[0];
  }

  async checkHealth(customConfig = null) {
    const apiConfig = this.getApiConfig(customConfig);
    const valid = this.validateApiConfig(apiConfig);
    if (!valid.ok) {
      return {
        online: false,
        authenticated: false,
        version: null,
        profile: null,
        apiUrl: apiConfig.apiUrl,
        instanceName: apiConfig.instanceName,
        status: 0,
        error: valid.error,
        message: valid.message
      };
    }

    if (!apiConfig.apiKey) {
      return {
        online: false,
        authenticated: false,
        version: null,
        profile: null,
        apiUrl: apiConfig.apiUrl,
        instanceName: apiConfig.instanceName,
        status: 0,
        error: "EVOLUTION_MISSING_API_KEY",
        message: "Evolution API key is missing."
      };
    }

    const probes = [
      { profile: PROFILE_GO, endpoint: "/instance/all", version: "Evolution Go" },
      { profile: PROFILE_V2, endpoint: "/instance/fetchInstances", version: "Evolution API v2" }
    ];
    const results = [];

    for (const probe of probes) {
      const res = await this.request(probe.endpoint, "GET", null, {}, apiConfig);
      results.push({ probe, res });
      if (res.ok) {
        const version = this.detectVersion(res.data, probe.version);
        this.lastProfile = probe.profile;
        logger.info(`[EVOLUTION] Health check passed via ${probe.endpoint} (${probe.profile})`);
        return {
          online: true,
          authenticated: true,
          version,
          profile: probe.profile,
          apiUrl: apiConfig.apiUrl,
          instanceName: apiConfig.instanceName,
          status: res.status,
          endpoint: probe.endpoint,
          data: res.data
        };
      }
    }

    const failure = this.chooseHealthFailure(results);
    const status = failure?.res?.status || 0;
    const errorCode = status === 404 || status === 405
      ? "EVOLUTION_ENDPOINT_NOT_FOUND"
      : failure?.res?.errorCode || this.classifyFailure(status, failure?.res?.error);
    const online = status > 0 && ![502, 503, 504].includes(status);
    const message = failure?.res?.error || "Evolution API health check failed";

    logger.warn(`[EVOLUTION] Health check failed | status: ${status} | error: ${errorCode} | message: ${message}`);
    return {
      online,
      authenticated: false,
      version: null,
      profile: failure?.probe?.profile || null,
      apiUrl: apiConfig.apiUrl,
      instanceName: apiConfig.instanceName,
      status,
      endpoint: failure?.probe?.endpoint || null,
      error: errorCode,
      message,
      diagnostics: results.map((item) => ({
        profile: item.probe.profile,
        endpoint: item.probe.endpoint,
        status: item.res.status,
        error: item.res.errorCode || item.res.error
      }))
    };
  }

  detectVersion(data, fallback) {
    return (
      data?.version ||
      data?.clientVersion ||
      data?.client_name ||
      data?.clientName ||
      data?.name ||
      fallback
    );
  }

  async testConnection(apiUrl, apiKey, instanceName) {
    const customConfig = { apiUrl, apiKey, instanceName };
    const health = await this.checkHealth(customConfig);

    if (!health.authenticated) {
      return {
        success: false,
        error: this.humanizeError(health.error, health.status, health.message),
        errorCode: health.error,
        status: health.status,
        online: health.online,
        authenticated: false,
        version: health.version,
        profile: health.profile
      };
    }

    const state = await this.getConnectionState(instanceName, customConfig, health.profile);
    return {
      success: true,
      version: health.version,
      profile: health.profile,
      online: true,
      authenticated: true,
      instanceName,
      connected: state.connected,
      state: state.state,
      message: `Successfully authenticated with ${health.version || "Evolution API"}. Instance "${instanceName}": ${state.state || "UNKNOWN"}`
    };
  }

  async getInstances(customConfig = null, profile = null) {
    const apiConfig = this.getApiConfig(customConfig);
    const selectedProfile = profile || this.lastProfile || PROFILE_GO;
    const endpoint = selectedProfile === PROFILE_GO ? "/instance/all" : "/instance/fetchInstances";
    const res = await this.request(endpoint, "GET", null, {}, apiConfig);
    return {
      ...res,
      profile: selectedProfile,
      instances: res.ok ? this.normalizeInstances(res.data) : []
    };
  }

  normalizeInstances(data) {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.data)) return data.data;
    if (Array.isArray(data.instances)) return data.instances;
    if (Array.isArray(data.instance)) return data.instance;
    if (data.instance && typeof data.instance === "object") return [data.instance];
    if (data.data && typeof data.data === "object") return [data.data];
    return [];
  }

  findInstance(instances, instanceName) {
    const requested = String(instanceName || "").toLowerCase();
    return instances.find((item) => {
      const name = this.extractInstanceName(item);
      return name && String(name).toLowerCase() === requested;
    }) || null;
  }

  extractInstanceName(instance) {
    return (
      instance?.name ||
      instance?.instanceName ||
      instance?.instance_name ||
      instance?.instance?.instanceName ||
      instance?.instance?.name ||
      instance?.data?.name ||
      instance?.data?.instanceName ||
      null
    );
  }

  extractInstanceId(instance, fallbackName = null) {
    return (
      instance?.id ||
      instance?._id ||
      instance?.instanceId ||
      instance?.instance_id ||
      instance?.instance?.id ||
      instance?.instance?.instanceId ||
      fallbackName
    );
  }

  extractInstanceToken(instance, fallback = "") {
    return (
      instance?.token ||
      instance?.apikey ||
      instance?.apiKey ||
      instance?.instance?.token ||
      instance?.instance?.apikey ||
      instance?.data?.token ||
      fallback ||
      ""
    );
  }

  async createInstance(customInstanceName = null, customConfig = null, profile = null) {
    const apiConfig = this.getApiConfig(customConfig);
    const name = customInstanceName || apiConfig.instanceName;
    const selectedProfile = profile || this.lastProfile || PROFILE_GO;

    if (!apiConfig.apiKey) {
      return {
        status: 0,
        ok: false,
        existing: false,
        error: "Evolution API key is missing.",
        errorCode: "EVOLUTION_MISSING_API_KEY",
        data: null
      };
    }

    const goPayloads = [
      { name, token: apiConfig.apiKey },
      {
        instanceName: name,
        token: apiConfig.apiKey,
        qrcode: false,
        integration: "WHATSAPP-BAILEYS"
      }
    ];
    const v2Payloads = [
      {
        instanceName: name,
        token: apiConfig.apiKey,
        qrcode: true,
        integration: "WHATSAPP-BAILEYS"
      }
    ];
    const payloads = selectedProfile === PROFILE_GO ? goPayloads : v2Payloads;

    let lastRes = null;
    for (const payload of payloads) {
      const res = await this.request("/instance/create", "POST", payload, {}, apiConfig);
      lastRes = res;

      if (res.ok) {
        logger.info(`[EVOLUTION] Instance created successfully: ${name}`);
        return {
          status: res.status,
          ok: true,
          existing: false,
          data: res.data,
          error: null,
          errorCode: null,
          profile: selectedProfile,
          instanceToken: this.extractInstanceToken(res.data, apiConfig.apiKey)
        };
      }

      if (this.isAlreadyExistsResponse(res)) {
        logger.info(`[EVOLUTION] Instance already exists: ${name} (HTTP ${res.status})`);
        return {
          status: res.status,
          ok: true,
          existing: true,
          data: res.data,
          error: res.error,
          errorCode: res.errorCode,
          profile: selectedProfile,
          instanceToken: apiConfig.apiKey
        };
      }

      if (res.status === 400 || res.status === 404 || res.status === 405) {
        continue;
      }

      break;
    }

    logger.error(`[EVOLUTION] Failed to create instance "${name}": HTTP ${lastRes?.status || 0} ${lastRes?.error || ""}`);
    return {
      status: lastRes?.status || 0,
      ok: false,
      existing: false,
      error: lastRes?.error || "Instance creation failed",
      errorCode: lastRes?.errorCode || "INSTANCE_CREATE_FAILED",
      data: lastRes?.data || null,
      profile: selectedProfile
    };
  }

  setSimulatedConnected(connected = true) {
    this.isSimulatedConnected = Boolean(connected);
    return this.isSimulatedConnected;
  }

  async getConnectionState(customInstanceName = null, customConfig = null, profile = null, knownInstance = null) {
    if (this.isSimulatedConnected) {
      return {
        ok: true,
        exists: true,
        connected: true,
        state: "CONNECTED",
        profile: profile || this.lastProfile,
        data: { state: "open", simulated: true }
      };
    }

    const apiConfig = this.getApiConfig(customConfig);
    const name = customInstanceName || apiConfig.instanceName;
    const selectedProfile = profile || this.lastProfile || PROFILE_GO;

    if (selectedProfile === PROFILE_GO) {
      let instance = knownInstance;
      if (!instance) {
        const instancesRes = await this.getInstances(apiConfig, PROFILE_GO);
        if (instancesRes.status === 401 || instancesRes.status === 403) {
          return this.stateFailure(instancesRes, "EVOLUTION_AUTH_ERROR");
        }
        instance = instancesRes.ok ? this.findInstance(instancesRes.instances, name) : null;
      }

      const instanceToken = this.extractInstanceToken(instance, apiConfig.apiKey);
      const pathName = this.encodeInstanceName(name);
      const attempts = [
        instanceToken ? { endpoint: "/instance/status", apiKey: instanceToken } : null,
        { endpoint: `/instance/${pathName}/status`, apiKey: apiConfig.apiKey }
      ].filter(Boolean);

      let lastRes = null;
      for (const attempt of attempts) {
        const res = await this.request(attempt.endpoint, "GET", null, {}, { ...apiConfig, apiKey: attempt.apiKey });
        lastRes = res;
        if (res.ok) {
          const parsed = this.parseConnectionState(res.data, instance);
          return {
            ok: true,
            exists: true,
            connected: parsed.connected,
            state: parsed.state,
            status: res.status,
            profile: PROFILE_GO,
            data: res.data,
            instance,
            instanceToken
          };
        }
        if (res.status === 401 || res.status === 403) {
          continue;
        }
        if (res.status !== 404 && res.status !== 405) {
          break;
        }
      }

      if (instance) {
        const parsed = this.parseConnectionState(instance);
        return {
          ok: true,
          exists: true,
          connected: parsed.connected,
          state: parsed.state,
          status: lastRes?.status || 200,
          profile: PROFILE_GO,
          data: instance,
          instance,
          instanceToken
        };
      }

      if (lastRes?.status === 401 || lastRes?.status === 403) {
        return this.stateFailure(lastRes, "EVOLUTION_AUTH_ERROR");
      }

      return {
        ok: true,
        exists: false,
        connected: false,
        state: "NOT_CREATED",
        status: lastRes?.status || 404,
        profile: PROFILE_GO,
        data: lastRes?.data || null
      };
    }

    const res = await this.request(`/instance/connectionState/${this.encodeInstanceName(name)}`, "GET", null, {}, apiConfig);
    if (res.ok) {
      const parsed = this.parseConnectionState(res.data);
      return {
        ok: true,
        exists: true,
        connected: parsed.connected,
        state: parsed.state,
        status: res.status,
        profile: PROFILE_V2,
        data: res.data
      };
    }

    if (res.status === 404) {
      return {
        ok: true,
        exists: false,
        connected: false,
        state: "NOT_CREATED",
        status: 404,
        profile: PROFILE_V2,
        data: res.data
      };
    }

    return this.stateFailure(res);
  }

  stateFailure(res, forcedError = null) {
    return {
      ok: false,
      exists: false,
      connected: false,
      state: "DISCONNECTED",
      status: res.status,
      error: forcedError || res.errorCode || res.error,
      details: res.error,
      data: res.data
    };
  }

  parseConnectionState(data, fallbackInstance = null) {
    const source = data || fallbackInstance || {};
    const nested = source.instance || source.data || source;
    const rawState =
      nested.state ||
      nested.status ||
      nested.connectionStatus ||
      source.state ||
      source.status ||
      source.connectionStatus ||
      null;
    const connectedFlag =
      nested.connected ??
      nested.loggedIn ??
      source.connected ??
      source.loggedIn ??
      null;
    const jid = nested.jid || source.jid || nested.ownerJid || source.ownerJid || null;

    let state = rawState ? String(rawState).toUpperCase() : null;
    if (!state) {
      if (connectedFlag === true && jid) state = "CONNECTED";
      else if (connectedFlag === true) state = "CONNECTING";
      else state = "DISCONNECTED";
    }

    if (state === "OPEN") {
      return { connected: true, state: "OPEN" };
    }
    if (state === "CONNECTED" || state === "ONLINE" || state === "LOGGED_IN") {
      return { connected: true, state: "CONNECTED" };
    }
    if (connectedFlag === true && state !== "CLOSE" && state !== "DISCONNECTED") {
      return { connected: true, state };
    }
    return { connected: false, state: state || "DISCONNECTED" };
  }

  async getQrCode(customInstanceName = null) {
    const apiConfig = this.getApiConfig();
    const name = customInstanceName || apiConfig.instanceName;

    logger.info(`[EVOLUTION] QR code request for instance: ${name}`);

    const health = await this.checkHealth(apiConfig);
    if (!health.authenticated) {
      return {
        ok: false,
        success: false,
        error: health.error,
        status: health.status,
        details: this.humanizeError(health.error, health.status, health.message),
        profile: health.profile,
        version: health.version,
        instanceName: name
      };
    }

    const instancesRes = await this.getInstances(apiConfig, health.profile);
    if (!instancesRes.ok) {
      return this.toQrFailure(instancesRes, "INSTANCE_LOOKUP_FAILED", name, health);
    }

    let instance = this.findInstance(instancesRes.instances, name);
    let stateRes = await this.getConnectionState(name, apiConfig, health.profile, instance);

    if (!stateRes.ok && (stateRes.status === 401 || stateRes.status === 403 || stateRes.error === "EVOLUTION_AUTH_ERROR")) {
      return {
        ok: false,
        success: false,
        error: "EVOLUTION_AUTH_ERROR",
        status: stateRes.status,
        details: this.humanizeError("EVOLUTION_AUTH_ERROR", stateRes.status, stateRes.details),
        profile: health.profile,
        version: health.version,
        instanceName: name
      };
    }

    if (stateRes.connected) {
      logger.info(`[EVOLUTION] Instance already connected: ${name}`);
      return {
        ok: true,
        success: true,
        connected: true,
        instanceName: name,
        qrcode: null,
        pairingCode: null,
        profile: health.profile,
        version: health.version,
        message: `WhatsApp instance "${name}" is already connected.`
      };
    }

    // If instance exists but is in 'close' or DISCONNECTED state, it needs to be recreated
    // because the QR code has expired and WhatsApp can't link to it
    const staleStates = ["close", "CLOSED", "DISCONNECTED", "DISCONNECT"];
    const needsRecreate = stateRes.exists && stateRes.state && staleStates.includes(stateRes.state.toUpperCase());

    if (needsRecreate) {
      logger.info(`[EVOLUTION] Instance "${name}" is in stale state "${stateRes.state}". Deleting and recreating...`);
      try {
        await this.deleteInstance(name);
      } catch (e) {
        logger.warn(`[EVOLUTION] Could not delete stale instance: ${e.message}`);
      }
      // Mark as not existing so it gets recreated
      stateRes = { ...stateRes, exists: false };
    }

    if (!stateRes.exists) {
      const createRes = await this.createInstance(name, apiConfig, health.profile);
      if (!createRes.ok) {
        return this.toQrFailure(createRes, "INSTANCE_CREATE_FAILED", name, health);
      }

      const qrFromCreate = await this.normalizeQrResponse(createRes.data, name);
      if (qrFromCreate) {
        return {
          ok: true,
          success: true,
          connected: false,
          profile: health.profile,
          version: health.version,
          ...qrFromCreate
        };
      }

      const refreshed = await this.getInstances(apiConfig, health.profile);
      instance = refreshed.ok ? this.findInstance(refreshed.instances, name) : null;
      stateRes = await this.getConnectionState(name, apiConfig, health.profile, instance);
    }

    const instanceToken = stateRes.instanceToken || this.extractInstanceToken(instance, apiConfig.apiKey);
    const qrRes = await this.requestQrFromEvolution(name, health.profile, apiConfig, instanceToken);

    if (qrRes.ok) {
      return {
        ok: true,
        success: true,
        connected: qrRes.connected || false,
        profile: health.profile,
        version: health.version,
        ...qrRes
      };
    }

    return {
      ok: false,
      success: false,
      error: qrRes.error,
      status: qrRes.status,
      details: qrRes.details,
      profile: health.profile,
      version: health.version,
      instanceName: name
    };
  }

  async requestQrFromEvolution(instanceName, profile, apiConfig, instanceToken = "") {
    const pathName = this.encodeInstanceName(instanceName);
    const isGo = profile === PROFILE_GO;
    const attempts = isGo
      ? [
          { endpoint: `/instance/${pathName}/qrcode`, method: "GET", apiKey: apiConfig.apiKey, label: "go-path-qrcode" },
          { endpoint: "/instance/connect", method: "POST", apiKey: instanceToken || apiConfig.apiKey, label: "go-connect" },
          { endpoint: "/instance/qr", method: "GET", apiKey: instanceToken || apiConfig.apiKey, label: "go-qr" }
        ]
      : [
          { endpoint: `/instance/connect/${pathName}`, method: "GET", apiKey: apiConfig.apiKey, label: "v2-connect" },
          { endpoint: `/instance/${pathName}/qrcode`, method: "GET", apiKey: apiConfig.apiKey, label: "v2-qrcode" }
        ];

    let bestError = null;
    let qrMissing = null;

    for (const attempt of attempts) {
      const res = await this.request(attempt.endpoint, attempt.method, null, {}, { ...apiConfig, apiKey: attempt.apiKey });

      if (res.ok) {
        const normalized = await this.normalizeQrResponse(res.data, instanceName);
        if (normalized) {
          logger.info(`[EVOLUTION] QR code obtained from ${attempt.label} for ${instanceName}`);
          return {
            ok: true,
            status: res.status,
            endpoint: attempt.endpoint,
            instanceName,
            ...normalized
          };
        }

        const state = this.parseConnectionState(res.data);
        if (state.connected) {
          return {
            ok: true,
            status: res.status,
            endpoint: attempt.endpoint,
            connected: true,
            instanceName,
            qrcode: null,
            pairingCode: null,
            message: `WhatsApp instance "${instanceName}" is already connected.`
          };
        }

        qrMissing = res;
        if (attempt.label === "go-connect") {
          await this.sleep(750);
        }
        continue;
      }

      if (res.status === 401 || res.status === 403) {
        bestError = bestError || res;
        continue;
      }

      if (res.status === 404 || res.status === 405) {
        bestError = bestError || res;
        continue;
      }

      bestError = res;
    }

    if (qrMissing) {
      return {
        ok: false,
        status: qrMissing.status,
        error: "QR_NOT_AVAILABLE",
        details: `Evolution API returned no usable QR fields. Safe diagnostics: ${this.safeStringify(qrMissing.data, 700)}`,
        instanceName
      };
    }

    if (!bestError) {
      return {
        ok: false,
        status: 0,
        error: "QR_GENERATION_FAILED",
        details: "Evolution API did not return a QR response.",
        instanceName
      };
    }

    return {
      ok: false,
      status: bestError.status,
      error: bestError.errorCode || this.classifyFailure(bestError.status, bestError.error),
      details: this.humanizeError(bestError.errorCode, bestError.status, bestError.error),
      instanceName
    };
  }

  toQrFailure(res, fallbackCode, instanceName, health = {}) {
    const errorCode = res.errorCode || res.error || fallbackCode;
    return {
      ok: false,
      success: false,
      error: errorCode,
      status: res.status || 0,
      details: this.humanizeError(errorCode, res.status, res.error || res.details),
      profile: res.profile || health.profile,
      version: health.version,
      instanceName
    };
  }

  async normalizeQrResponse(data, instanceName) {
    if (!data) return null;

    const qrCandidates = [
      ["qrcode.base64", this.getPath(data, "qrcode.base64")],
      ["qrcode.qrcode", this.getPath(data, "qrcode.qrcode")],
      ["qrcode.code", this.getPath(data, "qrcode.code")],
      ["qr.base64", this.getPath(data, "qr.base64")],
      ["base64", data.base64],
      ["qrcode", data.qrcode],
      ["qrCode", data.qrCode],
      ["code", data.code],
      ["data.qrcode.base64", this.getPath(data, "data.qrcode.base64")],
      ["data.qrcode", this.getPath(data, "data.qrcode")],
      ["data.base64", this.getPath(data, "data.base64")],
      ["data.code", this.getPath(data, "data.code")],
      ["response.qrcode.base64", this.getPath(data, "response.qrcode.base64")],
      ["response.qrcode", this.getPath(data, "response.qrcode")],
      ["response.base64", this.getPath(data, "response.base64")],
      ["response.code", this.getPath(data, "response.code")]
    ];

    const pairingCandidates = [
      data.pairingCode,
      data.pairing_code,
      this.getPath(data, "data.pairingCode"),
      this.getPath(data, "data.pairing_code"),
      this.getPath(data, "response.pairingCode"),
      this.getPath(data, "response.pairing_code")
    ];

    let pairingCode = pairingCandidates.find((value) => typeof value === "string" && value.trim().length > 0) || null;
    let formattedQr = null;
    let sourceField = null;

    for (const [field, value] of qrCandidates) {
      if (typeof value !== "string" || !value.trim()) continue;

      const trimmed = value.trim();
      if (field.endsWith(".code") || field === "code" || field === "data.code" || field === "response.code") {
        if (!pairingCode && trimmed.length <= 24 && /^[A-Z0-9-]+$/i.test(trimmed)) {
          pairingCode = trimmed;
          continue;
        }
      }

      formattedQr = await this.formatQrValue(trimmed, field);
      if (formattedQr) {
        sourceField = field;
        break;
      }
    }

    if (!formattedQr && !pairingCode) {
      logger.warn(`[EVOLUTION] No QR or pairing code in response. Keys: ${this.describeResponseKeys(data).join(",")}`);
      return null;
    }

    logger.debug(`[EVOLUTION] QR normalized | source: ${sourceField || "pairing-code-only"} | qrcode: ${formattedQr ? "present" : "null"} | pairingCode: ${pairingCode ? "present" : "null"}`);
    return {
      success: true,
      connected: false,
      instanceName,
      qrcode: formattedQr,
      pairingCode,
      message: formattedQr ? "Scan the QR code with WhatsApp" : "Use the pairing code in WhatsApp"
    };
  }

  getPath(value, path) {
    return path.split(".").reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), value);
  }

  async formatQrValue(value, sourceField) {
    if (!value) return null;
    if (/^data:image\//i.test(value)) return value;
    if (/^https?:\/\//i.test(value)) return value;

    const trimmed = value.trim();
    if (/^<svg[\s>]/i.test(trimmed)) {
      return `data:image/svg+xml;base64,${Buffer.from(trimmed, "utf8").toString("base64")}`;
    }

    const imageMime = this.detectBase64ImageMime(trimmed);
    if (imageMime) {
      return `data:${imageMime};base64,${trimmed}`;
    }

    const sourceAllowsRawQr = /(^|\.)(qrcode|qr|qrCode|code)$/i.test(sourceField);
    if (sourceAllowsRawQr && trimmed.length > 10) {
      return QRCode.toDataURL(trimmed, {
        type: "image/png",
        width: 256,
        margin: 1,
        errorCorrectionLevel: "M"
      });
    }

    return null;
  }

  detectBase64ImageMime(value) {
    const clean = value.replace(/\s/g, "");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean) || clean.length < 40) return null;

    try {
      const buffer = Buffer.from(clean, "base64");
      if (buffer.length < 8) return null;
      if (buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return "image/png";
      }
      if (buffer.slice(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
        return "image/jpeg";
      }
      if (buffer.slice(0, 6).toString("ascii") === "GIF87a" || buffer.slice(0, 6).toString("ascii") === "GIF89a") {
        return "image/gif";
      }
      const text = buffer.slice(0, 80).toString("utf8").trimStart();
      if (text.startsWith("<svg")) {
        return "image/svg+xml";
      }
    } catch {
      return null;
    }

    return null;
  }

  normalizeSendNumber(phone) {
    if (!phone) return null;
    let clean = String(phone).replace(/\D/g, "");
    clean = clean.replace(/^0+/, "");

    if (clean.length === 10 && /^[6-9]/.test(clean)) {
      clean = `91${clean}`;
    }

    if (clean.length < 10 || clean.length > 15) {
      return null;
    }

    return clean;
  }

  async sendTextMessage(phone, messageText, customInstanceName = null) {
    const apiConfig = this.getApiConfig();
    const name = customInstanceName || apiConfig.instanceName;

    const cleanNumber = this.normalizeSendNumber(phone);
    if (!cleanNumber) {
      return {
        ok: false,
        error: `Invalid phone number format: ${phone}. Must be a valid mobile number with country code.`
      };
    }

    if (apiConfig.dryRun) {
      logger.info(`[WhatsApp DRY RUN] Would send to +${cleanNumber}:\n${messageText}`);
      return {
        ok: true,
        dryRun: true,
        messageId: `dry_run_${Date.now()}`,
        message: `Message simulated to +${cleanNumber} (DRY RUN active)`
      };
    }

    const health = await this.checkHealth(apiConfig);
    if (!health.authenticated) {
      return {
        ok: false,
        error: this.humanizeError(health.error, health.status, health.message),
        errorCode: health.error,
        status: health.status
      };
    }

    const payload = {
      number: cleanNumber,
      text: messageText,
      delay: 1200,
      linkPreview: true
    };

    let res;
    if (health.profile === PROFILE_GO) {
      const state = await this.getConnectionState(name, apiConfig, PROFILE_GO);
      const instanceToken = state.instanceToken || apiConfig.apiKey;
      res = await this.request("/send/text", "POST", payload, {}, { ...apiConfig, apiKey: instanceToken });
      if (!res.ok && (res.status === 404 || res.status === 405)) {
        res = await this.request(`/message/sendText/${this.encodeInstanceName(name)}`, "POST", payload, {}, apiConfig);
      }
    } else {
      res = await this.request(`/message/sendText/${this.encodeInstanceName(name)}`, "POST", payload, {}, apiConfig);
    }

    if (res.ok && res.data) {
      const msgId = res.data.key?.id || res.data.messageId || res.data.id || `msg_${Date.now()}`;
      return {
        ok: true,
        dryRun: false,
        messageId: msgId,
        data: res.data
      };
    }

    return {
      ok: false,
      status: res.status,
      errorCode: res.errorCode,
      error: res.error || "Failed to send WhatsApp message through Evolution API"
    };
  }

  async logoutInstance(customInstanceName = null) {
    const apiConfig = this.getApiConfig();
    const name = customInstanceName || apiConfig.instanceName;
    this.isSimulatedConnected = false;

    const health = await this.checkHealth(apiConfig);
    if (health.profile === PROFILE_GO && health.authenticated) {
      const state = await this.getConnectionState(name, apiConfig, PROFILE_GO);
      const instanceToken = state.instanceToken || apiConfig.apiKey;
      const goLogout = await this.request("/instance/logout", "DELETE", null, {}, { ...apiConfig, apiKey: instanceToken });
      if (goLogout.ok || (goLogout.status !== 404 && goLogout.status !== 405)) {
        return goLogout;
      }
    }

    return this.request(`/instance/logout/${this.encodeInstanceName(name)}`, "DELETE", null, {}, apiConfig);
  }

  async deleteInstance(customInstanceName = null) {
    const apiConfig = this.getApiConfig();
    const name = customInstanceName || apiConfig.instanceName;
    this.isSimulatedConnected = false;

    const health = await this.checkHealth(apiConfig);
    if (health.profile === PROFILE_GO && health.authenticated) {
      const instancesRes = await this.getInstances(apiConfig, PROFILE_GO);
      const instance = instancesRes.ok ? this.findInstance(instancesRes.instances, name) : null;
      const id = this.extractInstanceId(instance, name);
      const goDelete = await this.request(`/instance/delete/${this.encodeInstanceName(String(id))}`, "DELETE", null, {}, apiConfig);
      if (goDelete.ok || (goDelete.status !== 404 && goDelete.status !== 405)) {
        return goDelete;
      }
    }

    return this.request(`/instance/delete/${this.encodeInstanceName(name)}`, "DELETE", null, {}, apiConfig);
  }

  async checkNumber(phone, customInstanceName = null) {
    const apiConfig = this.getApiConfig();
    const name = customInstanceName || apiConfig.instanceName;
    const cleanNumber = this.normalizeSendNumber(phone);
    if (!cleanNumber) return { checked: false, exists: "unknown" };

    try {
      const res = await this.request(`/chat/whatsappNumbers/${this.encodeInstanceName(name)}`, "POST", {
        numbers: [cleanNumber]
      }, {}, apiConfig);

      if (res.ok && Array.isArray(res.data) && res.data.length > 0) {
        const item = res.data[0];
        return {
          checked: true,
          exists: item.exists === true || item.isBusiness === true,
          jid: item.jid || null
        };
      }
    } catch {}

    return {
      checked: false,
      exists: "unknown"
    };
  }

  humanizeError(errorCode, status = 0, message = "") {
    const suffix = message ? ` ${message}` : "";
    switch (errorCode) {
      case "EVOLUTION_INVALID_URL":
        return message || "Invalid Evolution API URL.";
      case "EVOLUTION_MISSING_API_KEY":
        return "Missing Evolution API key. Configure EVOLUTION_API_KEY or save it in Settings.";
      case "EVOLUTION_AUTH_ERROR":
        return `Evolution API authentication failed${status ? ` (HTTP ${status})` : ""}.${suffix}`;
      case "EVOLUTION_SERVICE_SUSPENDED":
        return "Evolution API service has been suspended by its hosting provider. Re-deploy or restore the service in your Render dashboard.";
      case "EVOLUTION_OFFLINE":
        return `Evolution API is unreachable${status ? ` (HTTP ${status})` : ""}.${suffix}`;
      case "EVOLUTION_TIMEOUT":
        return "Evolution API request timed out.";
      case "EVOLUTION_ENDPOINT_NOT_FOUND":
        return "Evolution API endpoint was not found. The configured service may not match Evolution Go/API v2.";
      case "EVOLUTION_BAD_REQUEST":
        return `Evolution API rejected the request${status ? ` (HTTP ${status})` : ""}.${suffix}`;
      case "EVOLUTION_RATE_LIMIT":
        return "Evolution API rate limit reached. Try again later.";
      case "EVOLUTION_API_SERVER_ERROR":
        return `Evolution API server error${status ? ` (HTTP ${status})` : ""}.${suffix}`;
      case "INSTANCE_CREATE_FAILED":
        return `WhatsApp instance creation failed.${suffix}`;
      case "INSTANCE_LOOKUP_FAILED":
        return `WhatsApp instance lookup failed.${suffix}`;
      case "QR_NOT_AVAILABLE":
        return `Evolution API did not return a usable QR code.${suffix}`;
      default:
        return message || errorCode || "Evolution API request failed.";
    }
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = new EvolutionGoClient();
