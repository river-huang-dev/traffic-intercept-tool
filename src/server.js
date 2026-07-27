#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const http = require("http");
const { URL } = require("url");
const {
  findPreferredChromeProfile,
  getReviewSequenceStatus,
  diagnoseVideoNavigation,
  listSystemChromeProfiles,
  startReviewSequence,
  stopReviewSequence,
  searchByChannel,
} = require("./search");

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 4318);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");
const APP_FILE = path.join(PUBLIC_DIR, "index.html");

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload, null, 2));
}

function sendFile(res, filePath, contentType) {
  if (!fs.existsSync(filePath)) {
    sendJson(res, 404, { ok: false, message: "File not found" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  fs.createReadStream(filePath).pipe(res);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk.toString("utf8");
      if (raw.length > 1_000_000) {
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === "GET" && requestUrl.pathname === "/") {
    sendFile(res, APP_FILE, "text/html; charset=utf-8");
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/chrome-profiles") {
    const profiles = listSystemChromeProfiles().map(profile => ({
      name: profile.name,
      label: profile.label,
      userName: profile.userName,
      lastUsed: profile.mtimeMs,
    }));
    const preferredProfile = findPreferredChromeProfile(profiles);
    sendJson(res, 200, {
      ok: true,
      profiles,
      selectedProfileName: preferredProfile?.name || "Default",
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/search") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const channel = String(body.channel || "tiktok").trim().toLowerCase();
      const facebookContentType = String(body.facebookContentType || body.contentType || "post").trim().toLowerCase();
      const keyword = String(body.keyword || "").trim();
      const numericLimit = Number(body.limit);
      const requestedLimit = numericLimit === 1 ? 1 : numericLimit === 10 ? 10 : 100;
      const limit = requestedLimit;
      const headed = body.headed !== false;
      const chromeProfileName = String(body.chromeProfileName || "").trim();

      if (!keyword) {
        sendJson(res, 400, { ok: false, message: "Keyword is required" });
        return;
      }

      const result = await searchByChannel({
        channel,
        facebookContentType,
        contentType: facebookContentType,
        keyword,
        limit,
        headed,
        keepOpen: headed,
        chromeProfileName,
        syncSystemProfile: process.env.SYNC_CHROME_PROFILE === "1" || Boolean(chromeProfileName),
        out: "",
      });

      sendJson(res, 200, {
        ...result,
        channel: result.channel || channel,
        chromeProfileName: chromeProfileName || result.chromeProfileName || "",
      });
      return;
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        message: error.message,
      });
      return;
    }
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/review-sequence") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const channel = String(body.channel || "tiktok").trim().toLowerCase();
      const facebookContentType = String(body.facebookContentType || body.contentType || "post").trim().toLowerCase();
      const hrefs = Array.isArray(body.hrefs) ? body.hrefs.map(item => String(item || "").trim()) : [];
      const holdMs = Number.isFinite(Number(body.holdMs)) ? Number(body.holdMs) : 30_000;
      const randomHoldMs = Number.isFinite(Number(body.randomHoldMs)) ? Number(body.randomHoldMs) : 30_000;
      const maxVideos = Number.isFinite(Number(body.maxVideos)) ? Number(body.maxVideos) : undefined;
      const chromeProfileName = String(body.chromeProfileName || "").trim();
      const searchKeyword = String(body.searchKeyword || body.keyword || "").trim();
      const keywordPool = Array.isArray(body.keywordPool)
        ? body.keywordPool.map(item => String(item || "").trim()).filter(Boolean)
        : [];
      const result = startReviewSequence({
        channel,
        facebookContentType,
        contentType: facebookContentType,
        hrefs,
        holdMs,
        randomHoldMs,
        maxVideos,
        chromeProfileName,
        searchKeyword,
        keywordPool,
      });
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        message: error.message,
      });
      return;
    }
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/review-sequence") {
    sendJson(res, 200, {
      ok: true,
      ...getReviewSequenceStatus(),
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/review-sequence/stop") {
    try {
      const result = await stopReviewSequence();
      sendJson(res, 200, result);
      return;
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        message: error.message,
      });
      return;
    }
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/debug/video-navigation") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const result = await diagnoseVideoNavigation({
        href: String(body.href || "").trim(),
        chromeProfileName: String(body.chromeProfileName || "").trim(),
      });
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        message: error.message,
      });
      return;
    }
  }

  sendJson(res, 404, { ok: false, message: "Not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`Traffic intercept tool running at http://${HOST}:${PORT}`);
});
