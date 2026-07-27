const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const {
  getFacebookReviewSequenceStatus,
  searchFacebook,
  startFacebookReviewSequence,
  stopFacebookReviewSequence,
} = require("./channels/facebook");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SEARCH_DATA_DIR = path.join(PROJECT_ROOT, "data", "searches");
const BROWSER_PROFILE_DIR = path.join(PROJECT_ROOT, "data", "browser-profile");
const SYSTEM_CHROME_ROOT_DIR = path.join(
  process.env.HOME || "",
  "Library",
  "Application Support",
  "Google",
  "Chrome",
);
const BROWSER_VIEWPORT = { width: 1440, height: 960 };
const CHROME_FALLBACK_WARNING = "System Chrome launch failed, falling back to Playwright Chromium.";
const COMMENT_DRAFTS = [
  "Sebelum mengajukan pinjaman online, bandingkan bunga, biaya, dan tenor terlebih dahulu.",
  "Pastikan aplikasi pinjaman terdaftar dan diawasi OJK sebelum mengajukan pinjaman.",
  "Baca syarat dan ketentuan pinjaman sampai selesai agar memahami total pengembaliannya.",
  "Pilih pinjaman sesuai kemampuan bayar dan hindari meminjam untuk kebutuhan yang tidak mendesak.",
  "Cek ulasan pengguna dan informasi legalitas aplikasi sebelum memberikan data pribadi.",
  "Jangan membagikan kode OTP, PIN, atau kata sandi kepada siapa pun saat mengajukan pinjaman.",
  "Bandingkan beberapa pilihan pinjaman digital agar bisa memilih yang paling sesuai kebutuhan.",
  "Perhatikan tanggal jatuh tempo supaya pembayaran pinjaman tetap terkendali.",
  "Gunakan layanan keuangan resmi dan pahami semua biaya sebelum menyetujui pengajuan.",
  "Jika membutuhkan dana, buat rencana pembayaran terlebih dahulu sebelum mengajukan pinjaman.",
  "Waspadai tawaran pinjaman yang meminta biaya di muka atau menjanjikan persetujuan tanpa syarat.",
  "Pastikan jumlah cicilan tidak mengganggu kebutuhan pokok bulanan.",
  "Simpan bukti pengajuan dan komunikasi dengan penyedia layanan keuangan.",
  "Pilih aplikasi yang menjelaskan bunga, denda, dan tenor secara transparan.",
  "Cek kembali izin dan reputasi penyedia pinjaman sebelum melanjutkan proses.",
  "Pinjaman yang sehat adalah pinjaman yang sesuai kebutuhan dan kemampuan bayar.",
  "Jangan terburu-buru menyetujui penawaran; bandingkan ketentuan dari beberapa layanan.",
  "Lindungi data pribadi saat menggunakan aplikasi keuangan di ponsel.",
  "Jika ada ketentuan yang kurang jelas, hubungi layanan resmi sebelum mengajukan pinjaman.",
  "Gunakan pinjaman secara bijak dan prioritaskan pelunasan tepat waktu.",
];
const COMMENT_POST_SELECTOR = [
  'button[data-e2e="comment-post"]',
  '[role="button"][data-e2e="comment-post"]',
  'button[aria-label="Post"]',
  '[role="button"][aria-label="Post"]',
].join(",");
const COMMENT_DRAFT = COMMENT_DRAFTS[0];
const PROFILE_COPY_EXCLUDE_NAMES = new Set([
  "BrowserMetrics",
  "BrowserMetrics-spare.pma",
  "Cache",
  "Code Cache",
  "Crashpad",
  "CrashpadMetrics-active.pma",
  "CrashpadMetrics.pma",
  "DawnCache",
  "GPUCache",
  "GrShaderCache",
  "GraphiteDawnCache",
  "Login Data",
  "Login Data For Account",
  "Media Cache",
  "Safe Browsing",
  "ShaderCache",
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
]);

let retainedContext = null;
let retainedContextProfileName = null;
const retainedVideoPages = new Set();
let reviewSequenceJob = null;

function timestamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function pathExists(filePath) {
  return fs.existsSync(filePath);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function listSystemChromeProfiles() {
  if (!pathExists(SYSTEM_CHROME_ROOT_DIR)) {
    return [];
  }

  const localStatePath = path.join(SYSTEM_CHROME_ROOT_DIR, "Local State");
  let infoCache = {};
  if (pathExists(localStatePath)) {
    try {
      const localState = JSON.parse(fs.readFileSync(localStatePath, "utf8"));
      infoCache = localState?.profile?.info_cache || {};
    } catch {
      infoCache = {};
    }
  }

  const entries = fs.readdirSync(SYSTEM_CHROME_ROOT_DIR, { withFileTypes: true });
  return entries
    .filter(entry => entry.isDirectory() && (entry.name === "Default" || /^Profile \d+$/.test(entry.name)))
    .map(entry => ({
      name: entry.name,
      label: infoCache[entry.name]?.name || entry.name,
      userName: infoCache[entry.name]?.user_name || "",
      mtimeMs: fs.statSync(path.join(SYSTEM_CHROME_ROOT_DIR, entry.name)).mtimeMs,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function findPreferredChromeProfile(profiles) {
  if (!Array.isArray(profiles) || !profiles.length) {
    return null;
  }

  const requested = String(process.env.CHROME_PROFILE_NAME || "").trim().toLowerCase();
  if (requested) {
    const match = profiles.find(profile =>
      [profile.name, profile.label, profile.userName].some(value => String(value || "").toLowerCase() === requested)
    ) || profiles.find(profile =>
      [profile.name, profile.label, profile.userName].some(value => String(value || "").toLowerCase().includes(requested))
    );
    if (match) return match;
  }

  return profiles[0];
}

function resolveChromeProfileName(profileName) {
  if (profileName) {
    const requested = String(profileName).trim();
    const requestedLower = requested.toLowerCase();
    const profiles = listSystemChromeProfiles();
    const exactMatch = profiles.find(profile =>
      [profile.name, profile.label, profile.userName].some(value => String(value || "").toLowerCase() === requestedLower)
    );
    if (exactMatch) {
      return exactMatch.name;
    }
    const partialMatch = profiles.find(profile =>
      [profile.name, profile.label, profile.userName].some(value => String(value || "").toLowerCase().includes(requestedLower))
    );
    return partialMatch?.name || requested;
  }
  if (process.env.CHROME_PROFILE_NAME) {
    return process.env.CHROME_PROFILE_NAME;
  }

  const profileDirs = listSystemChromeProfiles();

  return findPreferredChromeProfile(profileDirs)?.name || "Default";
}

function copyPathIfPresent(sourcePath, targetPath) {
  if (!pathExists(sourcePath)) return;

  fs.rmSync(targetPath, { recursive: true, force: true });
  ensureDir(path.dirname(targetPath));
  fs.cpSync(sourcePath, targetPath, {
    recursive: true,
    force: true,
    dereference: true,
  });
}

function shouldCopyProfilePath(sourcePath) {
  const name = path.basename(sourcePath);
  if (PROFILE_COPY_EXCLUDE_NAMES.has(name)) {
    return false;
  }
  if (name.endsWith("-journal") && name.includes("Login Data")) {
    return false;
  }
  return true;
}

function copyProfileSnapshot(sourceDir, targetDir) {
  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    force: true,
    dereference: true,
    filter: shouldCopyProfilePath,
  });
}

function syncSystemChromeProfile(profileName) {
  if (!pathExists(SYSTEM_CHROME_ROOT_DIR)) {
    return {
      ok: false,
      message: "System Chrome profile directory not found.",
    };
  }

  const resolvedProfileName = resolveChromeProfileName(profileName);
  const sourceProfileDir = path.join(SYSTEM_CHROME_ROOT_DIR, resolvedProfileName);
  if (!pathExists(sourceProfileDir)) {
    return {
      ok: false,
      message: `Chrome profile '${resolvedProfileName}' not found.`,
    };
  }

  fs.rmSync(BROWSER_PROFILE_DIR, { recursive: true, force: true });
  ensureDir(BROWSER_PROFILE_DIR);

  const topLevelItems = [
    "Local State",
    "First Run",
    "Last Version",
    "Variations",
    "ChromeFeatureState",
    "CertificateRevocation",
    "FirstPartySetsPreloaded",
    "OriginTrials",
    "PrivacySandboxAttestationsPreloaded",
    "TrustTokenKeyCommitments",
  ];

  for (const item of topLevelItems) {
    copyPathIfPresent(
      path.join(SYSTEM_CHROME_ROOT_DIR, item),
      path.join(BROWSER_PROFILE_DIR, item),
    );
  }

  copyProfileSnapshot(sourceProfileDir, path.join(BROWSER_PROFILE_DIR, resolvedProfileName));
  copyPathIfPresent(
    path.join(SYSTEM_CHROME_ROOT_DIR, "Default", "Preferences"),
    path.join(BROWSER_PROFILE_DIR, "Default", "Preferences"),
  );

  return {
    ok: true,
    profileName: resolvedProfileName,
    sourceProfileDir,
  };
}

async function dismissCommonPrompts(page) {
  const candidates = [
    { role: "button", name: "Accept all" },
    { role: "button", name: "Allow all" },
    { role: "button", name: "Not now" },
  ];

  for (const item of candidates) {
    const locator = page.getByRole(item.role, { name: item.name });
    const count = await locator.count().catch(() => 0);
    if (count === 1) {
      await locator.click().catch(() => {});
    }
  }
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function uniqueRounded(values = []) {
  return Array.from(new Set(values
    .filter(value => Number.isFinite(value))
    .map(value => Math.round(value * 1000) / 1000)));
}

async function inspectSliderCaptcha(page) {
  return page.evaluate(() => {
    const isVisible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 8 &&
        rect.height > 8 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth
      );
    };

    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;
    const dialog = Array.from(document.querySelectorAll("div, section, aside"))
      .map(element => {
        if (!isVisible(element)) return null;
        const rect = element.getBoundingClientRect();
        const text = (element.innerText || element.textContent || "").toLowerCase();
        const looksLikeCaptcha = (
          text.includes("drag the slider") ||
          text.includes("drag the puzzle piece") ||
          text.includes("fit the puzzle") ||
          text.includes("slide to complete") ||
          text.includes("verification") ||
          text.includes("captcha") ||
          text.includes("拖动滑块") ||
          text.includes("拼图")
        );
        if (!looksLikeCaptcha) return null;
        const centered = (
          rect.left > centerX - 420 &&
          rect.right < centerX + 420 &&
          rect.top > centerY - 380 &&
          rect.bottom < centerY + 380
        );
        if (!centered) return null;
        return { element, rect, area: rect.width * rect.height, text };
      })
      .filter(Boolean)
      .sort((a, b) => b.area - a.area)[0] || null;

    if (!dialog) return null;

    const serializeRect = rect => ({
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      right: Math.round(rect.right),
      bottom: Math.round(rect.bottom),
    });

    const imageCandidate = Array.from(dialog.element.querySelectorAll("img, canvas"))
      .map(element => {
        if (!isVisible(element)) return null;
        const rect = element.getBoundingClientRect();
        const area = rect.width * rect.height;
        if (rect.width < 160 || rect.height < 120) return null;
        return { element, rect, area };
      })
      .filter(Boolean)
      .sort((a, b) => b.area - a.area)[0] || null;

    const sliderCandidates = Array.from(dialog.element.querySelectorAll("div, button, span"))
      .map(element => {
        if (!isVisible(element)) return null;
        const rect = element.getBoundingClientRect();
        if (
          rect.width < 180 ||
          rect.height < 24 ||
          rect.height > 80 ||
          rect.top < dialog.rect.top + dialog.rect.height * 0.55 ||
          rect.bottom > dialog.rect.bottom - 8
        ) {
          return null;
        }
        const text = (element.innerText || element.textContent || "").trim().toLowerCase();
        if (text.length > 40) return null;
        return { element, rect, text };
      })
      .filter(Boolean)
      .sort((a, b) => (
        Math.abs((a.rect.top + a.rect.bottom) / 2 - (dialog.rect.bottom - 64)) -
        Math.abs((b.rect.top + b.rect.bottom) / 2 - (dialog.rect.bottom - 64)) ||
        b.rect.width - a.rect.width
      ));

    const track = sliderCandidates[0] || null;
    if (!track) {
      return {
        visible: true,
        dialogRect: serializeRect(dialog.rect),
        imageRect: imageCandidate ? serializeRect(imageCandidate.rect) : null,
        trackRect: null,
        handleRect: null,
        refreshRect: null,
      };
    }

    const handle = Array.from(dialog.element.querySelectorAll("button, div, span"))
      .map(element => {
        if (!isVisible(element)) return null;
        const rect = element.getBoundingClientRect();
        const overlapsTrack = (
          rect.left >= track.rect.left - 8 &&
          rect.right <= track.rect.left + Math.min(120, track.rect.width * 0.4) &&
          rect.top >= track.rect.top - 8 &&
          rect.bottom <= track.rect.bottom + 8
        );
        if (!overlapsTrack) return null;
        if (rect.width < 24 || rect.width > 96 || rect.height < 24 || rect.height > 96) return null;
        return { element, rect, area: rect.width * rect.height };
      })
      .filter(Boolean)
      .sort((a, b) => b.area - a.area)[0] || null;

    const refresh = Array.from(dialog.element.querySelectorAll("button, [role='button'], div, span"))
      .map(element => {
        if (!isVisible(element)) return null;
        const rect = element.getBoundingClientRect();
        const nearBottomRight = (
          rect.left > dialog.rect.right - 110 &&
          rect.top > dialog.rect.bottom - 80 &&
          rect.width >= 18 &&
          rect.width <= 48 &&
          rect.height >= 18 &&
          rect.height <= 48
        );
        if (!nearBottomRight) return null;
        return { element, rect, area: rect.width * rect.height };
      })
      .filter(Boolean)
      .sort((a, b) => b.area - a.area)[0] || null;

    return {
      visible: true,
      dialogRect: serializeRect(dialog.rect),
      imageRect: imageCandidate ? serializeRect(imageCandidate.rect) : null,
      trackRect: serializeRect(track.rect),
      handleRect: handle ? serializeRect(handle.rect) : null,
      refreshRect: refresh ? serializeRect(refresh.rect) : null,
    };
  }).catch(() => null);
}

async function estimateSliderCaptchaOffset(page, captchaState) {
  const dialogRect = captchaState?.dialogRect;
  const imageRect = captchaState?.imageRect;
  if (!dialogRect || !imageRect) {
    return {
      ratio: 0.52,
      confidence: 0,
      reason: "missing_image_rect",
    };
  }

  const clip = {
    x: Math.max(0, dialogRect.left),
    y: Math.max(0, dialogRect.top),
    width: Math.max(1, dialogRect.width),
    height: Math.max(1, dialogRect.height),
  };

  const buffer = await page.screenshot({ clip }).catch(() => null);
  if (!buffer) {
    return {
      ratio: 0.52,
      confidence: 0,
      reason: "screenshot_failed",
    };
  }

  const dataUrl = `data:image/png;base64,${buffer.toString("base64")}`;
  return page.evaluate(async ({ encoded, dialog, image }) => {
    const loadImage = source => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = source;
    });

    try {
      const img = await loadImage(encoded);
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);

      const scaleX = img.naturalWidth / dialog.width;
      const scaleY = img.naturalHeight / dialog.height;
      const sx = Math.max(0, Math.floor((image.left - dialog.left) * scaleX));
      const sy = Math.max(0, Math.floor((image.top - dialog.top) * scaleY));
      const sw = Math.max(1, Math.min(img.naturalWidth - sx, Math.floor(image.width * scaleX)));
      const sh = Math.max(1, Math.min(img.naturalHeight - sy, Math.floor(image.height * scaleY)));
      const imageData = ctx.getImageData(sx, sy, sw, sh).data;

      const grayAt = (x, y) => {
        const index = (y * sw + x) * 4;
        return (
          imageData[index] * 0.299 +
          imageData[index + 1] * 0.587 +
          imageData[index + 2] * 0.114
        );
      };

      const startY = Math.floor(sh * 0.18);
      const endY = Math.ceil(sh * 0.82);
      const energies = [];
      for (let x = 1; x < sw - 1; x += 1) {
        let energy = 0;
        for (let y = startY; y < endY; y += 1) {
          energy += Math.abs(grayAt(x + 1, y) - grayAt(x - 1, y));
        }
        energies.push(energy);
      }

      const smoothed = energies.map((_, index) => {
        let sum = 0;
        let count = 0;
        for (let offset = -4; offset <= 4; offset += 1) {
          const target = energies[index + offset];
          if (!Number.isFinite(target)) continue;
          sum += target;
          count += 1;
        }
        return count ? sum / count : 0;
      });

      let best = null;
      for (let left = Math.floor(sw * 0.12); left < Math.floor(sw * 0.68); left += 1) {
        for (let right = left + Math.floor(sw * 0.14); right < Math.min(sw - 2, left + Math.floor(sw * 0.6)); right += 1) {
          const score = smoothed[left] + smoothed[right];
          if (!best || score > best.score) {
            best = { left, right, score };
          }
        }
      }

      if (!best) {
        return { ratio: 0.52, confidence: 0, reason: "no_peaks" };
      }

      const pieceWidth = Math.max(1, best.right - best.left);
      // The draggable piece aligns by its left edge against the hole's left edge.
      // Using the hole center overestimates the travel by roughly half a piece width,
      // which is why the slider ends up too far to the right.
      const ratio = best.left / Math.max(1, sw - pieceWidth);
      const peakMax = Math.max(...smoothed, 1);
      const confidence = Math.min(1, (best.score / peakMax) / Math.max(1, sw * 0.08));
      return {
        ratio,
        confidence,
        reason: "edge_pair",
      };
    } catch (error) {
      return {
        ratio: 0.52,
        confidence: 0,
        reason: error.message,
      };
    }
  }, {
    encoded: dataUrl,
    dialog: dialogRect,
    image: imageRect,
  }).catch(() => ({
    ratio: 0.52,
    confidence: 0,
    reason: "analysis_failed",
  }));
}

