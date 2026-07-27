const {
  isFacebookReelHref,
  searchFacebookReels,
  startFacebookReelReviewSequence,
} = require("./facebook-reels");

function mergeResults(resultMap, results) {
  for (const item of results) {
    const key = item.href || `${item.author}:${item.snippet}`;
    if (key && !resultMap.has(key)) {
      resultMap.set(key, item);
    }
  }
}

let facebookReviewJob = null;

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}

function cleanFacebookUrl(href) {
  try {
    const parsed = new URL(href);
    parsed.hash = "";
    for (const key of Array.from(parsed.searchParams.keys())) {
      const normalized = key.toLowerCase();
      if (
        normalized.includes("__cft__") ||
        normalized.includes("__tn__") ||
        ["comment_id", "reply_comment_id", "locale", "mibextid", "notif", "ref", "fbclid"].includes(normalized)
      ) {
        parsed.searchParams.delete(key);
      }
    }
    return parsed.href;
  } catch {
    return href || "";
  }
}

function isFacebookCommentableHref(href) {
  const value = String(href || "").toLowerCase();
  return (
    value.includes("story_fbid=") ||
    value.includes("/posts/") ||
    value.includes("/permalink.php") ||
    value.includes("/videos/")
  );
}

function normalizeFacebookContentType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "reel" || normalized === "reels" ? "reel" : "post";
}

function parsePostText(snippet) {
  const tokens = String(snippet || "")
    .split("|")
    .map(cleanText)
    .filter(Boolean);
  const author = cleanText(tokens[0] || "");
  const titleTokens = tokens.slice(1).filter(token => (
    !/^(关注|加入|赞助内容|Sponsored|Follow|所有心情：|写评论…?|发表公开评论…?)$/i.test(token) &&
    !/^(赞|评论|分享|Like|Comment|Share)$/i.test(token) &&
    !/^\d+$/.test(token) &&
    !/^\d+次分享$/.test(token) &&
    !/^\d+条评论$/.test(token) &&
    !/^\d{4}年\d+月\d+日$/.test(token) &&
    !/^\d+月\d+日/.test(token)
  ));
  const title = titleTokens
    .join(" | ")
    .replace(/(?:\s*\|\s*)?(?:所有心情：|写评论…?|发表公开评论…?).*$/i, "")
    .trim();

  return {
    author,
    title,
  };
}

function normalizeFacebookItem(item) {
  const parsed = parsePostText(item.snippet);
  const knownAuthor = cleanText(item.author);
  const knownTitle = cleanText(item.snippet)
    .replace(/\s*\|\s*/g, " | ")
    .replace(/(?:\s*\|\s*)?(?:所有心情：|写评论…?|发表公开评论…?).*$/i, "")
    .trim();
  const rawTitle = cleanText(item.title);
  const titleLines = String(item.snippet || "")
    .split("|")
    .map(line => line.trim())
    .filter(Boolean);
  const fallbackTitle = titleLines.find(line => (
    line.length >= 10 &&
    !/^(like|comment|share|send|follow|see more|赞|评论|分享)$/i.test(line) &&
    !/^\d+:\d{2}$/.test(line) &&
    !/\d+\s*(views?|plays?)/i.test(line)
  ));

  return {
    ...item,
    title: (knownAuthor ? knownTitle : parsed.title) || fallbackTitle || rawTitle || parsed.author || "Facebook post",
    author: knownAuthor || parsed.author || "",
    href: cleanFacebookUrl(item.href),
    externalHref: cleanFacebookUrl(item.externalHref),
  };
}

