const express = require("express");
const https = require("https");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { URL } = require("url");

const app = express();
app.use(express.json({limit: '10mb'}));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const LOG_DIR = path.join(__dirname, "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

const REQUEST_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 5;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;
const TRANSIENT_CODES = new Set([429, 502, 503, 504]);
const TRANSIENT_ERRORS = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN",
]);

// ---------------------------------------------------------------------------
// Structured JSONL logger
// ---------------------------------------------------------------------------
const logStream = fs.createWriteStream(
  path.join(LOG_DIR, `app-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`),
  { flags: "a" }
);

function log(entry) {
  const line = { timestamp: new Date().toISOString(), ...entry };
  logStream.write(JSON.stringify(line) + "\n");
}

function redactToken(token) {
  if (!token || token.length < 8) return "***";
  return token.slice(0, 4) + "..." + token.slice(-4);
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------
function classifyError(err) {
  const code = err.code || "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN")
    return { errorCode: "DNS_FAILURE", message: `DNS lookup failed for host: ${err.hostname || "unknown"}` };
  if (code === "ECONNREFUSED")
    return { errorCode: "CONN_REFUSED", message: `Connection refused by ${err.address || "host"}:${err.port || ""}` };
  if (code === "ECONNRESET" || code === "EPIPE")
    return { errorCode: "CONN_RESET", message: "Connection was reset by UISP server" };
  if (code === "ETIMEDOUT" || code === "TIMEOUT")
    return { errorCode: "TIMEOUT", message: `Request timed out after ${REQUEST_TIMEOUT_MS}ms` };
  if (code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || code === "SELF_SIGNED_CERT_IN_CHAIN")
    return { errorCode: "TLS_CERT", message: 'TLS certificate rejected. Enable "Skip TLS verification" for self-signed certs.' };
  if (code.startsWith("ERR_TLS") || code.startsWith("SSL"))
    return { errorCode: "TLS_ERROR", message: `TLS handshake failed: ${err.message}` };
  return { errorCode: "NETWORK_ERROR", message: err.message };
}

function classifyUispStatus(status) {
  if (status === 401) return { errorCode: "UISP_UNAUTHORIZED", message: "Invalid or expired API token" };
  if (status === 403) return { errorCode: "UISP_FORBIDDEN", message: "Token lacks required permissions (need Admin or Super Admin for deletes)" };
  if (status === 404) return { errorCode: "UISP_NOT_FOUND", message: "Resource not found (check UISP version and API path)" };
  if (status === 400) return { errorCode: "UISP_BAD_REQUEST", message: "UISP rejected the request parameters" };
  if (status === 422) return { errorCode: "UISP_VALIDATION", message: "UISP validation error" };
  if (status >= 500) return { errorCode: "UISP_SERVER_ERROR", message: `UISP internal error (${status})` };
  return { errorCode: "UISP_ERROR", message: `Unexpected UISP response (${status})` };
}