function buildSliderCaptchaAttemptRatios(estimateRatio = 0.52) {
  const base = clampNumber(Number(estimateRatio) || 0.52, 0.18, 0.9);
  return uniqueRounded([
    base,
    base - 0.06,
    base + 0.06,
    base - 0.12,
    base + 0.12,
    0.46,
    0.58,
    0.7,
  ]).map(value => clampNumber(value, 0.16, 0.92));
}

async function dragSliderCaptcha(page, captchaState, ratio) {
  const trackRect = captchaState?.trackRect;
  const handleRect = captchaState?.handleRect;
  if (!trackRect || !handleRect) {
    return {
      ok: false,
      reason: "missing_track_or_handle",
    };
  }

  const startX = handleRect.left + handleRect.width / 2;
  const startY = handleRect.top + handleRect.height / 2;
  const minCenterX = trackRect.left + handleRect.width / 2;
  const maxCenterX = trackRect.left + trackRect.width - handleRect.width / 2 - 4;
  const availableDistance = Math.max(24, maxCenterX - minCenterX);
  const targetDistance = clampNumber(availableDistance * ratio, 18, availableDistance);
  // Convert the estimated puzzle-gap ratio into an absolute center point on the rail.
  // This keeps the slider's own starting offset in the calculation instead of
  // treating the detected handle center as the zero point.
  const endX = clampNumber(minCenterX + targetDistance, minCenterX + 18, maxCenterX);
  const endY = startY;
  const steps = 18;

  await page.mouse.move(startX, startY).catch(() => {});
  await page.waitForTimeout(120).catch(() => {});
  await page.mouse.down().catch(() => {});
  await page.waitForTimeout(180).catch(() => {});

  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps;
    const eased = 1 - Math.pow(1 - progress, 2);
    const overshoot = step === steps ? -4 : step > steps * 0.8 ? 3 : 0;
    const x = startX + (endX - startX) * eased + overshoot;
    const y = endY + (step % 3 === 0 ? 1.5 : -1.5);
    await page.mouse.move(x, y, { steps: 1 }).catch(() => {});
    await page.waitForTimeout(22 + Math.round(Math.random() * 18)).catch(() => {});
  }

  await page.waitForTimeout(120).catch(() => {});
  await page.mouse.move(endX - 3, endY + 1, { steps: 1 }).catch(() => {});
  await page.waitForTimeout(80).catch(() => {});
  await page.mouse.up().catch(() => {});
  await page.waitForTimeout(1800).catch(() => {});

  const blocking = await detectBlockingState(page).catch(() => "");
  return {
    ok: blocking !== "captcha",
    reason: blocking || "cleared",
    ratio,
  };
}

async function clickSliderCaptchaRefresh(page, captchaState) {
  const rect = captchaState?.refreshRect;
  if (!rect) return false;
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const clicked = await page.mouse.click(x, y).then(() => true).catch(() => false);
  if (clicked) {
    await page.waitForTimeout(1200).catch(() => {});
  }
  return clicked;
}

async function solveSliderCaptcha(page, options = {}) {
  const maxAttempts = Number.isFinite(Number(options.maxAttempts)) ? Number(options.maxAttempts) : 5;
  const attempts = [];

  for (let index = 0; index < maxAttempts; index += 1) {
    const captchaState = await inspectSliderCaptcha(page);
    if (!captchaState?.visible) {
      return {
        solved: true,
        message: "captcha_not_present",
        attempts,
      };
    }

    const estimate = await estimateSliderCaptchaOffset(page, captchaState);
    const ratios = buildSliderCaptchaAttemptRatios(estimate.ratio);
    const ratio = ratios[index % ratios.length];
    const dragResult = await dragSliderCaptcha(page, captchaState, ratio);
    attempts.push({
      ratio,
      estimateRatio: estimate.ratio,
      estimateConfidence: estimate.confidence,
      estimateReason: estimate.reason,
      result: dragResult.reason,
    });

    if (dragResult.ok) {
      return {
        solved: true,
        message: "captcha_solved",
        attempts,
      };
    }

    const refreshed = await clickSliderCaptchaRefresh(page, captchaState);
    if (!refreshed) {
      await page.waitForTimeout(1200).catch(() => {});
    }
  }

  return {
    solved: false,
    message: "captcha_unsolved",
    attempts,
  };
}

async function autoSolveSliderCaptchaIfPresent(page, options = {}) {
  const blocking = await getConfirmedBlockingState(page).catch(() => "");
  if (blocking !== "captcha") {
    return {
      attempted: false,
      solved: blocking === "",
      blocking,
      attempts: [],
    };
  }

  const result = await solveSliderCaptcha(page, options);
  const remaining = await getConfirmedBlockingState(page).catch(() => "");
  return {
    attempted: true,
    solved: result.solved && remaining !== "captcha",
    blocking: remaining,
    attempts: result.attempts || [],
  };
}

async function detectBlockingState(page) {
  const url = page.url().toLowerCase();
  const text = await page.locator("body").innerText().catch(() => "");
  const normalized = text.toLowerCase();
  const hasCaptchaChallenge = await page.evaluate(() => {
    const isVisible = element => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 80 &&
        rect.height > 40 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth
      );
    };

    const challengeTextPatterns = [
      "drag the puzzle piece",
      "drag the slider",
      "fit the puzzle",
      "complete the verification",
      "verify to continue",
      "slide to complete",
      "请拖动滑块",
      "拖动滑块",
      "拼图",
    ];
    const bodyText = (document.body?.innerText || document.body?.textContent || "").toLowerCase();
    if (challengeTextPatterns.some(pattern => bodyText.includes(pattern))) {
      return true;
    }

    const selectors = [
      'iframe[src*="captcha" i]',
      'iframe[src*="secsdk" i]',
      '[aria-label*="captcha" i]',
      '[id*="captcha" i]',
      '[class*="captcha" i]',
    ];

    return Array.from(document.querySelectorAll(selectors.join(","))).some(element => {
      if (!isVisible(element)) return false;
      const rect = element.getBoundingClientRect();
      const text = [
        element.getAttribute("aria-label"),
        element.getAttribute("src"),
        element.innerText,
        element.textContent,
      ].join(" ").toLowerCase();
      return (
        rect.width * rect.height > 20_000 &&
        (
          text.includes("puzzle") ||
          text.includes("slider") ||
          text.includes("verification") ||
          text.includes("captcha") ||
          text.includes("secsdk")
        )
      );
    });
  }).catch(() => false);

  if (
    url.includes("accounts.google.com") && (
      normalized.includes("couldn't sign you in") ||
      normalized.includes("this browser or app may not be secure") ||
      normalized.includes("try using a different browser")
    )
  ) {
    return "google_login_blocked";
  }
  if (
    normalized.includes("discontinued operating tiktok") ||
    normalized.includes("not available in your region") ||
    normalized.includes("dear users")
  ) {
    return "geo_blocked";
  }
  if (
    hasCaptchaChallenge ||
    normalized.includes("drag the slider") ||
    normalized.includes("drag the puzzle piece") ||
    normalized.includes("fit the puzzle")
  ) {
    return "captcha";
  }
  if (
    normalized.includes("something went wrong") ||
    normalized.includes("please try again later")
  ) {
    return "tiktok_error";
  }
  if (
    normalized.includes("log in to tiktok") ||
    normalized.includes("sign up for tiktok") ||
    normalized.includes("continue as guest")
  ) {
    return "login";
  }

  return "";
}

async function getConfirmedBlockingState(page, initialState = "") {
  const firstState = initialState || await detectBlockingState(page).catch(() => "");
  if (firstState !== "captcha") {
    return firstState;
  }

  await page.waitForTimeout(1500).catch(() => {});
  const secondState = await detectBlockingState(page).catch(() => "");
  return secondState === "captcha" ? "captcha" : "";
}

async function waitForResultsOrBlocking(page, minimumCount) {
  const startedAt = Date.now();
  const blockingCounts = new Map();

  for (let i = 0; i < 18; i += 1) {
    const results = await extractVideoResults(page);
    if (results.length >= minimumCount || results.length > 0) {
      return { blocking: "", results };
    }

    const blocking = await detectBlockingState(page);
    if (blocking) {
      const count = (blockingCounts.get(blocking) || 0) + 1;
      blockingCounts.set(blocking, count);
      const elapsedMs = Date.now() - startedAt;
      const requiredCount = blocking === "captcha" ? 4 : 2;
      const requiredElapsedMs = blocking === "captcha" ? 10_000 : 4_000;
      if (count >= requiredCount && elapsedMs >= requiredElapsedMs) {
        return { blocking, results: [] };
      }
    }

    await page.waitForTimeout(2000);
  }

  const results = await extractVideoResults(page);
  if (results.length > 0) {
    return {
      blocking: "",
      results,
    };
  }

  return {
    blocking: await detectBlockingState(page),
    results: [],
  };
}

async function getBlockingDebugState(page) {
  return page.evaluate(() => {
    const isVisible = element => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const selectorParts = [];
    for (const marker of ["captcha", "secsdk"]) {
      selectorParts.push(
        `[id*="${marker}" i]`,
        `[class*="${marker}" i]`,
        `[aria-label*="${marker}" i]`,
        `iframe[src*="${marker}" i]`,
      );
    }

    return {
      url: location.href,
      title: document.title,
      bodyText: (document.body?.innerText || "").slice(0, 2000),
      videoLinkCount: document.querySelectorAll('a[href*="/video/"]').length,
      captchaMatches: Array.from(document.querySelectorAll(selectorParts.join(","))).map(element => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          id: element.id || "",
          className: String(element.className || "").slice(0, 180),
          aria: element.getAttribute("aria-label") || "",
          src: element.getAttribute("src") || "",
          visible: isVisible(element),
          text: (element.innerText || element.textContent || "").slice(0, 240),
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      }),
    };
  }).catch(error => ({
    error: error.message,
  }));
}

async function extractVideoResults(page) {
  return page.evaluate(() => {
    const items = [];
    const seen = new Set();
    const anchors = Array.from(document.querySelectorAll('a[href*="/video/"]'));

    for (const anchor of anchors) {
      const href = anchor.href || "";
      if (!href || seen.has(href)) continue;

      const container =
        anchor.closest('[data-e2e*="search"]') ||
        anchor.closest("div[data-e2e]") ||
        anchor.closest("article") ||
        anchor.parentElement;

      const text = (container?.innerText || anchor.innerText || "").trim();
      const lines = text
        .split("\n")
        .map(line => line.trim())
        .filter(Boolean);

      const title = lines[0] || anchor.getAttribute("title") || "";
      let author = "";
      for (const line of lines) {
        if (line.startsWith("@")) {
          author = line;
          break;
        }
      }

      seen.add(href);
      items.push({
        title,
        author,
        href,
        snippet: lines.slice(0, 6).join(" | "),
      });
    }

    return items;
  });
}

function mergeVideoResults(resultMap, results) {
  for (const item of results) {
    if (item.href && !resultMap.has(item.href)) {
      resultMap.set(item.href, item);
    }
  }
}