async function extractFacebookResults(page) {
  const results = await page.evaluate(() => {
    const isVisible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 80 &&
        rect.height > 40 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight * 1.8
      );
    };

    const clean = value => String(value || "")
      .replace(/[ \t\r\f\v]+/g, " ")
      .replace(/\u00a0/g, " ")
      .trim();

    const normalizeHref = href => {
      try {
        const parsed = new URL(href, location.origin);
        parsed.hash = "";
        for (const key of Array.from(parsed.searchParams.keys())) {
          const normalized = key.toLowerCase();
          if (
            normalized.includes("__cft__") ||
            normalized.includes("__tn__") ||
            /^(comment_id|reply_comment_id|locale|mibextid|notif|ref|fbclid)$/i.test(key)
          ) {
            parsed.searchParams.delete(key);
          }
        }
        return parsed.href;
      } catch {
        return "";
      }
    };

    const classifyHref = href => {
      if (!href) return "post";
      try {
        const parsed = new URL(href, location.origin);
        const target = `${parsed.pathname}${parsed.search}`.toLowerCase();
        if (target.includes("/reel/")) return "reel";
        if (target.includes("/watch/") || target.includes("/videos/")) return "video";
        if (target.includes("/posts/") || target.includes("/permalink/") || target.includes("story_fbid=")) return "post";
        if (!parsed.hostname.includes("facebook.com")) return "link";
        return "post";
      } catch {
        return "post";
      }
    };

    const isNoiseLine = line => (
      !line ||
      /^\d+:\d{2}$/.test(line) ||
      /^(like|comment|share|send|follow|see more|all|posts|videos|reels|photos)$/i.test(line) ||
      /^(赞|评论|分享|发送|展开|全部|帖子|用户|公共主页|小组|活动)$/.test(line) ||
      /^\d+\s*(views?|plays?|comments?|shares?)$/i.test(line) ||
      /^[·•]$/.test(line)
    );

    const splitLines = element => String(element?.innerText || element?.textContent || "")
      .replace(/\u00a0/g, " ")
      .split(/\n| {2,}/)
      .map(clean)
      .filter(line => line && !isNoiseLine(line));

    const pickAuthor = article => {
      const authorLink = article.querySelector([
        '[data-ad-rendering-role="profile_name"] a[role="link"]',
        'h3 a[role="link"]',
        'a[aria-label][href*="facebook.com/profile.php"]',
        'a[aria-label][href*="facebook.com/"][role="link"]',
      ].join(","));
      return clean(authorLink?.getAttribute("aria-label") || authorLink?.innerText || authorLink?.textContent || "");
    };

    const pickStoryLines = article => {
      const message = article.querySelector([
        '[data-ad-rendering-role="story_message"]',
        '[data-ad-preview="message"]',
        '[data-ad-comet-preview="message"]',
      ].join(","));
      const lines = splitLines(message);
      return lines.length ? lines : splitLines(article);
    };

    const pickPostHref = article => {
      const anchors = Array.from(article.querySelectorAll("a[href]"))
        .map(anchor => ({
          href: normalizeHref(anchor.href || ""),
          text: clean(anchor.innerText || anchor.textContent || anchor.getAttribute("aria-label") || ""),
          aria: clean(anchor.getAttribute("aria-label") || ""),
        }))
        .filter(item => item.href && !item.href.includes("/search/"));

      const timestampLink = anchors.find(item => (
        item.href.includes("story_fbid=") ||
        /\/posts\/|\/permalink\.php/i.test(item.href)
      ));
      if (timestampLink) return timestampLink.href;

      const preferred = anchors.find(item => {
        const target = item.href.toLowerCase();
        return (
          target.includes("/posts/") ||
          target.includes("/permalink/") ||
          target.includes("story_fbid=") ||
          target.includes("/reel/") ||
          target.includes("/videos/") ||
          target.includes("/watch/")
        );
      });
      return preferred?.href || anchors.find(item => !item.href.includes("/groups/discover/"))?.href || "";
    };

    const pickExternalHref = article => {
      const link = Array.from(article.querySelectorAll("a[href]"))
        .map(anchor => normalizeHref(anchor.href || ""))
        .find(href => href && !href.includes("facebook.com") && !href.includes("fbcdn.net"));
      return link || "";
    };

    const getMediaCount = article => Array.from(article.querySelectorAll("img, video"))
      .filter(isVisible).length;

    const articles = Array.from(document.querySelectorAll([
      '[role="article"]',
      '[data-pagelet*="FeedUnit"]',
      'div[aria-posinset]',
      '[data-virtualized="false"]',
    ].join(",")))
      .filter(isVisible);

    const seen = new Set();
    const items = [];

    for (const article of articles) {
      const author = pickAuthor(article);
      const storyLines = pickStoryLines(article);
      const cardLines = splitLines(article);
      const meaningfulLines = (storyLines.length ? storyLines : cardLines).filter(line => (
        line.length > 1 &&
        line !== author &&
        !/^sponsored$/i.test(line) &&
        !/^赞助内容$/.test(line)
      ));
      const postText = meaningfulLines.join(" | ");
      if (postText.length < 8) continue;

      const href = pickPostHref(article);
      const externalHref = pickExternalHref(article);
      const cardText = cardLines.join(" | ");
      const hasPostActions = /(评论|comment).*(分享|share)|写评论|发表公开评论/i.test(cardText);
      const hasPostHref = /\/(posts|permalink|videos|reel)\b|story_fbid=/i.test(href);
      const isSponsoredPost = /赞助内容|Sponsored/i.test(cardText);
      if (!hasPostActions && !hasPostHref && !isSponsoredPost) continue;

      const key = href || postText.slice(0, 140);
      if (seen.has(key)) continue;
      seen.add(key);

      const title = meaningfulLines.find(line => (
        line.length >= 8 &&
        !line.includes("查看所有主页") &&
        !line.includes("View all")
      )) || author || "";
      const type = classifyHref(href || externalHref);

      items.push({
        type,
        title,
        author,
        href: href || externalHref,
        externalHref,
        snippet: meaningfulLines.slice(0, 10).join(" | "),
        mediaCount: getMediaCount(article),
      });
    }

    return {
      items,
      debug: {
        url: location.href,
        title: document.title,
        articleCount: articles.length,
        bodyText: clean(document.body?.innerText || "").slice(0, 1600),
      },
    };
  });

  return {
    ...results,
    items: results.items.map(normalizeFacebookItem),
  };
}