function isTransient(err, status) {
  if (err && TRANSIENT_ERRORS.has(err.code)) return true;
  if (status && TRANSIENT_CODES.has(status)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Consistent error response envelope
// ---------------------------------------------------------------------------
function errorResponse(res, httpStatus, errorCode, message, context) {
  return res.status(httpStatus).json({
    ok: false,
    errorCode,
    message,
    ...(context ? { context } : {}),
  });
}

// ---------------------------------------------------------------------------
// UISP request with redirects, timeout, and retries
// ---------------------------------------------------------------------------
function rawRequest(method, urlStr, token, skipTls, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;

    const opts = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        Accept: "application/json",
        "x-auth-token": token,
      },
      rejectUnauthorized: !skipTls,
      timeout: timeoutMs,
    };

    let payload;
    if (body) {
      payload = JSON.stringify(body);
      opts.headers["Content-Type"] = "application/json";
      opts.headers["Content-Length"] = Buffer.byteLength(payload);
    }

    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        let json;
        try { json = JSON.parse(raw); } catch { json = raw; }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data: json,
        });
      });
    });

    req.on("timeout", () => {
      req.destroy();
      const err = new Error(`Request timed out after ${timeoutMs}ms`);
      err.code = "TIMEOUT";
      reject(err);
    });

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function uispRequest(method, baseUrl, apiPath, token, skipTls, body, requestId) {
  let currentUrl = new URL(apiPath, baseUrl).toString();
  let redirectCount = 0;
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    redirectCount = 0;
    let effectiveUrl = currentUrl;

    try {
      while (true) {
        const start = Date.now();
        const r = await rawRequest(method, effectiveUrl, token, skipTls, body, REQUEST_TIMEOUT_MS);
        const durationMs = Date.now() - start;

        log({
          event: "uisp_response",
          requestId,
          method,
          url: effectiveUrl,
          attempt,
          status: r.status,
          durationMs,
        });

        if ([301, 302, 307, 308].includes(r.status)) {
          redirectCount++;
          if (redirectCount > MAX_REDIRECTS) {
            return {
              status: r.status,
              data: null,
              errorCode: "REDIRECT_LIMIT",
              message: `Exceeded ${MAX_REDIRECTS} redirects`,
            };
          }
          const location = r.headers.location;
          if (!location) {
            return {
              status: r.status,
              data: null,
              errorCode: "REDIRECT_NO_LOCATION",
              message: "Redirect response missing Location header",
            };
          }
          effectiveUrl = new URL(location, effectiveUrl).toString();
          log({ event: "uisp_redirect", requestId, attempt, redirectCount, to: effectiveUrl });
          continue;
        }

        if (isTransient(null, r.status) && attempt < MAX_RETRIES) {
          const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
          log({ event: "uisp_retry", requestId, attempt, reason: `status_${r.status}`, delayMs: delay });
          await sleep(delay);
          break;
        }

        return { status: r.status, data: r.data };
      }
    } catch (err) {
      lastErr = err;
      log({
        event: "uisp_error",
        requestId,
        method,
        url: effectiveUrl,
        attempt,
        errorCode: err.code || "UNKNOWN",
        message: err.message,
      });

      if (isTransient(err) && attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
        log({ event: "uisp_retry", requestId, attempt, reason: err.code, delayMs: delay });
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }

  if (lastErr) throw lastErr;
  return { status: 0, data: null, errorCode: "MAX_RETRIES", message: "All retry attempts exhausted" };
}

// ---------------------------------------------------------------------------
// POST /api/connect/test
// ---------------------------------------------------------------------------
app.post("/api/connect/test", async (req, res) => {
  const { baseUrl, token, skipTls } = req.body;
  const requestId = crypto.randomUUID();

  if (!baseUrl || !token) {
    return errorResponse(res, 400, "VALIDATION", "baseUrl and token are required");
  }

  log({ event: "route_start", requestId, route: "/api/connect/test", baseUrl, token: redactToken(token) });

  try {
    const r = await uispRequest("GET", baseUrl, "/nms/api/v2.1/devices", token, skipTls, null, requestId);

    if (r.errorCode) {
      log({ event: "route_end", requestId, ok: false, errorCode: r.errorCode });
      return res.json({ ok: false, errorCode: r.errorCode, message: r.message });
    }

    if (r.status === 200) {
      log({ event: "route_end", requestId, ok: true });
      return res.json({ ok: true, message: "Connected successfully" });
    }

    const classified = classifyUispStatus(r.status);
    log({ event: "route_end", requestId, ok: false, uispStatus: r.status, errorCode: classified.errorCode });
    return res.json({ ok: false, ...classified, uispStatus: r.status, detail: r.data });
  } catch (err) {
    const classified = classifyError(err);
    log({ event: "route_end", requestId, ok: false, errorCode: classified.errorCode });
    return res.json({ ok: false, ...classified });
  }
});

// ---------------------------------------------------------------------------
// POST /api/devices
// ---------------------------------------------------------------------------
app.post("/api/devices", async (req, res) => {
  const { baseUrl, token, skipTls } = req.body;
  const requestId = crypto.randomUUID();

  if (!baseUrl || !token) {
    return errorResponse(res, 400, "VALIDATION", "baseUrl and token are required");
  }

  log({ event: "route_start", requestId, route: "/api/devices", baseUrl, token: redactToken(token) });

  try {
    const r = await uispRequest("GET", baseUrl, "/nms/api/v2.1/devices", token, skipTls, null, requestId);

    if (r.errorCode) {
      log({ event: "route_end", requestId, ok: false, errorCode: r.errorCode });
      return errorResponse(res, 502, r.errorCode, r.message);
    }

    if (r.status !== 200) {
      const classified = classifyUispStatus(r.status);
      const httpOut = r.status === 401 ? 401 : r.status === 403 ? 403 : 502;
      log({ event: "route_end", requestId, ok: false, uispStatus: r.status, errorCode: classified.errorCode });
      return errorResponse(res, httpOut, classified.errorCode, classified.message, r.data);
    }

    const items = Array.isArray(r.data)
      ? r.data
      : (r.data && Array.isArray(r.data.items) ? r.data.items : []);
    const normalized = items.map(normalizeDevice);

    log({ event: "route_end", requestId, ok: true, deviceCount: normalized.length });
    return res.json({ ok: true, devices: normalized, total: normalized.length });
  } catch (err) {
    const classified = classifyError(err);
    log({ event: "route_end", requestId, ok: false, errorCode: classified.errorCode });
    return errorResponse(res, 502, classified.errorCode, classified.message);
  }
});

// ---------------------------------------------------------------------------
// POST /api/delete – streaming SSE with hardened per-device handling
// ---------------------------------------------------------------------------
app.post("/api/delete", async (req, res) => {
  const { baseUrl, token, skipTls, deviceIds } = req.body;
  const requestId = crypto.randomUUID();

  if (!baseUrl || !token || !Array.isArray(deviceIds) || deviceIds.length === 0) {
    return errorResponse(res, 400, "VALIDATION", "baseUrl, token, and a non-empty deviceIds array are required");
  }

  log({ event: "delete_job_start", requestId, total: deviceIds.length, token: redactToken(token) });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const deleteLogFile = path.join(
    LOG_DIR,
    `delete-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`
  );
  const deleteLogStream = fs.createWriteStream(deleteLogFile, { flags: "a" });

  let success = 0;
  let failed = 0;
  const errorCounts = {};

  for (let i = 0; i < deviceIds.length; i++) {
    const id = deviceIds[i];
    let result;

    try {
      const r = await uispRequest(
        "DELETE", baseUrl, `/nms/api/v2.1/devices/${id}`, token, skipTls, null, requestId
      );

      if (r.errorCode) {
        result = { index: i, id, status: 0, ok: false, errorCode: r.errorCode, reason: r.message };
        failed++;
      } else if (r.status >= 200 && r.status < 300) {
        result = { index: i, id, status: r.status, ok: true };
        success++;
      } else {
        const classified = classifyUispStatus(r.status);
        result = { index: i, id, status: r.status, ok: false, errorCode: classified.errorCode, reason: classified.message, detail: r.data };
        failed++;
      }
    } catch (err) {
      const classified = classifyError(err);
      result = { index: i, id, status: 0, ok: false, errorCode: classified.errorCode, reason: classified.message };
      failed++;
    }

    if (!result.ok) {
      const key = result.errorCode || "UNKNOWN";
      errorCounts[key] = (errorCounts[key] || 0) + 1;
    }

    const logEntry = { ...result, timestamp: new Date().toISOString(), requestId };
    deleteLogStream.write(JSON.stringify(logEntry) + "\n");
    log({ event: "delete_item", requestId, deviceId: id, ok: result.ok, status: result.status, errorCode: result.errorCode });

    res.write(`data: ${JSON.stringify(result)}\n\n`);

    if (i < deviceIds.length - 1) {
      await sleep(250);
    }
  }

  deleteLogStream.end();

  const summary = {
    done: true,
    total: deviceIds.length,
    success,
    failed,
    errorCounts,
    logFile: deleteLogFile,
  };

  log({ event: "delete_job_end", requestId, ...summary });
  res.write(`data: ${JSON.stringify(summary)}\n\n`);
  res.end();
});

// ---------------------------------------------------------------------------
// POST /api/sites – fetch all sites + compute device counts
// ---------------------------------------------------------------------------
app.post("/api/sites", async (req, res) => {
  const { baseUrl, token, skipTls } = req.body;
  const requestId = crypto.randomUUID();

  if (!baseUrl || !token) {
    return errorResponse(res, 400, "VALIDATION", "baseUrl and token are required");
  }

  log({ event: "route_start", requestId, route: "/api/sites", baseUrl, token: redactToken(token) });

  try {
    const [sitesRes, devicesRes] = await Promise.all([
      uispRequest("GET", baseUrl, "/nms/api/v2.1/sites", token, skipTls, null, requestId),
      uispRequest("GET", baseUrl, "/nms/api/v2.1/devices", token, skipTls, null, requestId),
    ]);

    if (sitesRes.errorCode) {
      log({ event: "route_end", requestId, ok: false, errorCode: sitesRes.errorCode });
      return errorResponse(res, 502, sitesRes.errorCode, sitesRes.message);
    }
    if (sitesRes.status !== 200) {
      const classified = classifyUispStatus(sitesRes.status);
      const httpOut = sitesRes.status === 401 ? 401 : sitesRes.status === 403 ? 403 : 502;
      log({ event: "route_end", requestId, ok: false, uispStatus: sitesRes.status, errorCode: classified.errorCode });
      return errorResponse(res, httpOut, classified.errorCode, classified.message, sitesRes.data);
    }

    const rawSites = Array.isArray(sitesRes.data) ? sitesRes.data
      : (sitesRes.data && Array.isArray(sitesRes.data.items) ? sitesRes.data.items : []);

    const deviceCountBySiteId = {};
    if (!devicesRes.errorCode && devicesRes.status === 200) {
      const rawDevices = Array.isArray(devicesRes.data) ? devicesRes.data
        : (devicesRes.data && Array.isArray(devicesRes.data.items) ? devicesRes.data.items : []);
      for (const d of rawDevices) {
        const siteRef = (d.identification || {}).site;
        const sId = siteRef ? (siteRef.id || "") : "";
        if (sId) deviceCountBySiteId[sId] = (deviceCountBySiteId[sId] || 0) + 1;
      }
    }

    const normalized = rawSites.map((s) => normalizeSite(s, deviceCountBySiteId));

    log({ event: "route_end", requestId, ok: true, siteCount: normalized.length });
    return res.json({ ok: true, sites: normalized, total: normalized.length });
  } catch (err) {
    const classified = classifyError(err);
    log({ event: "route_end", requestId, ok: false, errorCode: classified.errorCode });
    return errorResponse(res, 502, classified.errorCode, classified.message);
  }
});

// ---------------------------------------------------------------------------
// POST /api/sites/delete – streaming SSE site deletion
// ---------------------------------------------------------------------------
app.post("/api/sites/delete", async (req, res) => {
  const { baseUrl, token, skipTls, siteIds } = req.body;
  const requestId = crypto.randomUUID();

  if (!baseUrl || !token || !Array.isArray(siteIds) || siteIds.length === 0) {
    return errorResponse(res, 400, "VALIDATION", "baseUrl, token, and a non-empty siteIds array are required");
  }

  log({ event: "site_delete_job_start", requestId, total: siteIds.length, token: redactToken(token) });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const siteLogFile = path.join(
    LOG_DIR,
    `site-delete-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`
  );
  const siteLogStream = fs.createWriteStream(siteLogFile, { flags: "a" });

  let success = 0;
  let failed = 0;
  const errorCounts = {};

  for (let i = 0; i < siteIds.length; i++) {
    const id = siteIds[i];
    let result;

    try {
      const r = await uispRequest(
        "DELETE", baseUrl, `/nms/api/v2.1/sites/${id}`, token, skipTls, null, requestId
      );

      if (r.errorCode) {
        result = { index: i, id, status: 0, ok: false, errorCode: r.errorCode, reason: r.message };
        failed++;
      } else if (r.status >= 200 && r.status < 300) {
        result = { index: i, id, status: r.status, ok: true };
        success++;
      } else {
        const classified = classifyUispStatus(r.status);
        result = { index: i, id, status: r.status, ok: false, errorCode: classified.errorCode, reason: classified.message, detail: r.data };
        failed++;
      }
    } catch (err) {
      const classified = classifyError(err);
      result = { index: i, id, status: 0, ok: false, errorCode: classified.errorCode, reason: classified.message };
      failed++;
    }

    if (!result.ok) {
      const key = result.errorCode || "UNKNOWN";
      errorCounts[key] = (errorCounts[key] || 0) + 1;
    }

    const logEntry = { ...result, timestamp: new Date().toISOString(), requestId };
    siteLogStream.write(JSON.stringify(logEntry) + "\n");
    log({ event: "site_delete_item", requestId, siteId: id, ok: result.ok, status: result.status, errorCode: result.errorCode });

    res.write(`data: ${JSON.stringify(result)}\n\n`);

    if (i < siteIds.length - 1) {
      await sleep(250);
    }
  }

  siteLogStream.end();

  const summary = {
    done: true,
    total: siteIds.length,
    success,
    failed,
    errorCounts,
    logFile: siteLogFile,
  };

  log({ event: "site_delete_job_end", requestId, ...summary });
  res.write(`data: ${JSON.stringify(summary)}\n\n`);
  res.end();
});

// ---------------------------------------------------------------------------
// Normalize a raw UISP site object into a flat shape
// ---------------------------------------------------------------------------
function normalizeSite(s, deviceCountMap) {
  const id = s.identification || s.id || {};
  const desc = s.description || {};

  const siteId = typeof id === "string" ? id : (id.id || s.id || "");
  const siteName = id.name || s.name || desc.name || "";
  const siteStatus = id.status || s.status || "";
  const siteType = id.type || s.type || "";
  const parentId = id.parent || s.parentId || s.parentSiteId || "";

  const address = desc.address || s.address || "";
  const note = desc.note || s.note || "";

  const deviceCount = deviceCountMap[siteId] || 0;

  return {
    id: siteId,
    name: siteName,
    status: siteStatus,
    type: siteType,
    parentId,
    address: typeof address === "object"
      ? [address.line1, address.line2, address.city, address.state, address.zip, address.country].filter(Boolean).join(", ")
      : address,
    note,
    deviceCount,
    isEmpty: deviceCount === 0,
  };
}

// ---------------------------------------------------------------------------
// Normalize a raw UISP device object into a flat, predictable shape
// ---------------------------------------------------------------------------
function normalizeDevice(d) {
  const id = d.identification || {};
  const ov = d.overview || {};
  const meta = d.meta || {};

  let lastSeen = ov.lastSeen || meta.lastSeen || id.updated || null;
  if (lastSeen && typeof lastSeen === "number") {
    lastSeen = lastSeen > 1e12
      ? new Date(lastSeen).toISOString()
      : new Date(lastSeen * 1000).toISOString();
  }

  return {
    id: id.id,
    name: id.name || id.hostname || "",
    displayName: id.displayName || id.name || id.hostname || "",
    model: id.modelName || id.model || "",
    mac: id.mac || "",
    role: id.role || "",
    site: id.site ? id.site.name || id.site.id || "" : "",
    siteId: id.site ? id.site.id || "" : "",
    vendor: id.vendor || id.vendorName || "",
    category: id.category || "",
    firmwareVersion: id.firmwareVersion || "",
    ip: d.ipAddress || "",
    status: ov.status || "",
    lastSeen,
    canUpgrade: ov.canUpgrade || false,
    uptime: ov.uptime || null,
    _raw: d,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  log({ event: "server_start", port: PORT });
  console.log(`UISP Device Cleanup running at http://localhost:${PORT}`);
});