async function focusCommentInput(page, commentText = COMMENT_DRAFT) {
  await autoSolveSliderCaptchaIfPresent(page, { maxAttempts: 5 }).catch(() => {});
  await dismissCommonPrompts(page);
  const commentClick = await clickCommentActionButton(page);
  if (!commentClick.clicked && !commentClick.alreadyOpen) {
    return {
      ok: false,
      selector: "",
      filled: false,
      replied: false,
      alreadyCommented: false,
      commentClick,
      expectedText: commentText,
      blocking: await detectBlockingState(page).catch(() => ""),
      postButton: {
        found: false,
        selector: COMMENT_POST_SELECTOR,
      },
    };
  }

  await waitForVisibleComments(page, 6_000);
  await dismissTikTokOverlayDialogs(page);
  await autoSolveSliderCaptchaIfPresent(page, { maxAttempts: 5 }).catch(() => {});
  await waitForCommentPanelReady(page, 12_000);

  const commentState = await getExistingCommentStateAfterLoading(page, COMMENT_DRAFTS);
  if (commentState.exists || commentState.firstThreadHasDraft) {
    return {
      ok: true,
      selector: "existing-comment-detected",
      filled: false,
      replied: false,
      sent: false,
      replySent: false,
      sendVerified: false,
      replySendVerified: false,
      alreadyCommented: true,
      firstCommentMatches: Boolean(commentState.firstCommentMatches),
      firstThreadHasDraft: Boolean(commentState.firstThreadHasDraft),
      mainCommentText: commentText,
      replyCommentText: commentText,
      commentClick,
      expectedText: commentText,
      postButton: {
        found: false,
        selector: COMMENT_POST_SELECTOR,
      },
      mainPostButton: {
        found: false,
        selector: COMMENT_POST_SELECTOR,
      },
      replyPostButton: {
        found: false,
        selector: COMMENT_POST_SELECTOR,
      },
      blocking: "",
      replyClick: {
        clicked: false,
        description: "existing-comment-detected",
      },
      commentState,
      mainCommentStateAfterSend: null,
      replyCommentStateAfterSend: null,
    };
  }

  const shouldReplyTopLikedComment = Number(commentState.commentCount || 0) > 0;
  const replyResult = shouldReplyTopLikedComment
    ? await replyToTopLikedComment(page, commentText)
    : {
      filled: false,
      selector: "",
      replyClick: {
        clicked: false,
        description: "no-visible-comment-to-reply",
      },
      postButton: {
        found: false,
        selector: COMMENT_POST_SELECTOR,
      },
    };

  const mainResult = await fillMainCommentDraft(page, commentText);
  const ok = Boolean(mainResult.sendVerified && (!shouldReplyTopLikedComment || replyResult.sendVerified));
  const result = {
    ok,
    selector: ok
      ? "top-liked-comment-reply-and-main-comment"
      : mainResult.selector || replyResult.selector || "",
    filled: Boolean(mainResult.filled),
    replied: Boolean(replyResult.filled),
    sent: Boolean(mainResult.sent),
    replySent: Boolean(replyResult.sent),
    sendVerified: Boolean(mainResult.sendVerified),
    replySendVerified: Boolean(replyResult.sendVerified),
    alreadyCommented: false,
    firstCommentMatches: false,
    firstThreadHasDraft: false,
    mainCommentText: commentText,
    replyCommentText: shouldReplyTopLikedComment ? commentText : "",
    commentClick,
    expectedText: commentText,
    postButton: mainResult.postButton || await getCommentPostButton(page, { mode: "main" }),
    mainPostButton: mainResult.postButton || {
      found: false,
      selector: COMMENT_POST_SELECTOR,
    },
    replyPostButton: replyResult.postButton || {
      found: false,
      selector: COMMENT_POST_SELECTOR,
    },
    blocking: mainResult.blocking || await detectBlockingState(page).catch(() => ""),
    replyClick: replyResult.replyClick,
    commentState,
    mainCommentStateAfterSend: mainResult.commentStateAfterSend || null,
    replyCommentStateAfterSend: replyResult.commentStateAfterSend || null,
  };
  attachInternalHandle(result, "mainPostButtonHandle", mainResult.postButtonHandle || null);
  attachInternalHandle(result, "replyPostButtonHandle", replyResult.postButtonHandle || null);
  return result;
}

async function fillMainCommentDraft(page, commentText) {
  const target = await waitForCommentEditor(page, 8_000, { mode: "main" });
  if (target) {
    await page.mouse.click(target.x, target.y).catch(() => {});
    await page.waitForTimeout(500);
    const focused = await page.evaluate(() => {
      const active = document.activeElement;
      const selection = window.getSelection();
      const activeText = [
        active?.getAttribute?.("placeholder"),
        active?.getAttribute?.("aria-label"),
        active?.getAttribute?.("data-e2e"),
        active?.textContent,
      ].join(" ").toLowerCase();
      const activeEditable = Boolean(
        active &&
        (
          active.matches?.('textarea, input, [contenteditable="true"], [role="textbox"]') ||
          active.isContentEditable
        )
      );
      const selectionInsideEditable = Boolean(
        selection?.anchorNode?.parentElement?.closest?.('textarea, input, [contenteditable="true"], [role="textbox"]')
      );
      return {
        ok: activeEditable || selectionInsideEditable || activeText.includes("add comment"),
        activeTag: active?.tagName?.toLowerCase?.() || "",
        activeText,
      };
    }).catch(() => ({ ok: false }));

    if (focused.ok) {
      const filled = await setFocusedCommentText(page, commentText);
      const beforeSendState = filled
        ? await getExistingCommentState(page, commentText)
        : null;
      const sendResult = filled
        ? await sendCommentWithRetries(page, {
          text: commentText,
          mode: "main",
          editorTagId: target.editorTagId,
          beforeState: beforeSendState,
          maxAttempts: 6,
        })
        : {
          sent: false,
          sendVerified: false,
          sendVerification: {
            confirmed: false,
            inputCleared: false,
            buttonDisabledOrGone: false,
            commentStateAdvanced: false,
            commentState: beforeSendState,
          },
          postButton: {
            found: false,
            selector: COMMENT_POST_SELECTOR,
          },
          attempts: 0,
        };
      const blocking = await detectBlockingState(page).catch(() => "");
      const result = {
        ok: Boolean(sendResult.sent && sendResult.sendVerified),
        selector: target.description || "comment-input",
        filled,
        sent: Boolean(sendResult.sent),
        sendVerified: Boolean(sendResult.sendVerified),
        sendVerification: sendResult.sendVerification,
        commentStateAfterSend: sendResult.sendVerification?.commentState || null,
        postButton: sendResult.postButton,
        sendAttempts: sendResult.attempts,
        blocking,
      };
      return result;
    }
  }

  return {
    ok: false,
    selector: "",
    filled: false,
    sent: false,
    blocking: "",
    postButton: {
      found: false,
      selector: COMMENT_POST_SELECTOR,
    },
  };
}

async function getExistingCommentStateAfterLoading(page, expectedText, timeoutMs = 18_000) {
  const startedAt = Date.now();
  let bestState = await getExistingCommentState(page, expectedText);
  let scrolled = false;

  while (Date.now() - startedAt < timeoutMs) {
    if (bestState.firstThreadHasDraft || bestState.exists) {
      return bestState;
    }

    if (bestState.commentCount > 0 && bestState.firstThreadText) {
      await expandFirstCommentReplies(page);
    }

    if (!scrolled || bestState.commentCount === 0) {
      await scrollVisibleCommentPanel(page, scrolled ? -240 : 360);
      scrolled = true;
    }

    await page.waitForTimeout(900);
    const nextState = await getExistingCommentState(page, expectedText);
    if (
      nextState.commentCount >= bestState.commentCount ||
      nextState.firstThreadText.length >= bestState.firstThreadText.length ||
      nextState.exists
    ) {
      bestState = nextState;
    }

    if (bestState.commentCount > 0 && Date.now() - startedAt > 5_500) {
      return bestState;
    }
  }

  return bestState;
}

async function scrollVisibleCommentPanel(page, deltaY) {
  return page.evaluate(delta => {
    const isVisible = element => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 160 &&
        rect.height > 120 &&
        rect.left > window.innerWidth * 0.48 &&
        rect.bottom > 0 &&
        rect.top < window.innerHeight
      );
    };

    const candidates = Array.from(document.querySelectorAll("div, section, aside"))
      .filter(isVisible)
      .map(element => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const scrollable = element.scrollHeight > element.clientHeight + 40;
        const text = (element.innerText || element.textContent || "").toLowerCase();
        const commentish = text.includes("reply") || text.includes("comment") || text.includes("回复") || text.includes("评论");
        if (!scrollable || !commentish) return null;
        return {
          element,
          score: element.scrollHeight - element.clientHeight + rect.height + rect.left,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    const target = candidates[0]?.element || document.scrollingElement;
    if (!target) return false;
    target.scrollBy({ top: delta, behavior: "instant" });
    return true;
  }, deltaY).catch(() => false);
}

async function expandFirstCommentReplies(page) {
  const target = await page.evaluate(() => {
    const isVisible = element => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 20 &&
        rect.height > 10 &&
        rect.left > window.innerWidth * 0.5 &&
        rect.bottom > 0 &&
        rect.top < window.innerHeight
      );
    };

    const controls = Array.from(document.querySelectorAll("button, [role='button'], div, span"))
      .map(element => {
        if (!isVisible(element)) return null;
        const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
        if (!/^(view|show).{0,30}repl/i.test(text) && !/查看|展开|显示/.test(text)) return null;
        const rect = element.getBoundingClientRect();
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.y - b.y);

    return controls[0] || null;
  }).catch(() => null);

  if (!target) return false;
  await page.mouse.click(target.x, target.y).catch(() => {});
  await page.waitForTimeout(900);
  return true;
}

async function getExistingCommentState(page, expectedText) {
  const expectedTexts = Array.isArray(expectedText) ? expectedText : [expectedText];
  return page.evaluate(expectedList => {
    const normalizedExpected = expectedList
      .map(item => String(item || "").trim())
      .filter(Boolean);

    const isVisible = element => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 80 &&
        rect.height > 20 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.left > window.innerWidth * 0.5
      );
    };

    const selectors = [
      '[data-e2e="comment-level-1"]',
      '[data-e2e="comment-item"]',
      '[data-e2e*="comment" i]',
      '[class*="CommentItem" i]',
      '[class*="comment-item" i]',
      '[class*="DivComment" i]',
    ];

    const all = Array.from(document.querySelectorAll(selectors.join(",")))
      .filter(isVisible)
      .map(element => {
        const rect = element.getBoundingClientRect();
        const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
        return {
          element,
          text,
          top: rect.top,
          height: rect.height,
          width: rect.width,
        };
      })
      .filter(item => (
        item.text.length > 8 &&
        item.height >= 24 &&
        item.height <= 420 &&
        !/^comments$/i.test(item.text) &&
        !/^you may like$/i.test(item.text) &&
        !item.text.includes("Add comment")
      ));

    const deduped = [];
    for (const item of all.sort((a, b) => a.top - b.top || a.height - b.height)) {
      if (deduped.some(existing => (
        Math.abs(existing.top - item.top) < 4 &&
        (existing.text.includes(item.text) || item.text.includes(existing.text))
      ))) {
        continue;
      }
      deduped.push(item);
    }

    const comments = deduped
      .filter(item => (
        item.text.includes("Reply") ||
        normalizedExpected.some(expected => item.text.includes(expected)) ||
        item.height > 36
      ))
      .sort((a, b) => a.top - b.top);
    const first = comments[0] || null;
    const second = comments[1] || null;
    const firstThreadBottom = second ? second.top : Number.POSITIVE_INFINITY;
    const firstThreadText = first
      ? Array.from(document.querySelectorAll("div, span, p"))
        .filter(isVisible)
        .map(element => {
          const rect = element.getBoundingClientRect();
          const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
          return {
            top: rect.top,
            text,
          };
        })
        .filter(item => (
          item.text &&
          item.top >= first.top - 2 &&
          item.top < firstThreadBottom - 2
        ))
        .map(item => item.text)
        .join(" ")
      : "";
    const existing = comments.find(item => normalizedExpected.some(expected => item.text.includes(expected))) || null;
    const matchedExpected = normalizedExpected.find(expected => (
      firstThreadText.includes(expected) ||
      comments.some(item => item.text.includes(expected))
    )) || "";

    return {
      exists: Boolean(existing) || normalizedExpected.some(expected => firstThreadText.includes(expected)),
      firstCommentMatches: Boolean(first && normalizedExpected.some(expected => first.text.includes(expected))),
      firstThreadHasDraft: normalizedExpected.some(expected => firstThreadText.includes(expected)),
      firstCommentText: first?.text?.slice(0, 500) || "",
      firstThreadText: firstThreadText.slice(0, 800),
      existingCommentText: existing?.text?.slice(0, 500) || "",
      commentCount: comments.length,
      matchedExpected,
    };
  }, expectedTexts).catch(error => ({
    exists: false,
    firstCommentMatches: false,
    firstThreadHasDraft: false,
    firstCommentText: "",
    firstThreadText: "",
    existingCommentText: "",
    commentCount: 0,
    matchedExpected: "",
    error: error.message,
  }));
}

async function attemptTopLikedCommentReply(page, text, options = {}) {
  const replyClick = options.replyClick || await clickTopLikedCommentReply(page, text);
  if (!replyClick.clicked) {
    return {
      filled: false,
      sent: false,
      selector: "",
      replyClick,
      postButton: {
        found: false,
        selector: COMMENT_POST_SELECTOR,
      },
      attemptedText: text,
    };
  }

  const target = await waitForCommentEditor(page, 6_000, {
    mode: "reply",
    anchorY: replyClick.y,
  });
  if (!target) {
    return {
      filled: false,
      sent: false,
      selector: "",
      replyClick,
      postButton: {
        found: false,
        selector: COMMENT_POST_SELECTOR,
      },
      attemptedText: text,
    };
  }

  await page.mouse.click(target.x, target.y).catch(() => {});
  await page.waitForTimeout(400);
  const filled = await setFocusedCommentText(page, text);
  const beforeSendState = filled
    ? await getExistingCommentState(page, text)
    : null;
  const sendResult = filled
    ? await sendCommentWithRetries(page, {
      text,
      mode: "reply",
      anchorY: replyClick.y,
      editorTagId: target.editorTagId,
      beforeState: beforeSendState,
      maxAttempts: 6,
    })
    : {
      sent: false,
      sendVerified: false,
      sendVerification: {
        confirmed: false,
        inputCleared: false,
        buttonDisabledOrGone: false,
        commentStateAdvanced: false,
        commentState: beforeSendState,
      },
      postButton: {
        found: false,
        selector: COMMENT_POST_SELECTOR,
      },
      attempts: 0,
    };
  const result = {
    filled,
    sent: Boolean(sendResult.sent),
    sendVerified: Boolean(sendResult.sendVerified),
    sendVerification: sendResult.sendVerification,
    commentStateAfterSend: sendResult.sendVerification?.commentState || null,
    selector: target.description || "reply-input",
    replyClick,
    postButton: sendResult.postButton,
    sendAttempts: sendResult.attempts,
    attemptedText: text,
  };
  return result;
}