async function scrollForMoreFacebook(page, minimumCount, seedResults = [], viewport) {
  const resultMap = new Map();
  mergeResults(resultMap, seedResults);

  let lastTotal = resultMap.size;
  let staleRounds = 0;
  const maxRounds = Math.min(80, Math.max(10, Math.ceil(minimumCount * 1.4)));
  const width = viewport?.width || 1440;
  const height = viewport?.height || 960;
  let debugState = null;

  for (let i = 0; i < maxRounds; i += 1) {
    const extracted = await extractFacebookResults(page);
    debugState = extracted.debug;
    mergeResults(resultMap, extracted.items.filter(item => isFacebookCommentableHref(item.href)));
    if (resultMap.size >= minimumCount) {
      return {
        results: Array.from(resultMap.values()),
        debugState,
      };
    }

    if (resultMap.size === lastTotal) {
      staleRounds += 1;
      if (staleRounds >= 10) break;
    } else {
      lastTotal = resultMap.size;
      staleRounds = 0;
    }

    await page.mouse.move(width / 2, height / 2).catch(() => {});
    await page.mouse.wheel(0, 2200).catch(() => {});
    await page.keyboard.press("PageDown").catch(() => {});
    await page.waitForTimeout(1600);
  }

  const extracted = await extractFacebookResults(page);
  mergeResults(resultMap, extracted.items.filter(item => isFacebookCommentableHref(item.href)));

  return {
    results: Array.from(resultMap.values()),
    debugState: extracted.debug || debugState,
  };
}