async function replyToTopLikedComment(page, text) {
  const firstAttempt = await attemptTopLikedCommentReply(page, text);
  if (firstAttempt.sendVerified) {
    return firstAttempt;
  }

  const retryText = getAlternateCommentDraft(text);
  const secondAttempt = await attemptTopLikedCommentReply(page, retryText, {
    replyClick: firstAttempt.replyClick?.clicked ? firstAttempt.replyClick : undefined,
  });

  return {
    ...secondAttempt,
    initialAttemptedText: firstAttempt.attemptedText || text,
    retried: true,
    retryAttemptedText: secondAttempt.attemptedText || retryText,
    firstAttempt,
  };
}

async function clickTopLikedCommentReply(page, expectedText = "") {
  const target = await page.evaluate(expected => {
    const isVisible = element => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 8 &&
        rect.height > 8 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.left > window.innerWidth * 0.5 &&
        rect.top < window.innerHeight
      );
    };

    const parseLikeCount = value => {
      const text = String(value || "").replace(/,/g, "").trim().toLowerCase();
      if (!text || /\d{4}-\d{1,2}-\d{1,2}/.test(text) || /^\d{1,2}-\d{1,2}$/.test(text)) return 0;
      const match = text.match(/(\d+(?:\.\d+)?)\s*([km])?\b/);
      if (!match) return 0;
      const amount = Number(match[1]);
      if (!Number.isFinite(amount)) return 0;
      const unit = match[2] || "";
      if (unit === "k") return Math.round(amount * 1000);
      if (unit === "m") return Math.round(amount * 1000000);
      return Math.round(amount);
    };

    const exactLikeCount = value => {
      const text = String(value || "").replace(/,/g, "").trim().toLowerCase();
      if (!text || /\d{4}-\d{1,2}-\d{1,2}/.test(text) || /^\d{1,2}-\d{1,2}$/.test(text)) return 0;
      if (!/^\d+(?:\.\d+)?\s*[km]?$/.test(text)) return 0;
      return parseLikeCount(text);
    };

    const getLikeCountFromContainer = container => {
      const likeButtons = Array.from(container.querySelectorAll('[aria-label*="Like video" i], [role="button"][aria-label*="like" i]'))
        .filter(isVisible);
      const directCounts = likeButtons.map(button => {
        const aria = button.getAttribute("aria-label") || "";
        const text = (button.innerText || button.textContent || "").replace(/\s+/g, " ").trim();
        return Math.max(parseLikeCount(aria), exactLikeCount(text));
      });
      return directCounts.reduce((max, value) => Math.max(max, value), 0);
    };

    const likeCandidates = Array.from(document.querySelectorAll("button, [role='button'], span, strong, div"))
      .map(element => {
        if (!isVisible(element)) return null;
        const rect = element.getBoundingClientRect();
        if (rect.left < window.innerWidth * 0.68 || rect.width > 160 || rect.height > 80) return null;
        const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
        const meta = [
          element.getAttribute("aria-label"),
          element.getAttribute("data-e2e"),
          element.className,
        ].join(" ").toLowerCase();
        const likeCount = Math.max(
          exactLikeCount(text),
          meta.includes("like") ? parseLikeCount(`${element.getAttribute("aria-label") || ""} ${text}`) : 0,
        );
        if (!likeCount) return null;
        return {
          likeCount,
          centerY: rect.top + rect.height / 2,
          left: rect.left,
        };
      })
      .filter(Boolean);

    const ownText = String(expected || "").replace(/\s+/g, " ").trim();
    const replyTargets = Array.from(document.querySelectorAll("button, [role='button'], span, div"))
      .map((element, index) => {
        if (!isVisible(element)) return null;
        const label = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (label !== "reply" && label !== "回复") return null;
        const rect = element.getBoundingClientRect();
        let container = element;
        for (let depth = 0; depth < 7 && container?.parentElement; depth += 1) {
          const parent = container.parentElement;
          const parentRect = parent.getBoundingClientRect();
          const parentText = (parent.innerText || parent.textContent || "").replace(/\s+/g, " ").trim();
          if (
            parentRect.left > window.innerWidth * 0.45 &&
            parentRect.height >= 32 &&
            parentRect.height <= 360 &&
            parentText.length >= label.length
          ) {
            container = parent;
          }
        }
        const containerRect = container.getBoundingClientRect();
        const commentText = (container.innerText || container.textContent || "").replace(/\s+/g, " ").trim();
        if (ownText && commentText.includes(ownText)) return null;

        const replyY = rect.top + rect.height / 2;
        const containerLikeCount = getLikeCountFromContainer(container);
        const rowLikeCount = likeCandidates
          .filter(candidate => (
            Math.abs(candidate.centerY - replyY) <= 48 ||
            (candidate.centerY >= containerRect.top - 8 && candidate.centerY <= containerRect.bottom + 8)
          ))
          .reduce((max, candidate) => Math.max(max, candidate.likeCount), 0);
        const likeCount = Math.max(containerLikeCount, rowLikeCount);

        return {
          x: rect.left + rect.width / 2,
          y: replyY,
          likeCount,
          commentIndex: index,
          commentText: commentText.slice(0, 160),
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.likeCount - a.likeCount || a.commentIndex - b.commentIndex);

    return replyTargets[0] || null;
  }, expectedText).catch(() => null);

  if (!target) {
    return {
      clicked: false,
      description: "top-liked-comment-reply-not-found",
    };
  }

  await page.mouse.click(target.x, target.y).catch(() => {});
  await page.waitForTimeout(900);
  return {
    clicked: true,
    x: Math.round(target.x),
    y: Math.round(target.y),
    likeCount: target.likeCount || 0,
    commentIndex: target.commentIndex || 0,
    description: `top-liked-comment-reply likes=${target.likeCount || 0}`.trim(),
  };
}

async function waitForVisibleComments(page, timeoutMs = 6_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const found = await page.evaluate(() => {
      const isVisible = element => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          rect.width > 20 &&
          rect.height > 12 &&
          rect.bottom > 0 &&
          rect.right > 0
        );
      };
      const containers = Array.from(document.querySelectorAll([
        '[data-e2e*="comment" i]',
        '[class*="Comment" i]',
        '[class*="comment" i]',
      ].join(","))).filter(isVisible);
      return containers.some(element => {
        const text = (element.innerText || element.textContent || "").trim();
        return text.includes("Comments") || text.includes("Add comment") || text.length > 20;
      });
    }).catch(() => false);
    if (found) return true;
    await page.waitForTimeout(300);
  }

  return false;
}

async function waitForCommentPanelReady(page, timeoutMs = 12_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await dismissTikTokOverlayDialogs(page);
    const ready = await page.evaluate(() => {
      const isVisible = element => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          rect.width > 20 &&
          rect.height > 12 &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.left > window.innerWidth * 0.5
        );
      };
      const editor = Array.from(document.querySelectorAll([
        '[data-e2e="comment-input"]',
        '[data-e2e="comment-text"]',
        '[contenteditable="true"][role="textbox"]',
        '[contenteditable="true"]',
        'textarea[placeholder*="comment" i]',
      ].join(","))).some(isVisible);
      if (editor) return true;

      const commentText = Array.from(document.querySelectorAll([
        '[data-e2e="comment-level-1"]',
        '[data-e2e="comment-item"]',
        '[data-e2e*="comment" i]',
        '[class*="CommentItem" i]',
        '[class*="comment-item" i]',
        '[class*="DivComment" i]',
      ].join(",")))
        .filter(isVisible)
        .map(element => (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim())
        .filter(text => (
          text.length > 8 &&
          !/^comments$/i.test(text) &&
          !/^you may like$/i.test(text)
        ))
        .join(" ");

      return commentText.length > 20;
    }).catch(() => false);
    if (ready) return true;
    await page.waitForTimeout(350);
  }

  return false;
}

async function dismissTikTokOverlayDialogs(page) {
  const target = await page.evaluate(() => {
    const isVisible = element => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 12 &&
        rect.height > 12 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top >= 0 &&
        rect.left >= 0
      );
    };

    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;
    const candidates = Array.from(document.querySelectorAll("button, [role='button'], [aria-label]"))
      .map(element => {
        if (!isVisible(element)) return null;
        const rect = element.getBoundingClientRect();
        const aria = (element.getAttribute("aria-label") || "").toLowerCase();
        const text = (element.innerText || element.textContent || "").trim().toLowerCase();
        const looksClose = (
          aria === "close" ||
          aria.includes("close") ||
          text === "×" ||
          text === "x"
        );
        if (!looksClose) return null;
        const inCentralOverlay = (
          rect.left > centerX - 260 &&
          rect.right < centerX + 260 &&
          rect.top > centerY - 260 &&
          rect.bottom < centerY + 260
        );
        if (!inCentralOverlay) return null;
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.y - b.y);

    if (candidates[0]) return candidates[0];

    const shareDialog = Array.from(document.querySelectorAll("div, section, aside"))
      .map(element => {
        if (!isVisible(element)) return null;
        const rect = element.getBoundingClientRect();
        const text = (element.innerText || element.textContent || "").toLowerCase();
        const looksLikeShare = text.includes("share to") || text.includes("repost") || text.includes("copy") || text.includes("whatsapp");
        const centered = (
          rect.left > centerX - 420 &&
          rect.right < centerX + 420 &&
          rect.top > centerY - 360 &&
          rect.bottom < centerY + 360
        );
        if (!looksLikeShare || !centered) return null;
        return { element, rect, area: rect.width * rect.height };
      })
      .filter(Boolean)
      .sort((a, b) => b.area - a.area)[0];

    if (shareDialog) {
      const dialogRect = shareDialog.rect;
      const closeTarget = Array.from(shareDialog.element.querySelectorAll("button, [role='button'], [aria-label], svg, div"))
        .map(element => {
          if (!isVisible(element)) return null;
          const clickable = element.closest("button, [role='button'], [aria-label]") || element;
          if (!isVisible(clickable)) return null;
          const rect = clickable.getBoundingClientRect();
          const aria = (clickable.getAttribute("aria-label") || element.getAttribute("aria-label") || "").toLowerCase();
          const text = (clickable.innerText || clickable.textContent || element.textContent || "").trim().toLowerCase();
          const nearTopRight = rect.left > dialogRect.right - 90 && rect.top < dialogRect.top + 90;
          const looksClose = aria.includes("close") || text === "×" || text === "x" || nearTopRight;
          if (!looksClose || rect.width > 80 || rect.height > 80) return null;
          return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.y - b.y || b.x - a.x)[0];
      if (closeTarget) return closeTarget;
    }

    const captchaDialog = Array.from(document.querySelectorAll("div, section, aside"))
      .map(element => {
        if (!isVisible(element)) return null;
        const rect = element.getBoundingClientRect();
        const text = (element.innerText || element.textContent || "").toLowerCase();
        const looksLikeCaptcha = (
          text.includes("drag the slider") ||
          text.includes("fit the puzzle") ||
          text.includes("captcha") ||
          text.includes("verify") ||
          text.includes("验证")
        );
        const centered = (
          rect.left > centerX - 360 &&
          rect.right < centerX + 360 &&
          rect.top > centerY - 330 &&
          rect.bottom < centerY + 330
        );
        if (!looksLikeCaptcha || !centered) return null;
        return { element, rect, area: rect.width * rect.height };
      })
      .filter(Boolean)
      .sort((a, b) => b.area - a.area)[0];

    if (!captchaDialog) return null;
    const dialogRect = captchaDialog.rect;
    const closeFallback = Array.from(captchaDialog.element.querySelectorAll("button, [role='button'], [aria-label], svg, div"))
      .map(element => {
        if (!isVisible(element)) return null;
        const clickable = element.closest("button, [role='button'], [aria-label]") || element;
        if (!isVisible(clickable)) return null;
        const rect = clickable.getBoundingClientRect();
        const smallEnough = rect.width <= 64 && rect.height <= 64;
        const nearTopRight = (
          rect.left > dialogRect.right - 90 &&
          rect.right <= dialogRect.right + 8 &&
          rect.top >= dialogRect.top &&
          rect.top < dialogRect.top + 80
        );
        if (!smallEnough || !nearTopRight) return null;
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.y - b.y || b.x - a.x);

    return closeFallback[0] || null;
  }).catch(() => null);

  if (!target) return false;
  await page.mouse.click(target.x, target.y).catch(() => {});
  await page.waitForTimeout(500);
  return true;
}

async function clickCommentsTabIfVisible(page) {
  const state = await page.evaluate(() => {
    const isVisible = element => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 20 &&
        rect.height > 12 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top >= 0 &&
        rect.top < window.innerHeight * 0.25 &&
        rect.left > window.innerWidth * 0.55
      );
    };

    const tabItems = Array.from(document.querySelectorAll("button, [role='tab'], [role='button'], div, span"))
      .map(element => {
        if (!isVisible(element)) return null;
        const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
        const rect = element.getBoundingClientRect();
        if (text !== "Comments" && text !== "Creator videos" && text !== "You may like") return null;
        const selected = (
          element.getAttribute("aria-selected") === "true" ||
          element.getAttribute("data-state") === "selected" ||
          element.getAttribute("aria-current") === "page" ||
          element.className.toString().toLowerCase().includes("active")
        );
        return {
          text,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          selected,
          tabScore: (element.getAttribute("role") === "tab" ? 100 : 0) + (element.tagName === "BUTTON" ? 40 : 0),
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.tabScore - a.tabScore || a.y - b.y);

    const comments = tabItems.find(item => item.text === "Comments") || null;
    const creator = tabItems.find(item => item.text === "Creator videos" || item.text === "You may like") || null;
    const hasCommentContent = Array.from(document.querySelectorAll([
      '[data-e2e="comment-input"]',
      '[data-e2e="comment-text"]',
      '[data-e2e="comment-level-1"]',
      '[data-e2e="comment-item"]',
      '[class*="CommentItem" i]',
      '[class*="comment-item" i]',
    ].join(","))).some(isVisible);

    return {
      active: Boolean(comments?.selected && !creator?.selected),
      creatorActive: Boolean(creator?.selected && !hasCommentContent),
      target: comments,
    };
  }).catch(() => null);

  if (!state?.target || state.active) return false;
  await page.mouse.click(state.target.x, state.target.y).catch(() => {});
  await page.waitForTimeout(900);
  return true;
}

async function waitForCommentEditor(page, timeoutMs = 8_000, options = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const target = await ensureCommentEditorReady(page, options);
    if (target) return target;
    await page.waitForTimeout(250);
  }

  return null;
}

async function clickCommentActionButton(page) {
  const alreadyOpen = await page.evaluate(() => {
    const isVisible = element => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 20 &&
        rect.height > 12 &&
        rect.bottom > 0 &&
        rect.right > 0
      );
    };
    return Array.from(document.querySelectorAll([
      '[data-e2e="comment-input"]',
      '[data-e2e="comment-text"]',
      '[contenteditable="true"][role="textbox"]',
      'textarea[placeholder*="comment" i]',
    ].join(","))).some(isVisible);
  }).catch(() => false);

  if (alreadyOpen) {
    return {
      clicked: false,
      alreadyOpen: true,
      description: "comment-panel-open",
    };
  }

  await waitForCommentActionReady(page, 12_000);
  const target = await page.evaluate(() => {
    function isVisible(element) {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 12 &&
        rect.height > 12 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth
      );
    }

    const selectors = [
      '[role="button"][data-e2e="comment-icon"][aria-label*="read or add comments" i]',
      '[role="button"][data-e2e="comment-icon"][aria-label*="comments" i]',
      'div[role="button"][data-e2e="comment-icon"]',
      'button[aria-label*="read or add comments" i]',
      'button[aria-label*="add comments" i]',
      '[data-e2e="comment-icon"] button[data-testid="tux-web-icon-button"]',
      '[data-e2e="comment-icon"] button',
      'button:has([data-e2e="comment-icon"])',
      'button:has([data-e2e="comment-count"])',
      '[role="button"][aria-label*="read or add comments" i]',
      '[role="button"][aria-label*="add comments" i]',
      '[role="button"]:has([data-e2e="comment-icon"])',
      '[role="button"]:has([data-e2e="comment-count"])',
    ];

    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    const target = Array.from(document.querySelectorAll(selectors.join(",")))
      .map(element => {
        if (!isVisible(element)) return null;
        const candidate = element.closest('button, [role="button"]') || element;
        const candidateRect = candidate.getBoundingClientRect();
        const aria = [
          element.getAttribute("aria-label"),
          candidate.getAttribute("aria-label"),
        ].join(" ").toLowerCase();
        const text = [
          element.getAttribute("aria-label"),
          element.getAttribute("data-e2e"),
          candidate.getAttribute("aria-label"),
          candidate.getAttribute("data-e2e"),
          element.innerText,
          element.textContent,
          candidate.innerText,
          candidate.textContent,
        ].join(" ").toLowerCase();

        const hasExplicitCommentSignal = (
          aria.includes("read or add comments") ||
          aria.includes("add comments") ||
          element.getAttribute("data-e2e") === "comment-icon" ||
          element.getAttribute("data-e2e") === "comment-count" ||
          candidate.getAttribute("data-e2e") === "comment-icon" ||
          candidate.getAttribute("data-e2e") === "comment-count"
        );
        if (!hasExplicitCommentSignal) return null;
        if (text.trim() === "comments" || text.includes("you may like")) return null;

        let score = 0;
        if (aria.includes("read or add comments")) score += 220;
        if (aria.includes("add comments")) score += 160;
        if (text.includes("comment-count")) score += 60;
        if (text.includes("comment-icon")) score += 60;
        if (candidateRect.left > window.innerWidth * 0.45 && candidateRect.left < window.innerWidth * 0.9) score += 60;
        if (candidateRect.top > window.innerHeight * 0.25) score += 25;
        if (candidateRect.width < 140 && candidateRect.height < 140) score += 25;
        if (text.includes("comments")) score += 20;
        if (candidateRect.top < window.innerHeight * 0.18) score -= 120;

        return {
          score: score +
            (candidate.matches?.('[role="button"][data-e2e="comment-icon"][aria-label*="comments" i]') ? 420 : 0) +
            (candidate.getAttribute("data-e2e") === "comment-icon" ? 320 : 0),
          x: candidateRect.left + candidateRect.width / 2,
          y: candidateRect.top + candidateRect.height / 2,
          aria: candidate.getAttribute("aria-label") || element.getAttribute("aria-label") || "",
          description: `${candidate.tagName.toLowerCase()} ${candidate.getAttribute("aria-label") || element.getAttribute("data-e2e") || ""}`.trim(),
          buttonIndex: buttons.indexOf(candidate),
        };
      })
      .filter(item => item && item.score >= 80)
      .sort((a, b) => b.score - a.score)[0] || null;

    if (!target) return null;

    return target;
  }).catch(() => null);

  if (!target) {
    return {
      clicked: false,
      description: "",
    };
  }

  await page.mouse.click(target.x, target.y).catch(() => {});
  await page.waitForTimeout(1200);
  return {
    clicked: true,
    x: Math.round(target.x),
    y: Math.round(target.y),
    description: target.description,
    aria: target.aria,
  };
}

async function waitForCommentActionReady(page, timeoutMs = 12_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const ready = await page.evaluate(() => {
      const isVisible = element => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          rect.width > 12 &&
          rect.height > 12 &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < window.innerHeight &&
          rect.left < window.innerWidth
        );
      };
      return Array.from(document.querySelectorAll([
        '[role="button"][data-e2e="comment-icon"][aria-label*="read or add comments" i]',
        '[role="button"][data-e2e="comment-icon"][aria-label*="comments" i]',
        'div[role="button"][data-e2e="comment-icon"]',
        'button[aria-label*="read or add comments" i]',
        'button[aria-label*="add comments" i]',
        '[data-e2e="comment-icon"] button[data-testid="tux-web-icon-button"]',
        '[data-e2e="comment-icon"] button',
        'button:has([data-e2e="comment-icon"])',
        'button:has([data-e2e="comment-count"])',
        '[role="button"][aria-label*="read or add comments" i]',
        '[role="button"][aria-label*="add comments" i]',
        '[role="button"]:has([data-e2e="comment-icon"])',
        '[role="button"]:has([data-e2e="comment-count"])',
      ].join(","))).some(isVisible);
    }).catch(() => false);
    if (ready) return true;
    await page.waitForTimeout(400);
  }

  return false;
}