async function searchFacebook(args, deps) {
  const contentType = normalizeFacebookContentType(args.contentType || args.facebookContentType);
  if (contentType === "reel") {
    return searchFacebookReels(args, deps);
  }

  const {
    BROWSER_PROFILE_DIR,
    BROWSER_VIEWPORT,
    chromium,
    dismissCommonPrompts,
    getRetainedContext,
    launchPersistentBrowserContext,
    resolveChromeProfileName,
  } = deps;

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
      locale: "zh-CN",
    });
  }

  const page = context.pages()[0] || await context.newPage();
  const searchUrls = [
    `https://www.facebook.com/search/top/?q=${encodeURIComponent(args.keyword)}`,
  ];

  try {
    const requestedLimit = Math.max(1, Number(args.limit) || 1);
    let lastDebugState = null;
    let results = [];

    for (const searchUrl of searchUrls) {
      const navigationError = await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45_000 })
        .then(() => null)
        .catch(error => error);
      if (navigationError) {
        await page.waitForLoadState("commit", { timeout: 8_000 }).catch(() => {});
      }
      await page.waitForTimeout(4500);
      await dismissCommonPrompts(page);

      const initial = await extractFacebookResults(page);
      const initialCommentableItems = initial.items.filter(item => isFacebookCommentableHref(item.href));
      const collected = requestedLimit === 1
        ? {
          results: initialCommentableItems.slice(0, 1),
          debugState: initial.debug,
        }
        : initialCommentableItems.length >= requestedLimit
          ? { results: initialCommentableItems, debugState: initial.debug }
          : await scrollForMoreFacebook(page, requestedLimit, initialCommentableItems, BROWSER_VIEWPORT);

      lastDebugState = collected.debugState || initial.debug;
      results = collected.results
        .filter(item => isFacebookCommentableHref(item.href))
        .slice(0, requestedLimit);
      if (results.length) {
        break;
      }
    }

    if (!results.length) {
      if (deps.saveDebugScreenshot) {
        lastDebugState = {
          ...(lastDebugState || {}),
          screenshotPath: await deps.saveDebugScreenshot(page, "facebook-post-search-no-results"),
        };
      }
      return {
        ok: false,
        channel: "facebook",
        contentType: "post",
        keyword: args.keyword,
        chromeProfileName,
        status: "no_results",
        debugState: lastDebugState,
        message: "Facebook 搜索列表没有返回可评论的帖子结果，请换关键词或手动刷新后重试。",
      };
    }

    const payload = {
      keyword: args.keyword,
      channel: "facebook",
      contentType: "post",
      status: "ok",
      fetchedAt: new Date().toISOString(),
      resultCount: results.length,
      results,
    };

    return {
      ok: true,
      channel: "facebook",
      contentType: "post",
      keyword: args.keyword,
      chromeProfileName,
      resultCount: results.length,
      browserProfileDir: persistentProfile ? BROWSER_PROFILE_DIR : "",
      debugState: lastDebugState,
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

function getFacebookReviewSequenceStatus() {
  if (!facebookReviewJob) {
    return {
      channel: "facebook",
      running: false,
      contentType: "",
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
    channel: "facebook",
    running: facebookReviewJob.running,
    contentType: facebookReviewJob.contentType || "post",
    total: facebookReviewJob.total,
    current: facebookReviewJob.current,
    currentHref: facebookReviewJob.currentHref,
    completed: facebookReviewJob.completed,
    skipped: facebookReviewJob.skipped,
    failed: facebookReviewJob.failed,
    results: facebookReviewJob.results,
    paused: false,
    pauseReason: "",
    pauseMessage: "",
    currentKeyword: facebookReviewJob.currentKeyword || facebookReviewJob.searchKeyword || "",
    remainingKeywords: Math.max(0, (facebookReviewJob.keywordPool || []).length - (facebookReviewJob.keywordIndex || 0) - 1),
  };
}

async function stopFacebookReviewSequence() {
  if (!facebookReviewJob?.running) {
    return {
      ok: true,
      message: "当前没有正在运行的 Facebook 队列。",
      ...getFacebookReviewSequenceStatus(),
    };
  }

  facebookReviewJob.cancelled = true;
  facebookReviewJob.running = false;

  return {
    ok: true,
    message: "已请求停止 Facebook 队列。",
    ...getFacebookReviewSequenceStatus(),
  };
}

async function openFacebookPost(page, href) {
  page.openError = null;
  try {
    await page.goto(href, { waitUntil: "domcontentloaded", timeout: 45_000 });
  } catch (error) {
    page.openError = error;
  }
  await page.waitForTimeout(3500).catch(() => {});
  return page;
}

async function findFacebookCommentBox(page) {
  return page.evaluate(() => {
    const isVisible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 80 &&
        rect.height > 20 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight
      );
    };

    const boxes = Array.from(document.querySelectorAll('[contenteditable="true"][role="textbox"], [contenteditable="true"]'))
      .filter(isVisible)
      .map((element, index) => {
        const label = [
          element.getAttribute("aria-label"),
          element.getAttribute("aria-placeholder"),
          element.textContent,
          element.innerText,
        ].join(" ");
        const score = /写评论|write a comment|comment/i.test(label) ? 100 : 0;
        const rect = element.getBoundingClientRect();
        return {
          index,
          score,
          rect: {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          },
        };
      })
      .sort((a, b) => b.score - a.score);

    const target = boxes[0];
    if (!target) return null;
    document.querySelectorAll('[contenteditable="true"][role="textbox"], [contenteditable="true"]')[target.index]
      ?.setAttribute("data-codex-facebook-comment-box", "true");
    return target;
  }).catch(() => null);
}

async function clickFacebookCommentAction(page) {
  const clicked = await page.evaluate(() => {
    const isVisible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 40 &&
        rect.height > 20 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight
      );
    };
    const target = Array.from(document.querySelectorAll('[role="button"], a[role="link"]'))
      .find(element => {
        const label = [
          element.getAttribute("aria-label"),
          element.innerText,
          element.textContent,
        ].join(" ");
        return isVisible(element) && /评论|comment/i.test(label);
      });
    target?.click?.();
    return Boolean(target);
  }).catch(() => false);

  if (clicked) {
    await page.waitForTimeout(1200).catch(() => {});
  }
  return clicked;
}