async function ensureCommentEditorReady(page, options = {}) {
  return page.evaluate(({ mode = "main", anchorY = null, preferredEditorTagId = "" }) => {
    function isVisible(element) {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 30 &&
        rect.height > 18 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth
      );
    }

    function assignTag(element, attrName, prefix) {
      if (!element) return "";
      const existing = element.getAttribute(attrName);
      if (existing) return existing;
      window.__codexCommentTargetSeq = (window.__codexCommentTargetSeq || 0) + 1;
      const next = `${prefix}-${window.__codexCommentTargetSeq}`;
      element.setAttribute(attrName, next);
      return next;
    }

    const selectors = [
      '[placeholder*="comment" i]',
      '[data-e2e="comment-input"] [contenteditable="true"]',
      '[data-e2e="comment-text"] [contenteditable="true"]',
      '[data-e2e="comment-input"] [role="textbox"]',
      '[data-e2e="comment-text"] [role="textbox"]',
      'div[role="textbox"][contenteditable="true"]',
      '[contenteditable="true"]',
      'textarea',
    ];
    const explicitCandidates = Array.from(document.querySelectorAll(selectors.join(",")));
    const textCandidates = Array.from(document.querySelectorAll("div, span, p"))
      .filter(element => {
        const text = (element.innerText || element.textContent || "").trim().toLowerCase();
        return (
          (text === "add comment..." || text === "add comment") &&
          !element.closest("button")
        );
      });
    const candidates = Array.from(new Set([...explicitCandidates, ...textCandidates]));
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const active = document.activeElement;
    const selection = window.getSelection();
    const activeEditor = active?.closest?.('textarea, input, [contenteditable="true"], [role="textbox"]');
    const selectionEditor = selection?.anchorNode?.parentElement?.closest?.('textarea, input, [contenteditable="true"], [role="textbox"]');

    const scored = candidates
      .map((element, index) => {
        if (!isVisible(element)) return null;

        const rect = element.getBoundingClientRect();
        const text = [
          element.getAttribute("placeholder"),
          element.getAttribute("aria-label"),
          element.getAttribute("data-e2e"),
          element.textContent,
        ].join(" ").toLowerCase();
        const editable = element.matches('textarea, input, [contenteditable="true"], [role="textbox"]')
          ? element
          : element.querySelector('textarea, input, [contenteditable="true"], [role="textbox"]');
        if (!editable) return null;
        const clickElement = editable || element;
        if (clickElement.closest("button")) return null;
        const clickRect = clickElement.getBoundingClientRect();
        let score = 0;
        if (element.getAttribute("data-e2e") === "comment-input") score += 160;
        if (element.getAttribute("data-e2e") === "comment-text") score += 150;
        if (text.includes("add comment")) score += 120;
        if (text.includes("comment")) score += 60;
        if (editable) score += 50;
        if (clickElement.isContentEditable) score += 30;
        if (clickElement.tagName === "TEXTAREA" || clickElement.tagName === "INPUT") score += 25;
        if (rect.left > viewportWidth * 0.45) score += 35;
        if (rect.width > 180) score += 10;
        const isActive = activeEditor === clickElement || selectionEditor === clickElement;

        if (preferredEditorTagId && clickElement.getAttribute("data-codex-comment-editor-id") === preferredEditorTagId) {
          score += 280;
        }

        if (mode === "reply") {
          if (isActive) score += 260;
          if (text.includes("reply")) score += 150;
          if (Number.isFinite(anchorY)) {
            score += Math.max(0, 220 - Math.abs((clickRect.top + clickRect.bottom) / 2 - anchorY));
          }
          if (rect.bottom < viewportHeight * 0.88) score += 60;
          if (rect.bottom > viewportHeight * 0.9) score -= 220;
          if (rect.top < viewportHeight * 0.78) score += 45;
        } else {
          if (isActive) score += 60;
          if (rect.top > viewportHeight * 0.55) score += 20;
          if (rect.bottom > viewportHeight * 0.78) score += 140;
          if (rect.bottom > viewportHeight * 0.9) score += 80;
          if (text.includes("reply")) score -= 120;
        }

        return {
          index,
          score,
          x: clickRect.left + Math.min(80, Math.max(24, clickRect.width * 0.18)),
          y: clickRect.top + clickRect.height / 2,
          description: `${clickElement.tagName.toLowerCase()} ${clickElement.getAttribute("data-e2e") || element.getAttribute("data-e2e") || ""}`.trim(),
          editorTagId: assignTag(clickElement, "data-codex-comment-editor-id", `comment-editor-${mode}`),
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    return scored[0] || null;
  }, options).catch(() => null);
}

async function setFocusedCommentText(page, text) {
  const selectAllShortcut = process.platform === "darwin" ? "Meta+A" : "Control+A";
  const pasteShortcut = process.platform === "darwin" ? "Meta+V" : "Control+V";

  await page.evaluate(async expected => {
    await navigator.clipboard?.writeText?.(expected).catch(() => {});
  }, text).catch(() => {});
  await page.keyboard.press(selectAllShortcut).catch(() => {});
  await page.keyboard.press(pasteShortcut).catch(() => {});
  await page.waitForTimeout(400).catch(() => {});
  if (await verifyCommentText(page, text)) return true;

  await page.keyboard.press(selectAllShortcut).catch(() => {});
  await page.keyboard.type(text, { delay: 15 }).catch(() => {});
  await page.waitForTimeout(400).catch(() => {});
  if (await verifyCommentText(page, text)) return true;

  return false;
}

async function getCommentPostButton(page, options = {}) {
  const selector = COMMENT_POST_SELECTOR;
  return page.evaluate(({ postSelector, mode = "main", anchorY = null, editorTagId = "" }) => {
    function isVisible(element) {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 8 &&
        rect.height > 8 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth
      );
    }

    function assignTag(element, attrName, prefix) {
      if (!element) return "";
      const existing = element.getAttribute(attrName);
      if (existing) return existing;
      window.__codexCommentTargetSeq = (window.__codexCommentTargetSeq || 0) + 1;
      const next = `${prefix}-${window.__codexCommentTargetSeq}`;
      element.setAttribute(attrName, next);
      return next;
    }

    const editors = Array.from(document.querySelectorAll([
      '[data-codex-comment-editor-id]',
      '[data-e2e="comment-input"] [contenteditable="true"]',
      '[data-e2e="comment-text"] [contenteditable="true"]',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"]',
      'textarea',
      'input',
    ].join(","))).filter(isVisible);

    const editor = (
      (editorTagId && editors.find(element => element.getAttribute("data-codex-comment-editor-id") === editorTagId)) ||
      editors
        .map(element => {
          const rect = element.getBoundingClientRect();
          const text = [
            element.getAttribute("placeholder"),
            element.getAttribute("aria-label"),
            element.getAttribute("data-e2e"),
            element.textContent,
          ].join(" ").toLowerCase();
          let score = 0;
          if (mode === "reply") {
            if (Number.isFinite(anchorY)) {
              score += Math.max(0, 220 - Math.abs((rect.top + rect.bottom) / 2 - anchorY));
            }
            if (rect.bottom < window.innerHeight * 0.88) score += 60;
            if (rect.bottom > window.innerHeight * 0.9) score -= 220;
            if (text.includes("reply")) score += 120;
          } else {
            if (rect.bottom > window.innerHeight * 0.78) score += 160;
            if (rect.bottom > window.innerHeight * 0.9) score += 60;
            if (text.includes("reply")) score -= 100;
          }
          return { element, score };
        })
        .sort((a, b) => b.score - a.score)[0]?.element
    );

    if (!editor) {
      return {
        found: false,
        selector: postSelector,
      };
    }

    const editorId = assignTag(editor, "data-codex-comment-editor-id", `comment-editor-${mode}`);
    const editorRect = editor.getBoundingClientRect();
    const seen = new Set();
    const containers = [];
    let node = editor;
    while (node && containers.length < 8) {
      containers.push(node);
      node = node.parentElement;
    }

    const contextualButtons = containers.flatMap((container, depth) => (
      Array.from(container.querySelectorAll(postSelector)).map(button => ({ button, depth }))
    ));
    const globalButtons = Array.from(document.querySelectorAll(postSelector)).map(button => ({ button, depth: 99 }));

    const candidates = [...contextualButtons, ...globalButtons]
      .filter(({ button }) => {
        if (!isVisible(button)) return false;
        if (seen.has(button)) return false;
        seen.add(button);
        return true;
      })
      .map(({ button, depth }) => {
        const rect = button.getBoundingClientRect();
        const centerY = rect.top + rect.height / 2;
        const editorCenterY = editorRect.top + editorRect.height / 2;
        const verticalOverlap = Math.max(0, Math.min(editorRect.bottom, rect.bottom) - Math.max(editorRect.top, rect.top));
        const horizontalDistance = Math.abs(rect.left - editorRect.right);
        const verticalDistance = Math.abs(centerY - editorCenterY);
        let score = 0;
        if (rect.left >= editorRect.right - 60) score += 220;
        if (verticalOverlap > 0) score += 140;
        if (verticalDistance < Math.max(28, editorRect.height)) score += 120;
        if (depth < 8) score += Math.max(0, 80 - depth * 10);
        score -= Math.min(180, horizontalDistance * 0.6);
        score -= Math.min(220, verticalDistance * 1.2);
        return { button, rect, score };
      })
      .sort((a, b) => b.score - a.score);

    const button = candidates[0]?.button || null;
    if (!button) {
      return {
        found: false,
        selector: postSelector,
        editorTagId: editorId,
      };
    }

    const rect = button.getBoundingClientRect();
    return {
      found: true,
      selector: postSelector,
      editorTagId: editorId,
      tagId: assignTag(button, "data-codex-comment-post-id", `comment-post-${mode}`),
      disabled: Boolean(button.disabled || button.getAttribute("aria-disabled") === "true"),
      rect: {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  }, {
    postSelector: selector,
    ...options,
  }).catch(() => ({
    found: false,
    selector,
  }));
}

async function getCommentPostButtonHandle(page, buttonMeta) {
  const tagId = buttonMeta?.tagId;
  if (!tagId) return null;
  return page.locator(`[data-codex-comment-post-id="${tagId}"]`).elementHandle().catch(() => null);
}

async function waitForCommentPostButtonReady(page, options = {}, timeoutMs = 3_500) {
  const startedAt = Date.now();
  let best = null;
  while (Date.now() - startedAt < timeoutMs) {
    const button = await getCommentPostButton(page, options);
    if (button?.found && !button?.disabled) {
      return button;
    }
    if (button?.found) {
      best = button;
    }
    await page.waitForTimeout(250);
  }
  return best || {
    found: false,
    selector: COMMENT_POST_SELECTOR,
  };
}

async function clickCommentPostButton(page, buttonMeta, buttonHandle) {
  if (!buttonMeta?.found || buttonMeta?.disabled) return false;

  if (buttonHandle) {
    const clicked = await buttonHandle.click({ timeout: 3_000 }).then(() => true).catch(() => false);
    if (clicked) {
      await page.waitForTimeout(500);
      return true;
    }
  }

  const rect = buttonMeta?.rect;
  if (rect) {
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const clicked = await page.mouse.click(x, y).then(() => true).catch(() => false);
    if (clicked) {
      await page.waitForTimeout(500);
      return true;
    }
  }

  return false;
}

async function sendCommentWithRetries(page, {
  text,
  mode = "main",
  anchorY = null,
  editorTagId = "",
  beforeState = null,
  maxAttempts = 6,
} = {}) {
  let lastButton = null;
  let lastVerification = {
    confirmed: false,
    inputCleared: false,
    buttonDisabledOrGone: false,
    commentStateAdvanced: false,
    commentState: beforeState,
  };
  let clicked = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await autoSolveSliderCaptchaIfPresent(page, { maxAttempts: 5 }).catch(() => {});

    const inputStillHasText = await verifyCommentText(page, text);
    if (!inputStillHasText) {
      break;
    }

    const postButton = await waitForCommentPostButtonReady(page, {
      mode,
      anchorY,
      editorTagId,
    }, 4_500);
    lastButton = postButton;

    const postButtonHandle = await getCommentPostButtonHandle(page, postButton);
    const attemptClicked = await clickCommentPostButton(page, postButton, postButtonHandle);
    clicked = clicked || attemptClicked;

    if (!attemptClicked) {
      await page.waitForTimeout(700);
      continue;
    }

    lastVerification = await verifyCommentPostSend(page, {
      text,
      mode,
      anchorY,
      editorTagId,
      beforeState,
      timeoutMs: 5_000,
    });

    if (lastVerification.confirmed) {
      return {
        sent: true,
        sendVerified: true,
        sendVerification: lastVerification,
        postButton: lastVerification.postButton || postButton,
        attempts: attempt,
      };
    }

    await page.waitForTimeout(700 + attempt * 200);
  }

  return {
    sent: clicked,
    sendVerified: false,
    sendVerification: lastVerification,
    postButton: lastVerification.postButton || lastButton || {
      found: false,
      selector: COMMENT_POST_SELECTOR,
    },
    attempts: maxAttempts,
  };
}

async function verifyCommentPostSend(page, {
  text,
  mode = "main",
  anchorY = null,
  editorTagId = "",
  beforeState = null,
  timeoutMs = 6_000,
} = {}) {
  const startedAt = Date.now();
  let lastState = beforeState;
  let lastButton = null;
  let lastInputStillHasText = true;

  while (Date.now() - startedAt < timeoutMs) {
    lastInputStillHasText = await verifyCommentText(page, text);
    lastButton = await getCommentPostButton(page, {
      mode,
      anchorY,
      editorTagId,
    });
    lastState = await getExistingCommentState(page, text);

    const inputCleared = !lastInputStillHasText;
    const buttonDisabledOrGone = !lastButton?.found || Boolean(lastButton?.disabled);
    const commentStateAdvanced = didCommentStateAdvance(beforeState, lastState);
    if (inputCleared || buttonDisabledOrGone || commentStateAdvanced) {
      return {
        confirmed: true,
        inputCleared,
        buttonDisabledOrGone,
        commentStateAdvanced,
        commentState: lastState,
        postButton: lastButton,
      };
    }

    await page.waitForTimeout(350);
  }

  return {
    confirmed: false,
    inputCleared: !lastInputStillHasText,
    buttonDisabledOrGone: !lastButton?.found || Boolean(lastButton?.disabled),
    commentStateAdvanced: didCommentStateAdvance(beforeState, lastState),
    commentState: lastState,
    postButton: lastButton,
  };
}

function didCommentStateAdvance(beforeState, afterState) {
  if (!afterState) return false;
  if (!beforeState) {
    return Boolean(afterState.exists || afterState.commentCount > 0 || afterState.firstThreadText || afterState.existingCommentText);
  }

  return Boolean(
    (!beforeState.exists && afterState.exists) ||
    Number(afterState.commentCount || 0) > Number(beforeState.commentCount || 0) ||
    String(afterState.existingCommentText || "").length > String(beforeState.existingCommentText || "").length ||
    String(afterState.firstThreadText || "").length > String(beforeState.firstThreadText || "").length
  );
}

function attachInternalHandle(target, property, handle) {
  if (!target || !property || !handle) return target;
  Object.defineProperty(target, property, {
    value: handle,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return target;
}

async function verifyCommentText(page, text) {
  return page.evaluate(expected => {
    const active = document.activeElement;
    const editors = Array.from(document.querySelectorAll([
      '[data-e2e="comment-input"]',
      '[data-e2e="comment-text"]',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"]',
    ].join(",")));
    if (active) editors.unshift(active);

    return editors.some(editor => {
      const text = editor?.textContent?.trim?.() || "";
      const spanText = editor?.querySelector?.('span[data-text="true"]')?.textContent?.trim?.() || "";
      return text === expected || spanText === expected;
    });
  }, text).catch(() => false);
}

function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function getRandomCommentDraft() {
  return COMMENT_DRAFTS[Math.floor(Math.random() * COMMENT_DRAFTS.length)] || COMMENT_DRAFT;
}

function getReviewSequenceFailureReason({ blocking = "", focusResult = null, nextResult = null, error = null } = {}) {
  if (error) {
    return `exception: ${error.message}`;
  }

  if (nextResult && !nextResult.ok) {
    return nextResult.message || "next_video_not_available";
  }

  if (blocking) {
    return blocking;
  }

  if (!focusResult) {
    return "comment_flow_not_started";
  }

  if (focusResult.blocking) {
    return focusResult.blocking;
  }

  if (!focusResult.commentClick?.clicked && !focusResult.commentClick?.alreadyOpen) {
    return "comment_panel_not_opened";
  }

  if (!focusResult.filled && !focusResult.replied) {
    return "comment_input_not_found_or_not_fillable";
  }

  if (focusResult.replied && !focusResult.replySendVerified && focusResult.filled && !focusResult.sendVerified) {
    return "reply_and_main_comment_not_verified";
  }

  if (focusResult.replied && !focusResult.replySendVerified) {
    return "top_liked_reply_not_verified";
  }

  if (focusResult.filled && !focusResult.sendVerified) {
    return "main_comment_not_verified";
  }

  if (!focusResult.postButton?.found) {
    return "comment_post_button_not_found";
  }

  if (focusResult.postButton?.disabled) {
    return "comment_post_button_disabled";
  }

  return "comment_send_not_ready";
}

function normalizeKeywordPool(searchKeyword = "", keywordPool = []) {
  const items = [];
  const seen = new Set();

  const pushKeyword = value => {
    const normalized = String(value || "").trim();
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    items.push(normalized);
  };

  pushKeyword(searchKeyword);
  for (const keyword of keywordPool || []) {
    pushKeyword(keyword);
  }

  return items;
}

function getAlternateCommentDraft(excludedText = "") {
  const normalizedExcluded = String(excludedText || "").trim();
  const alternatives = COMMENT_DRAFTS.filter(item => String(item || "").trim() && String(item || "").trim() !== normalizedExcluded);
  return alternatives[Math.floor(Math.random() * alternatives.length)] || getRandomCommentDraft();
}

async function openVideoFromCurrentSearchPage(page, href) {
  if (!page) {
    return {
      page: null,
      href: "",
    };
  }

  const candidates = await page.evaluate(targetHref => {
    const isVisible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 24 &&
        rect.height > 24 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth
      );
    };

    const normalizeHref = value => String(value || "").split("?")[0];
    const makeTag = (element, index) => {
      const id = `search-open-target-${Date.now()}-${index}`;
      element.setAttribute("data-codex-open-target", id);
      return id;
    };
    const serializeRect = rect => ({
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      right: Math.round(rect.right),
      bottom: Math.round(rect.bottom),
    });

    const anchors = Array.from(document.querySelectorAll('a[href*="/video/"]')).filter(isVisible);
    const target = targetHref
      ? anchors.find(item => item.href === targetHref) || anchors.find(item => normalizeHref(item.href) === normalizeHref(targetHref)) || anchors[0]
      : anchors[0];
    if (!target) return [];

    const container =
      target.closest('[data-e2e*="search"]') ||
      target.closest("div[data-e2e]") ||
      target.closest("article") ||
      target.parentElement;

    const tagged = [];
    const seen = new Set();
    const pushCandidate = (element, kind, priority) => {
      if (!element || !isVisible(element)) return;
      if (seen.has(element)) return;
      if (element.tagName?.toLowerCase?.() === "a") return;
      seen.add(element);
      const rect = element.getBoundingClientRect();
      tagged.push({
        targetId: makeTag(element, tagged.length),
        kind,
        priority,
        rect: serializeRect(rect),
        clickPoint: {
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + Math.min(rect.height * 0.42, Math.max(32, rect.height / 2))),
        },
      });
    };

    const preview = Array.from((container || target).querySelectorAll("video, img, canvas"))
      .find(element => isVisible(element) && !element.closest('a[href*="/video/"]'));
    pushCandidate(preview, "preview", 1);

    const interactiveWithinContainer = Array.from((container || target).querySelectorAll([
      '[role="link"]',
      '[role="button"]',
      'button',
      '[data-e2e*="search"]',
    ].join(",")))
      .find(element => element !== target && element.tagName.toLowerCase() !== "a" && isVisible(element));
    pushCandidate(interactiveWithinContainer, "interactive", 2);

    if (container && container !== target) {
      pushCandidate(container, "container-card", 0);
    }

    return tagged.sort((a, b) => a.priority - b.priority);
  }, href).catch(() => []);

  for (const candidate of candidates) {
    const selector = `[data-codex-open-target="${candidate.targetId}"]`;
    const clickTarget = page.locator(selector).first();
    const clickedHref = await clickTarget.getAttribute("href").catch(() => "");

    await clickTarget.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(700);
    const clickPoint = await page.evaluate(targetId => {
      const element = document.querySelector(`[data-codex-open-target="${targetId}"]`);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + Math.min(rect.height * 0.42, Math.max(32, rect.height / 2)),
      };
    }, candidate.targetId).catch(() => null);
    if (clickPoint) {
      await page.mouse.move(clickPoint.x, clickPoint.y).catch(() => {});
      await page.waitForTimeout(180).catch(() => {});
      await page.mouse.click(clickPoint.x, clickPoint.y).catch(async () => {
        await clickTarget.click({ force: true, timeout: 8000 }).catch(() => {});
      });
    } else {
      await clickTarget.click({ timeout: 8000 }).catch(async () => {
        await clickTarget.click({ force: true, timeout: 8000 }).catch(() => {});
      });
    }
    await page.waitForTimeout(2500);

    const openedCinema = await isCinemaModeOpen(page);
    const openedDetail = page.url().includes("/video/");

    if (openedCinema || openedDetail) {
      return {
        page,
        href: clickedHref || page.url(),
      };
    }

  }

  return {
    page: null,
    href: "",
  };
}

function getSearchUrlFromVideoHref(href, fallbackKeyword = "") {
  const keyword = String(fallbackKeyword || "").trim();
  if (keyword) {
    return `https://www.tiktok.com/search/video?q=${encodeURIComponent(keyword)}`;
  }
  try {
    const parsed = new URL(href);
    const query = parsed.searchParams.get("q") || parsed.searchParams.get("keyword") || "";
    if (!query) return "";
    return `https://www.tiktok.com/search/video?q=${encodeURIComponent(query)}`;
  } catch {
    return "";
  }
}

async function openFirstSequentialVideoPage(context, href, searchKeyword = "") {
  const page = context.pages()[0] || await context.newPage();
  const searchUrl = getSearchUrlFromVideoHref(href, searchKeyword);
  if (searchUrl) {
    try {
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await waitForResultsOrBlocking(page, 35_000).catch(() => {});
      await page.waitForTimeout(1500);
      const openedFromSearch = await openVideoFromCurrentSearchPage(page, href);
      if (openedFromSearch.page) return openedFromSearch;
    } catch {
      // Keep failing closed: do not fall back to direct detail-page navigation.
    }
  }

  if (page.url().includes("/search/video")) {
    const openedFromList = await openVideoFromCurrentSearchPage(page, href);
    if (openedFromList.page) return openedFromList;
  }

  page.openError = new Error("cinema_mode_required");
  return {
    page: null,
    href: "",
  };
}

async function reopenSequenceWithNextKeyword(context, job) {
  const pool = Array.isArray(job?.keywordPool) ? job.keywordPool : [];
  for (let index = Number(job?.keywordIndex || 0) + 1; index < pool.length; index += 1) {
    const keyword = String(pool[index] || "").trim();
    if (!keyword) continue;
    const opened = await openFirstSequentialVideoPage(context, "", keyword);
    if (opened.page) {
      job.keywordIndex = index;
      job.currentKeyword = keyword;
      return {
        ok: true,
        keyword,
        page: opened.page,
      };
    }
  }

  return {
    ok: false,
    keyword: "",
    page: null,
    message: "keyword_pool_exhausted",
  };
}