async function fillFacebookCommentBox(page, text) {
  let box = await findFacebookCommentBox(page);
  if (!box) {
    await clickFacebookCommentAction(page);
    box = await findFacebookCommentBox(page);
  }
  if (!box) {
    return {
      ok: false,
      message: "facebook_comment_box_not_found",
    };
  }

  const locator = page.locator('[data-codex-facebook-comment-box="true"]').first();
  await locator.click({ timeout: 8000 }).catch(async () => {
    await page.mouse.click(box.rect.x, box.rect.y).catch(() => {});
  });
  const selectAllShortcut = process.platform === "darwin" ? "Meta+A" : "Control+A";
  await page.keyboard.press(selectAllShortcut).catch(() => {});
  await page.keyboard.type(text, { delay: 8 });
  await page.waitForTimeout(800).catch(() => {});

  return {
    ok: true,
    message: "facebook_comment_filled",
  };
}

async function submitFacebookComment(page) {
  const clicked = await page.evaluate(() => {
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
        rect.top < window.innerHeight
      );
    };

    const buttons = Array.from(document.querySelectorAll('[role="button"], button'))
      .filter(isVisible)
      .map(element => {
        const label = [
          element.getAttribute("aria-label"),
          element.innerText,
          element.textContent,
        ].join(" ").trim();
        const disabled = element.getAttribute("aria-disabled") === "true" || element.disabled;
        const score = /发布评论|post comment|post/i.test(label) ? 100 : /发送|send/i.test(label) ? 60 : 0;
        return { element, score, disabled };
      })
      .filter(item => item.score > 0 && !item.disabled)
      .sort((a, b) => b.score - a.score);

    const target = buttons[0]?.element;
    target?.click?.();
    return Boolean(target);
  }).catch(() => false);

  if (!clicked) {
    const sendShortcut = process.platform === "darwin" ? "Meta+Enter" : "Control+Enter";
    await page.keyboard.press(sendShortcut).catch(() => {});
    await page.keyboard.press("Enter").catch(() => {});
  }

  await page.waitForTimeout(3500).catch(() => {});
  return {
    clicked,
  };
}

async function hasFacebookCommentText(page, text) {
  const normalized = cleanText(text);
  return page.evaluate(expected => {
    const clean = value => String(value || "").replace(/\s+/g, " ").trim();
    return clean(document.body?.innerText || "").includes(expected);
  }, normalized).catch(() => false);
}

async function commentOnFacebookPost(page, href, commentText, deps) {
  await openFacebookPost(page, href);
  if (page.openError) {
    return {
      ok: false,
      href,
      status: "failed",
      filled: false,
      sent: false,
      sendVerified: false,
      message: "open_error",
      screenshotPath: await deps.saveDebugScreenshot(page, "facebook-open-error"),
    };
  }

  await deps.dismissCommonPrompts(page).catch(() => {});
  const alreadyCommented = await hasFacebookCommentText(page, commentText);
  if (alreadyCommented) {
    return {
      ok: true,
      href,
      status: "skipped",
      filled: false,
      sent: false,
      sendVerified: true,
      alreadyCommented: true,
      message: "existing_comment_found",
    };
  }

  const fillResult = await fillFacebookCommentBox(page, commentText);
  if (!fillResult.ok) {
    return {
      ok: false,
      href,
      status: "failed",
      filled: false,
      sent: false,
      sendVerified: false,
      message: fillResult.message,
      screenshotPath: await deps.saveDebugScreenshot(page, "facebook-comment-box-not-found"),
    };
  }

  const submitResult = await submitFacebookComment(page);
  const sendVerified = await hasFacebookCommentText(page, commentText);

  return {
    ok: sendVerified,
    href,
    status: sendVerified ? "sent" : "failed",
    filled: true,
    sent: Boolean(submitResult.clicked || sendVerified),
    sendVerified,
    alreadyCommented: false,
    message: sendVerified ? "main_comment_sent" : "facebook_comment_not_verified",
    screenshotPath: sendVerified ? "" : await deps.saveDebugScreenshot(page, "facebook-comment-not-verified"),
  };
}