async function keepOnlyPrimaryPage(context) {
  const pages = context.pages();
  const primary = pages[0] || await context.newPage();
  for (const page of pages.slice(1)) {
    await page.close().catch(() => {});
  }
  return primary;
}

async function openVideoPage(page, href) {
  page.openError = null;
  try {
    await page.goto(href, { waitUntil: "domcontentloaded", timeout: 45000 });
  } catch (error) {
    page.openError = error;
  }
  await page.waitForTimeout(3000).catch(() => {});
  return page;
}

async function getCurrentVideoHref(page) {
  return page.evaluate(() => {
    const isVisible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 100 &&
        rect.height > 100 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth
      );
    };
    const cinemaRoot = Array.from(document.querySelectorAll('[data-cinema-mode-overlay-root="current"]'))
      .find(isVisible);
    const cinemaRow = cinemaRoot?.querySelector("[data-cinema-mode-snap-row]");
    const cinemaId = isVisible(cinemaRow) ? cinemaRow?.getAttribute?.("data-cinema-mode-snap-row") || "" : "";
    if (cinemaId) return `cinema:${cinemaId}`;

    const href = location.href || "";
    if (!href.includes("/video/")) return "";

    const canonical = document.querySelector('link[rel="canonical"]')?.href || "";
    return canonical.includes("/video/") ? canonical : href;
  }).catch(() => page.url());
}

async function isCinemaModeOpen(page) {
  return page.evaluate(() => {
    const isVisible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 100 &&
        rect.height > 100 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth
      );
    };
    return Array.from(document.querySelectorAll('[data-cinema-mode-overlay-root="current"]'))
      .some(isVisible);
  }).catch(() => false);
}

async function moveToNextVideoInSamePage(page, previousHref = "") {
  const startedInCinema = await isCinemaModeOpen(page);
  await dismissTikTokOverlayDialogs(page).catch(() => {});
  if (!startedInCinema) {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(300);
    await dismissTikTokOverlayDialogs(page).catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
  }
  await page.evaluate(() => {
    document.activeElement?.blur?.();
  }).catch(() => {});
  await page.waitForTimeout(300);

  const clicked = await page.evaluate(() => {
    const isVisible = element => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 24 &&
        rect.height > 24 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth
      );
    };

    const explicitNextButton = Array.from(document.querySelectorAll([
      'button[aria-label="Next video"]',
      'button[aria-label*="Next video" i]',
      '[data-testid="tux-web-button-container"] button[aria-label*="Next" i]',
      '[data-testid="tux-web-button-container"] button[aria-label*="Down" i]',
    ].join(",")))
      .filter(isVisible)
      .map(element => {
        const rect = element.getBoundingClientRect();
        return {
          element,
          score: 1000 + rect.top,
        };
      });

    const controls = explicitNextButton.sort((a, b) => b.score - a.score);

    const target = controls[0]?.element;
    if (!target) return false;
    target.click();
    return true;
  }).catch(() => false);

  if (!clicked) {
    await page.mouse.move(BROWSER_VIEWPORT.width * 0.45, BROWSER_VIEWPORT.height * 0.5).catch(() => {});
    await page.mouse.wheel(0, 1200).catch(() => {});
    await page.keyboard.press("ArrowDown").catch(() => {});
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    await page.waitForTimeout(500);
    const href = await getCurrentVideoHref(page);
    if (href && href !== previousHref) {
      const stillInCinema = await isCinemaModeOpen(page);
      if (startedInCinema && !stillInCinema) {
        return {
          ok: false,
          href,
          clicked,
          message: "next_video_left_cinema_mode",
        };
      }
      await waitForCommentPanelReady(page, 8_000);
      return {
        ok: true,
        href,
        clicked,
      };
    }
  }

  return {
    ok: false,
    href: await getCurrentVideoHref(page),
    clicked,
    message: "next_video_not_changed",
  };
}

async function diagnoseVideoNavigation(args = {}) {
  const href = String(args.href || "").trim();
  const chromeProfileName = String(args.chromeProfileName || "").trim();
  if (!href) {
    return {
      ok: false,
      message: "href is required",
    };
  }

  const context = await getRetainedContext({
    headed: true,
    syncSystemProfile: false,
    chromeProfileName,
  });
  await keepOnlyPrimaryPage(context);

  const opened = await openFirstSequentialVideoPage(context, href);
  const page = opened.page;
  if (!page) {
    return {
      ok: false,
      href,
      message: "cinema_mode_required",
    };
  }
  await page.waitForTimeout(2500).catch(() => {});

  const before = await getCurrentVideoHref(page);
  const pageState = await inspectVideoNavigationState(page);

  await page.mouse.move(BROWSER_VIEWPORT.width * 0.45, BROWSER_VIEWPORT.height * 0.5).catch(() => {});
  await page.mouse.wheel(0, 1200).catch(() => {});
  await page.keyboard.press("ArrowDown").catch(() => {});
  await page.waitForTimeout(2500).catch(() => {});
  const afterWheel = await getCurrentVideoHref(page);

  let afterNextClick = "";
  if (pageState.nextButtons.length > 0 && afterWheel === before) {
    await page.evaluate(() => {
      const target = Array.from(document.querySelectorAll([
        'button[aria-label="Next video"]',
        'button[aria-label*="Next video" i]',
        '[data-testid="tux-web-button-container"] button[aria-label*="Next" i]',
        '[data-testid="tux-web-button-container"] button[aria-label*="Down" i]',
      ].join(","))).find(element => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          rect.width > 24 &&
          rect.height > 24 &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < window.innerHeight &&
          rect.left < window.innerWidth
        );
      });
      target?.click?.();
    }).catch(() => {});
    await page.waitForTimeout(2500).catch(() => {});
    afterNextClick = await getCurrentVideoHref(page);
  }

  const afterState = await inspectVideoNavigationState(page);
  const screenshotPath = await saveDebugScreenshot(page, "video-navigation-diagnostic");
  await page.close().catch(() => {});

  return {
    ok: true,
    href,
    openedHref: opened.href,
    before,
    afterWheel,
    afterNextClick,
    wheelChangedVideo: Boolean(afterWheel && afterWheel !== before),
    nextButtonChangedVideo: Boolean(afterNextClick && afterNextClick !== before),
    pageState,
    afterState,
    screenshotPath,
  };
}

async function inspectVideoNavigationState(page) {
  return page.evaluate(() => {
    const isVisible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth
      );
    };

    const nextButtons = Array.from(document.querySelectorAll([
      'button[aria-label="Next video"]',
      'button[aria-label*="Next video" i]',
      '[data-testid="tux-web-button-container"] button[aria-label*="Next" i]',
      '[data-testid="tux-web-button-container"] button[aria-label*="Down" i]',
    ].join(",")))
      .filter(isVisible)
      .map(element => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          ariaLabel: element.getAttribute("aria-label") || "",
          dataTestId: element.getAttribute("data-testid") || element.closest("[data-testid]")?.getAttribute("data-testid") || "",
          text: (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim(),
          rect: {
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      });

    const visibleCinemaRoot = Array.from(document.querySelectorAll('[data-cinema-mode-overlay-root="current"]'))
      .find(isVisible) || null;
    const cinemaRows = Array.from((visibleCinemaRoot || document).querySelectorAll("[data-cinema-mode-snap-row]"))
      .filter(isVisible)
      .map(element => element.getAttribute("data-cinema-mode-snap-row") || "")
      .filter(Boolean);

    return {
      url: location.href,
      title: document.title,
      isCinemaMode: Boolean(visibleCinemaRoot),
      cinemaRows,
      nextButtons,
      bodyText: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 1000),
    };
  }).catch(error => ({
    error: error.message,
  }));
}

async function saveDebugScreenshot(page, label) {
  try {
    ensureDir(SEARCH_DATA_DIR);
    const filePath = path.join(SEARCH_DATA_DIR, `${label}-${timestamp()}.png`);
    await page.screenshot({ path: filePath, fullPage: false });
    return filePath;
  } catch {
    return "";
  }
}

function getReviewSequenceStatus() {
  const facebookStatus = getFacebookReviewSequenceStatus();
  if (facebookStatus.running || facebookStatus.results.length) {
    return facebookStatus;
  }

  if (!reviewSequenceJob) {
    return {
      channel: "tiktok",
      running: false,
      total: 0,
      current: 0,
      currentHref: "",
      completed: 0,
      skipped: 0,
      failed: 0,
      results: [],
      paused: false,
      pauseReason: "",
      pauseMessage: "",
      currentKeyword: "",
      remainingKeywords: 0,
    };
  }

  return {
    channel: "tiktok",
    running: reviewSequenceJob.running,
    paused: reviewSequenceJob.paused,
    pauseReason: reviewSequenceJob.pauseReason,
    pauseMessage: reviewSequenceJob.pauseMessage,
    total: reviewSequenceJob.maxVideos || reviewSequenceJob.hrefs.length,
    current: reviewSequenceJob.current,
    currentHref: reviewSequenceJob.currentHref,
    completed: reviewSequenceJob.completed,
    skipped: reviewSequenceJob.skipped || 0,
    failed: reviewSequenceJob.failed,
    detectedOwnComment: reviewSequenceJob.detectedOwnComment || 0,
    results: reviewSequenceJob.results || [],
    currentKeyword: reviewSequenceJob.currentKeyword || "",
    remainingKeywords: Math.max(0, (reviewSequenceJob.keywordPool || []).length - (reviewSequenceJob.keywordIndex || 0) - 1),
  };
}

async function stopReviewSequence() {
  const facebookStatus = getFacebookReviewSequenceStatus();
  if (facebookStatus.running) {
    const result = await stopFacebookReviewSequence();
    await closeRetainedAutomationContext();
    return {
      ...result,
      message: "已停止 Facebook 队列，并关闭当前自动化浏览器窗口。",
      ...getReviewSequenceStatus(),
    };
  }

  if (!reviewSequenceJob?.running) {
    await closeRetainedAutomationContext();
    return {
      ok: true,
      message: "当前没有正在运行的队列。",
      ...getReviewSequenceStatus(),
    };
  }

  reviewSequenceJob.cancelled = true;
  if (reviewSequenceJob.paused && reviewSequenceJob.resume) {
    const resume = reviewSequenceJob.resume;
    reviewSequenceJob.resume = null;
    reviewSequenceJob.paused = false;
    resume();
  }
  reviewSequenceJob.running = false;

  await closeRetainedAutomationContext();

  return {
    ok: true,
    message: "已停止队列，并关闭当前自动化浏览器窗口。",
    ...getReviewSequenceStatus(),
  };
}

async function closeRetainedAutomationContext() {
  const pages = Array.from(retainedVideoPages);
  retainedVideoPages.clear();

  await Promise.allSettled(pages.map(page => page.close().catch(() => {})));

  if (retainedContext) {
    const context = retainedContext;
    retainedContext = null;
    retainedContextProfileName = null;
    await context.close().catch(() => {});
  }
}