function startFacebookReviewSequence(args = {}, deps) {
  const contentType = normalizeFacebookContentType(args.contentType || args.facebookContentType);
  if (contentType === "reel") {
    if (facebookReviewJob?.running) {
      facebookReviewJob.cancelled = true;
    }
    return startFacebookReelReviewSequence(args, deps, job => {
      facebookReviewJob = job;
    });
  }

  const hrefs = Array.from(new Set((args.hrefs || [])
    .map(item => cleanFacebookUrl(String(item || "").trim()))
    .filter(isFacebookCommentableHref)));
  const requestedMaxVideos = Number.isFinite(Number(args.maxVideos)) ? Number(args.maxVideos) : hrefs.length;
  const maxVideos = Math.max(1, Math.min(Math.floor(requestedMaxVideos), hrefs.length || 1));
  const requestedHoldMs = Number.isFinite(Number(args.holdMs)) ? Number(args.holdMs) : 5_000;
  const requestedRandomHoldMs = Number.isFinite(Number(args.randomHoldMs)) ? Number(args.randomHoldMs) : 5_000;
  const holdMs = Math.max(1_000, Math.min(requestedHoldMs, 900_000));
  const randomHoldMs = Math.max(0, Math.min(requestedRandomHoldMs, 300_000));
  const chromeProfileName = String(args.chromeProfileName || "").trim();
  const searchKeyword = String(args.searchKeyword || "").trim();
  const commentDrafts = Array.isArray(args.commentDrafts) ? args.commentDrafts.filter(Boolean) : [];

  if (!hrefs.length) {
    return {
      ok: false,
      message: "No commentable Facebook post links provided for review sequence.",
    };
  }

  if (facebookReviewJob?.running) {
    facebookReviewJob.cancelled = true;
  }

  const job = {
    channel: "facebook",
    contentType: "post",
    hrefs,
    total: maxVideos,
    current: 0,
    currentHref: "",
    completed: 0,
    skipped: 0,
    failed: 0,
    running: true,
    cancelled: false,
    results: [],
    searchKeyword,
    currentKeyword: searchKeyword,
  };
  facebookReviewJob = job;

  (async () => {
    const context = await deps.getRetainedContext({
      headed: true,
      syncSystemProfile: false,
      chromeProfileName,
    });
    await deps.keepOnlyPrimaryPage(context);
    const page = context.pages()[0] || await context.newPage();

    for (let index = 0; index < maxVideos; index += 1) {
      if (job.cancelled) break;

      const href = hrefs[index];
      const commentText = commentDrafts[Math.floor(Math.random() * commentDrafts.length)] || args.defaultComment || "";
      job.current = index + 1;
      job.currentHref = href;

      const result = await commentOnFacebookPost(page, href, commentText, deps).catch(async error => ({
        ok: false,
        href,
        status: "failed",
        filled: false,
        sent: false,
        sendVerified: false,
        message: `exception: ${error.message}`,
        screenshotPath: await deps.saveDebugScreenshot(page, "facebook-comment-exception"),
      }));

      const itemResult = {
        href,
        keyword: searchKeyword,
        status: result.status || (result.ok ? "sent" : "failed"),
        alreadyCommented: Boolean(result.alreadyCommented),
        ownCommentDetected: Boolean(result.sendVerified),
        commentCount: 0,
        firstCommentMatches: false,
        firstThreadHasDraft: false,
        filled: Boolean(result.filled),
        replied: false,
        sent: Boolean(result.sent),
        replySent: false,
        sendVerified: Boolean(result.sendVerified),
        replySendVerified: false,
        mainCommentText: commentText,
        replyCommentText: "",
        blocking: "",
        screenshotPath: result.screenshotPath || "",
        message: result.message || "",
      };
      job.results.push(itemResult);

      if (itemResult.status === "skipped") {
        job.skipped += 1;
      } else if (itemResult.sendVerified) {
        job.completed += 1;
      } else {
        job.failed += 1;
      }

      if (itemResult.sendVerified || itemResult.status === "skipped") {
        const delayMs = holdMs + Math.floor(Math.random() * (randomHoldMs + 1));
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    job.running = false;
  })().catch(() => {
    job.running = false;
  });

  return {
    ok: true,
    channel: "facebook",
    message: `Started Facebook review sequence for up to ${maxVideos} posts.`,
    total: maxVideos,
    maxVideos,
    holdMs,
    randomHoldMs,
  };
}

module.exports = {
  extractFacebookResults,
  getFacebookReviewSequenceStatus,
  isFacebookCommentableHref,
  isFacebookReelHref,
  searchFacebook,
  startFacebookReviewSequence,
  stopFacebookReviewSequence,
};