function startReviewSequence(args = {}) {
  const channel = String(args.channel || "tiktok").trim().toLowerCase();
  if (channel === "facebook") {
    return startFacebookReviewSequence({
      ...args,
      commentDrafts: COMMENT_DRAFTS,
      defaultComment: COMMENT_DRAFT,
    }, {
      BROWSER_PROFILE_DIR,
      BROWSER_VIEWPORT,
      chromium,
      dismissCommonPrompts,
      getRetainedContext,
      keepOnlyPrimaryPage,
      launchPersistentBrowserContext,
      resolveChromeProfileName,
      saveDebugScreenshot,
    });
  }

  const hrefs = Array.from(new Set((args.hrefs || []).filter(Boolean)));
  const requestedMaxVideos = Number.isFinite(Number(args.maxVideos)) ? Number(args.maxVideos) : hrefs.length;
  const maxVideos = Math.max(1, Math.min(Math.floor(requestedMaxVideos), 100000));
  const requestedHoldMs = Number.isFinite(Number(args.holdMs)) ? Number(args.holdMs) : 10_000;
  const requestedRandomHoldMs = Number.isFinite(Number(args.randomHoldMs)) ? Number(args.randomHoldMs) : 10_000;
  const holdMs = Math.max(5_000, Math.min(requestedHoldMs, 900_000));
  const randomHoldMs = Math.max(0, Math.min(requestedRandomHoldMs, 300_000));
  const chromeProfileName = String(args.chromeProfileName || "").trim();
  const searchKeyword = String(args.searchKeyword || "").trim();
  const keywordPool = normalizeKeywordPool(searchKeyword, args.keywordPool || []);

  if (!hrefs.length) {
    return {
      ok: false,
      message: "No video links provided for review sequence.",
    };
  }

  if (reviewSequenceJob?.running) {
    reviewSequenceJob.cancelled = true;
  }

  const job = {
    hrefs,
    maxVideos,
    holdMs,
    randomHoldMs,
    chromeProfileName,
    searchKeyword,
    keywordPool,
    keywordIndex: 0,
    currentKeyword: keywordPool[0] || searchKeyword,
    running: true,
    cancelled: false,
    paused: false,
    pauseReason: "",
    pauseMessage: "",
    pausedHref: "",
    resume: null,
    current: 0,
    currentHref: "",
    completed: 0,
    skipped: 0,
    failed: 0,
    detectedOwnComment: 0,
    results: [],
  };
  reviewSequenceJob = job;

  (async () => {
    const context = await getRetainedContext({
      headed: true,
      syncSystemProfile: false,
      chromeProfileName,
    });
    await keepOnlyPrimaryPage(context);

    let page = null;
    let keepPageOpenAfterRun = true;
    for (let index = 0; index < maxVideos; index += 1) {
      if (job.cancelled) break;

      if (index === 0) {
        const openedFromList = await openFirstSequentialVideoPage(context, hrefs[0], job.currentKeyword || searchKeyword);
        page = openedFromList.page;
        if (!page) {
          const fallbackTheme = await reopenSequenceWithNextKeyword(context, job);
          if (!fallbackTheme.ok) {
            job.failed += 1;
            keepPageOpenAfterRun = true;
            job.results.push({
              href: hrefs[0] || "",
              status: "failed",
              alreadyCommented: false,
              ownCommentDetected: false,
              commentCount: 0,
              firstCommentMatches: false,
              firstThreadHasDraft: false,
              filled: false,
              replied: false,
              sent: false,
              replySent: false,
              sendVerified: false,
              replySendVerified: false,
              blocking: "cinema_mode_required",
              screenshotPath: await saveDebugScreenshot(context.pages()[0] || await context.newPage(), "review-sequence-open-failed"),
              message: fallbackTheme.message || "cinema_mode_required",
            });
            break;
          }
          page = fallbackTheme.page;
        }
        retainedVideoPages.add(page);
        page.on("close", () => {
          retainedVideoPages.delete(page);
        });
      } else if (page) {
        const previousHref = await getCurrentVideoHref(page);
        const nextResult = await moveToNextVideoInSamePage(page, previousHref);
        if (!nextResult.ok) {
          job.failed += 1;
          keepPageOpenAfterRun = true;
          job.results.push({
            href: nextResult.href || previousHref || hrefs[index] || "",
            status: "failed",
            alreadyCommented: false,
            ownCommentDetected: false,
            commentCount: 0,
            firstCommentMatches: false,
            firstThreadHasDraft: false,
            filled: false,
            replied: false,
            sent: false,
            replySent: false,
            sendVerified: false,
            replySendVerified: false,
            blocking: "",
            screenshotPath: await saveDebugScreenshot(page, "review-sequence-next-failed"),
            message: getReviewSequenceFailureReason({ nextResult }),
          });

          const fallbackTheme = await reopenSequenceWithNextKeyword(context, job);
          if (!fallbackTheme.ok) {
            break;
          }
          page = fallbackTheme.page;
          retainedVideoPages.add(page);
          page.on("close", () => {
            retainedVideoPages.delete(page);
          });
          keepPageOpenAfterRun = true;
          index -= 1;
          continue;
        }
      }

      const href = page ? await getCurrentVideoHref(page) : hrefs[index] || "";
      job.current = index + 1;
      job.currentHref = href;
      let stopAfterCurrentVideo = false;

      const itemResult = {
        href,
        keyword: job.currentKeyword || "",
        status: "pending",
        alreadyCommented: false,
        ownCommentDetected: false,
        commentCount: 0,
        firstCommentMatches: false,
        firstThreadHasDraft: false,
        filled: false,
        replied: false,
        sent: false,
        replySent: false,
        sendVerified: false,
        replySendVerified: false,
        mainCommentText: "",
        replyCommentText: "",
        blocking: "",
        screenshotPath: "",
        message: "",
      };
      try {
        let blocking = page.openError ? "open_error" : await getConfirmedBlockingState(page);
        if (blocking === "captcha") {
          const captchaSolve = await autoSolveSliderCaptchaIfPresent(page, { maxAttempts: 5 }).catch(() => ({
            solved: false,
            blocking: "captcha",
          }));
          blocking = captchaSolve.solved ? "" : (captchaSolve.blocking || "captcha");
        }

        if (!blocking) {
          let focusResult = await focusCommentInput(page, getRandomCommentDraft());
          if (focusResult.blocking === "captcha") {
            const captchaSolve = await autoSolveSliderCaptchaIfPresent(page, { maxAttempts: 5 }).catch(() => ({
              solved: false,
              blocking: "captcha",
            }));
            focusResult = {
              ...focusResult,
              blocking: captchaSolve.solved ? "" : (captchaSolve.blocking || "captcha"),
            };
          }

          itemResult.blocking = focusResult.blocking || blocking || "";
          itemResult.alreadyCommented = Boolean(focusResult.alreadyCommented);
          itemResult.ownCommentDetected = Boolean(focusResult.sent || focusResult.replySent || focusResult.alreadyCommented);
          itemResult.commentCount = Number(focusResult.commentState?.commentCount || 0);
          itemResult.firstCommentMatches = Boolean(focusResult.firstCommentMatches);
          itemResult.firstThreadHasDraft = Boolean(focusResult.firstThreadHasDraft);
          itemResult.filled = Boolean(focusResult.filled);
          itemResult.replied = Boolean(focusResult.replied);
          itemResult.sent = Boolean(focusResult.sent);
          itemResult.replySent = Boolean(focusResult.replySent);
          itemResult.sendVerified = Boolean(focusResult.sendVerified);
          itemResult.replySendVerified = Boolean(focusResult.replySendVerified);
          itemResult.mainCommentText = String(focusResult.mainCommentText || focusResult.expectedText || "");
          itemResult.replyCommentText = String(focusResult.replyCommentText || focusResult.expectedText || "");
          itemResult.message = focusResult.ok
            ? (
              focusResult.sendVerified && focusResult.replySendVerified
                ? "top_liked_reply_and_main_comment_sent"
              : focusResult.replySendVerified
                ? "top_liked_comment_reply_sent"
                : focusResult.alreadyCommented
                  ? "existing_comment_found"
                  : "main_comment_sent"
            )
            : "comment_send_not_ready";

          if (!blocking && focusResult.ok) {
            if (focusResult.alreadyCommented) {
              job.skipped += 1;
              itemResult.status = "skipped";
            } else {
              if (itemResult.ownCommentDetected) {
                job.detectedOwnComment += 1;
              }
              job.completed += 1;
              itemResult.status = focusResult.sendVerified && focusResult.replySendVerified
                ? "sent_and_replied"
                : focusResult.replySendVerified
                  ? "replied"
                  : "sent";
            }
          } else {
            job.failed += 1;
            keepPageOpenAfterRun = true;
            itemResult.status = "failed";
            itemResult.message = getReviewSequenceFailureReason({ blocking, focusResult });
            itemResult.screenshotPath = await saveDebugScreenshot(page, "review-sequence-failed");
          }
        } else {
          job.failed += 1;
          keepPageOpenAfterRun = true;
          stopAfterCurrentVideo = blocking === "tiktok_error";
          itemResult.status = "failed";
          itemResult.blocking = blocking;
          itemResult.message = getReviewSequenceFailureReason({ blocking });
          itemResult.screenshotPath = await saveDebugScreenshot(page, "review-sequence-blocked");
        }
      } catch (error) {
        job.failed += 1;
        keepPageOpenAfterRun = true;
        itemResult.status = "failed";
        itemResult.ownCommentDetected = false;
        itemResult.message = getReviewSequenceFailureReason({ error });
        if (page) {
          itemResult.screenshotPath = await saveDebugScreenshot(page, "review-sequence-exception");
        }
      } finally {
        job.results.push(itemResult);
        if (page) {
          if (["sent", "replied", "sent_and_replied", "skipped"].includes(itemResult.status)) {
            const delayMs = holdMs + Math.floor(Math.random() * (randomHoldMs + 1));
            await sleep(delayMs);
          }
        }
      }

      if (stopAfterCurrentVideo) {
        break;
      }
    }

    if (page && !keepPageOpenAfterRun) {
      retainedVideoPages.delete(page);
      await page.close().catch(() => {});
    }
    job.running = false;
    if (!keepPageOpenAfterRun) {
      job.currentHref = "";
    }
  })().catch(() => {
    job.running = false;
  });

  return {
    ok: true,
    message: `Started stream review sequence for up to ${maxVideos} videos with a ${Math.round(holdMs / 1000)}-${Math.round((holdMs + randomHoldMs) / 1000)} second hold window.`,
    total: maxVideos,
    maxVideos,
    holdMs,
    randomHoldMs,
  };
}

async function scrollSearchPage(page) {
  await page.mouse.move(BROWSER_VIEWPORT.width / 2, BROWSER_VIEWPORT.height / 2).catch(() => {});
  await page.mouse.wheel(0, 2600).catch(() => {});
  await page.keyboard.press("PageDown").catch(() => {});

  return page.evaluate(() => {
    const before = {
      windowY: window.scrollY,
      documentTop: document.scrollingElement?.scrollTop || 0,
    };

    window.scrollBy(0, Math.max(window.innerHeight * 1.8, 1600));

    const scrollables = Array.from(document.querySelectorAll("body, body *"))
      .filter(element => {
        const style = window.getComputedStyle(element);
        return (
          /(auto|scroll)/.test(style.overflowY) &&
          element.scrollHeight > element.clientHeight + 120
        );
      })
      .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));

    for (const element of scrollables.slice(0, 4)) {
      element.scrollTop += Math.max(element.clientHeight * 1.8, 1600);
    }

    return {
      before,
      after: {
        windowY: window.scrollY,
        documentTop: document.scrollingElement?.scrollTop || 0,
      },
      scrollableCount: scrollables.length,
    };
  }).catch(() => null);
}

async function scrollForMore(page, minimumCount, seedResults = []) {
  const resultMap = new Map();
  mergeVideoResults(resultMap, seedResults);

  let lastTotal = resultMap.size;
  let lastScrollY = -1;
  let staleRounds = 0;
  const maxRounds = Math.min(900, Math.max(20, Math.ceil(minimumCount / 2)));

  for (let i = 0; i < maxRounds; i += 1) {
    mergeVideoResults(resultMap, await extractVideoResults(page));
    if (resultMap.size >= minimumCount) {
      return Array.from(resultMap.values());
    }

    if (resultMap.size === lastTotal) {
      staleRounds += 1;
      if (staleRounds >= 30) {
        return Array.from(resultMap.values());
      }
    } else {
      lastTotal = resultMap.size;
      staleRounds = 0;
    }

    const scrollState = await scrollSearchPage(page);
    const currentScrollY = scrollState?.after?.windowY ?? scrollState?.after?.documentTop ?? -1;
    if (currentScrollY !== lastScrollY) {
      staleRounds = Math.max(0, staleRounds - 1);
      lastScrollY = currentScrollY;
    }

    await page.waitForTimeout(1400);
  }

  mergeVideoResults(resultMap, await extractVideoResults(page));
  return Array.from(resultMap.values());
}

async function isContextUsable(context) {
  if (!context) return false;

  try {
    const [page] = context.pages();
    if (page) {
      await page.title();
    }
    return true;
  } catch {
    return false;
  }
}

async function getRetainedContext(args) {
  const profileName = resolveChromeProfileName(args.chromeProfileName);
  if (
    retainedContextProfileName === profileName &&
    await isContextUsable(retainedContext)
  ) {
    return retainedContext;
  }

  if (retainedContext) {
    await retainedContext.close().catch(() => {});
  }
  retainedContext = await launchPersistentBrowserContext(args);
  retainedContextProfileName = profileName;
  retainedContext.on("close", () => {
    retainedContext = null;
    retainedContextProfileName = null;
  });

  return retainedContext;
}

async function launchPersistentBrowserContext(args) {
  const syncResult = args.syncSystemProfile === false
    ? { ok: false, skipped: true }
    : syncSystemChromeProfile(args.chromeProfileName);
  if (syncResult.ok) {
    console.log(`Synced Chrome profile from '${syncResult.profileName}'.`);
  } else if (!syncResult.skipped) {
    console.warn(`Chrome profile sync skipped: ${syncResult.message}`);
  }

  const profileName = resolveChromeProfileName(args.chromeProfileName);

  const launchOptions = {
    headless: !args.headed,
    viewport: BROWSER_VIEWPORT,
    locale: "en-US",
    channel: "chrome",
    args: [
      `--profile-directory=${profileName}`,
      `--window-size=${BROWSER_VIEWPORT.width},${BROWSER_VIEWPORT.height}`,
    ],
    ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain"],
  };

  try {
    return await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, launchOptions);
  } catch (error) {
    console.warn(`${CHROME_FALLBACK_WARNING} ${error.message}`);
    const fallbackOptions = {
      ...launchOptions,
    };
    delete fallbackOptions.channel;
    return chromium.launchPersistentContext(BROWSER_PROFILE_DIR, fallbackOptions);
  }
}

async function searchTikTok(args) {
  const keepOpen = args.keepOpen === true;
  const persistentProfile = args.headed !== false;
  const chromeProfileName = resolveChromeProfileName(args.chromeProfileName);
  let browser = null;
  let context = null;

  if (persistentProfile) {
    context = keepOpen
      ? await getRetainedContext(args)
      : await launchPersistentBrowserContext(args);
  } else {
    browser = await chromium.launch({
      headless: true,
    });
    context = await browser.newContext({
      viewport: BROWSER_VIEWPORT,
      locale: "en-US",
    });
  }

  const page = context.pages()[0] || await context.newPage();
  const searchUrl = `https://www.tiktok.com/search/video?q=${encodeURIComponent(args.keyword)}`;

  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(2500);
    await dismissCommonPrompts(page);

    let { blocking, results: initialResults } = await waitForResultsOrBlocking(page, args.limit);
    if (blocking === "captcha") {
      const captchaSolve = await autoSolveSliderCaptchaIfPresent(page, { maxAttempts: 5 }).catch(() => ({
        solved: false,
        blocking: "captcha",
      }));
      if (captchaSolve.solved) {
        const retryAfterSolve = await waitForResultsOrBlocking(page, args.limit);
        blocking = retryAfterSolve.blocking;
        initialResults = retryAfterSolve.results;
      }
    }
    if (blocking === "tiktok_error") {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(3500);
      await dismissCommonPrompts(page);
      const retryState = await waitForResultsOrBlocking(page, args.limit);
      blocking = retryState.blocking;
      initialResults = retryState.results;
    }

    if (blocking) {
      const debugState = await getBlockingDebugState(page);
      return {
        ok: false,
        channel: "tiktok",
        keyword: args.keyword,
        chromeProfileName,
        status: blocking,
        debugState,
        message:
          blocking === "google_login_blocked"
            ? "Google blocked sign-in inside the automated browser. Use an existing Chrome profile login state."
            : blocking === "captcha"
            ? "TikTok asked for slider verification."
            : blocking === "tiktok_error"
              ? "TikTok returned a temporary error after retry."
            : blocking === "login"
              ? "TikTok requires login or guest confirmation."
              : "TikTok returned a region-blocked page instead of search results.",
      };
    }

    const rawResults = initialResults.length >= args.limit
      ? initialResults
      : await scrollForMore(page, args.limit, initialResults);
    const results = rawResults.slice(0, args.limit);
    const payload = {
      keyword: args.keyword,
      status: "ok",
      fetchedAt: new Date().toISOString(),
      resultCount: results.length,
      results,
    };

    return {
      ok: true,
      channel: "tiktok",
      keyword: args.keyword,
      chromeProfileName,
      resultCount: results.length,
      browserProfileDir: persistentProfile ? BROWSER_PROFILE_DIR : "",
      preview: results.slice(0, 5),
      payload,
    };
  } finally {
    if (!keepOpen) {
      await context.close().catch(() => {});
      if (browser) {
        await browser.close().catch(() => {});
      }
    }
  }
}

async function searchByChannel(args = {}) {
  const channel = String(args.channel || "tiktok").trim().toLowerCase();
  if (channel === "facebook") {
    return searchFacebook({
      ...args,
      channel,
    }, {
      BROWSER_PROFILE_DIR,
      BROWSER_VIEWPORT,
      chromium,
      dismissCommonPrompts,
      getRetainedContext,
      launchPersistentBrowserContext,
      resolveChromeProfileName,
      saveDebugScreenshot,
    });
  }
  return searchTikTok({
    ...args,
    channel: "tiktok",
  });
}

module.exports = {
  BROWSER_PROFILE_DIR,
  SEARCH_DATA_DIR,
  getReviewSequenceStatus,
  diagnoseVideoNavigation,
  findPreferredChromeProfile,
  listSystemChromeProfiles,
  searchByChannel,
  searchFacebook,
  startReviewSequence,
  stopReviewSequence,
  searchTikTok,
};
