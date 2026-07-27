function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}

function cleanFacebookUrl(href) {
  try {
    const parsed = new URL(href, "https://www.facebook.com");
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

function isFacebookReelHref(href) {
  return /facebook\.com\/reel\/\d+/i.test(String(href || ""));
}

function normalizeKeywordPool(searchKeyword, keywordPool) {
  const seen = new Set();
  return [searchKeyword, ...(Array.isArray(keywordPool) ? keywordPool : [])]
    .map(item => cleanText(item))
    .filter(Boolean)
    .filter(item => {
      const key = item.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function openFacebookUrl(page, href) {
  page.openError = null;
  try {
    await page.goto(href, { waitUntil: "domcontentloaded", timeout: 45_000 });
  } catch (error) {
    page.openError = error;
    await page.waitForLoadState("commit", { timeout: 8_000 }).catch(() => {});
  }
  await page.waitForTimeout(3500).catch(() => {});
  return page;
}

async function extractFacebookReelResults(page) {
  const results = await page.evaluate(() => {
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

    const isVisible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 40 &&
        rect.height > 40 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight * 1.7
      );
    };

    const anchors = Array.from(document.querySelectorAll('a[href*="/reel/"]'))
      .filter(isVisible)
      .map(anchor => {
        const href = normalizeHref(anchor.href || anchor.getAttribute("href") || "");
        const card = anchor.closest('[role="article"], [data-visualcompletion], div') || anchor;
        const text = clean(card.innerText || card.textContent || anchor.getAttribute("aria-label") || "");
        return {
          type: "reel",
          title: text.split("\n").map(clean).filter(Boolean).slice(0, 3).join(" | ") || "Facebook Reel",
          author: "",
          href,
          externalHref: "",
          snippet: text.slice(0, 500),
          mediaCount: card.querySelectorAll?.("img, video")?.length || 1,
        };
      })
      .filter(item => /\/reel\/\d+/i.test(item.href));

    const seen = new Set();
    const items = [];
    for (const item of anchors) {
      if (seen.has(item.href)) continue;
      seen.add(item.href);
      items.push(item);
    }

    return {
      items,
      debug: {
        url: location.href,
        title: document.title,
        reelAnchorCount: anchors.length,
        bodyText: clean(document.body?.innerText || "").slice(0, 1600),
      },
    };
  }).catch(error => ({
    items: [],
    debug: {
      url: "",
      title: "",
      error: error.message,
    },
  }));

  return {
    ...results,
    items: results.items.map(item => ({
      ...item,
      href: cleanFacebookUrl(item.href),
    })),
  };
}

async function clickFacebookReelsSearchFilter(page) {
  const clicked = await page.evaluate(() => {
    const isVisible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 24 &&
        rect.height > 20 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight
      );
    };

    const candidates = Array.from(document.querySelectorAll('a[role="link"], [role="button"], a[href]'))
      .filter(isVisible)
      .map(element => {
        const label = [
          element.getAttribute("aria-label"),
          element.innerText,
          element.textContent,
          element.getAttribute("href"),
        ].join(" ");
        const rect = element.getBoundingClientRect();
        const score = /(^|\s)reels?($|\s)|短视频/i.test(label)
          ? 100
          : /\/search\/reels/i.test(label)
            ? 90
            : 0;
        return { element, score, rect };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || a.rect.left - b.rect.left);

    const target = candidates[0]?.element;
    target?.click?.();
    return Boolean(target);
  }).catch(() => false);

  if (clicked) {
    await page.waitForTimeout(4500).catch(() => {});
  }
  return clicked;
}

async function openReelSearchModal(page, keyword) {
  const clicked = await page.evaluate(() => {
    const isVisible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 20 &&
        rect.height > 20 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight
      );
    };

    const target = Array.from(document.querySelectorAll('[role="button"], button, a[role="link"]'))
      .find(element => isVisible(element) && /^(搜索 reels|search reels)$/i.test(String(element.getAttribute("aria-label") || "").trim()));
    target?.click?.();
    return Boolean(target);
  }).catch(() => false);

  if (!clicked) return false;

  await page.waitForTimeout(1400).catch(() => {});

  let focused = false;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    focused = await page.evaluate(searchKeyword => {
      const isVisible = element => {
        if (!element) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          rect.width > 120 &&
          rect.height > 20 &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < window.innerHeight
        );
      };

      const scope = document.querySelector('[role="dialog"]') || document;
      document.querySelectorAll('[data-codex-facebook-reel-search-input="true"]')
        .forEach(element => element.removeAttribute("data-codex-facebook-reel-search-input"));
      const input = Array.from(scope.querySelectorAll('input[role="combobox"], input'))
        .find(element => isVisible(element) && /^(搜索 reels|search reels)$/i.test(String(element.getAttribute("aria-label") || "").trim()));
      if (!input) return false;

      input.setAttribute("data-codex-facebook-reel-search-input", "true");
      input.focus?.();
      input.click?.();

      if ("value" in input) {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
        setter?.call(input, "");
        input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
        setter?.call(input, searchKeyword);
      } else {
        input.textContent = searchKeyword;
      }

      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: searchKeyword }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, keyword).catch(() => false);
    if (focused) break;
    await page.waitForTimeout(1000).catch(() => {});
  }

  if (!focused) return false;

  const searchInput = page.locator('[data-codex-facebook-reel-search-input="true"]').first();
  const pressed = await searchInput.press("Enter", { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (!pressed) return false;
  await page.waitForTimeout(4500).catch(() => {});
  return true;
}

async function clickFirstVisibleReelSearchCard(page) {
  const clicked = await page.evaluate(() => {
    const isVisible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 80 &&
        rect.height > 100 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight
      );
    };

    const scope = document.querySelector('[role="dialog"]') || document;
    const reelTile = Array.from(scope.querySelectorAll('a[role="link"][aria-label*="Reels"][href*="/reel/"]'))
      .filter(isVisible)
      .find(anchor => /\/reel\/\d+/i.test(anchor.getAttribute("href") || anchor.href || ""));
    reelTile?.click?.();
    return Boolean(reelTile);
  }).catch(() => false);

  if (clicked) {
    await page.waitForTimeout(4500).catch(() => {});
  }
  return clicked;
}

async function searchFacebookReelsViaModal(page, keyword) {
  const navigationError = await page.goto("https://www.facebook.com/reel/", {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  }).then(() => null).catch(error => error);
  if (navigationError) {
    await page.waitForLoadState("commit", { timeout: 8_000 }).catch(() => {});
  }
  await page.waitForTimeout(4500).catch(() => {});

  const opened = await openReelSearchModal(page, keyword);
  if (!opened) {
    return {
      items: [],
      debug: {
        url: page.url(),
        title: await page.title().catch(() => ""),
        bodyText: await page.evaluate(() => document.body?.innerText?.slice(0, 1600) || "").catch(() => ""),
        modalOpened: false,
      },
    };
  }

  let collected = await extractFacebookReelResults(page);
  const clicked = await clickFirstVisibleReelSearchCard(page);
  if (clicked) {
    const currentHref = cleanFacebookUrl(page.url());
    if (isFacebookReelHref(currentHref)) {
      return {
        items: [{
          type: "reel",
          title: "Facebook Reel",
          author: "",
          href: currentHref,
          externalHref: "",
          snippet: "",
          mediaCount: 1,
        }],
        debug: {
          url: currentHref,
          title: await page.title().catch(() => ""),
          reelAnchorCount: 0,
          clickedFirstCard: true,
        },
      };
    }
  }

  if (collected.items.length) return collected;

  collected = await extractFacebookReelResults(page);
  return {
    ...collected,
    debug: {
      ...(collected.debug || {}),
      clickedFirstCard: clicked,
    },
  };
}

async function searchFacebookReels(args, deps) {
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
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: BROWSER_VIEWPORT,
      locale: "zh-CN",
    });
  }

  const page = context.pages()[0] || await context.newPage();
  const requestedLimit = Math.max(1, Number(args.limit) || 1);

  try {
    const collected = await searchFacebookReelsViaModal(page, args.keyword);

    const results = collected.items.slice(0, requestedLimit);
    if (!results.length) {
      if (deps.saveDebugScreenshot) {
        collected.debug = {
          ...(collected.debug || {}),
          screenshotPath: await deps.saveDebugScreenshot(page, "facebook-reel-search-no-results"),
        };
      }
      return {
        ok: false,
        channel: "facebook",
        contentType: "reel",
        keyword: args.keyword,
        chromeProfileName,
        status: "no_results",
        debugState: collected.debug,
        message: "Facebook Reel 搜索没有拿到可打开的 Reel，请换关键词或手动确认搜索页是否正常加载。",
      };
    }

    const payload = {
      keyword: args.keyword,
      channel: "facebook",
      contentType: "reel",
      status: "ok",
      fetchedAt: new Date().toISOString(),
      resultCount: results.length,
      results,
    };

    return {
      ok: true,
      channel: "facebook",
      contentType: "reel",
      keyword: args.keyword,
      chromeProfileName,
      resultCount: results.length,
      browserProfileDir: persistentProfile ? BROWSER_PROFILE_DIR : "",
      debugState: collected.debug,
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

async function openReelCommentPanel(page) {
  const existingBox = await findReelCommentBox(page);
  if (existingBox) return true;

  const clicked = await page.evaluate(() => {
    const isVisible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 16 &&
        rect.height > 16 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight
      );
    };

    const target = Array.from(document.querySelectorAll('[role="button"], button'))
      .find(element => isVisible(element) && /^(评论|comment)$/i.test(String(element.getAttribute("aria-label") || "").trim()));
    target?.click?.();
    return Boolean(target);
  }).catch(() => false);

  if (!clicked) return false;

  for (let attempt = 0; attempt < 15; attempt += 1) {
    const box = await findReelCommentBox(page);
    if (box) return true;
    await page.waitForTimeout(1000).catch(() => {});
  }
  return false;
}

async function findReelCommentBox(page) {
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

    document.querySelectorAll('[data-codex-facebook-reel-comment-box="true"]')
      .forEach(element => element.removeAttribute("data-codex-facebook-reel-comment-box"));

    const target = Array.from(document.querySelectorAll('[contenteditable="true"][role="textbox"]'))
      .find(element => isVisible(element) && /^(写评论…?|write a comment)$/i.test(String(
        element.getAttribute("aria-label") ||
        element.getAttribute("aria-placeholder") ||
        ""
      ).trim()));
    if (!target) return null;
    const rect = target.getBoundingClientRect();
    target.setAttribute("data-codex-facebook-reel-comment-box", "true");
    return {
      rect: {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      },
      score: 100,
    };
  }).catch(() => null);
}

async function fillReelCommentBox(page, text) {
  let box = await findReelCommentBox(page);
  if (!box) {
    await openReelCommentPanel(page);
    box = await findReelCommentBox(page);
  }
  if (!box) {
    return {
      ok: false,
      message: "facebook_comment_box_not_found",
    };
  }

  const clicked = await page.evaluate(() => {
    const target = document.querySelector('[data-codex-facebook-reel-comment-box="true"]');
    target?.focus?.();
    target?.click?.();
    return Boolean(target);
  }).catch(() => false);
  if (!clicked) {
    return {
      ok: false,
      message: "facebook_comment_box_not_found",
    };
  }
  const selectAllShortcut = process.platform === "darwin" ? "Meta+A" : "Control+A";
  await page.keyboard.press(selectAllShortcut).catch(() => {});
  await page.keyboard.type(text, { delay: 8 });
  await page.waitForTimeout(800).catch(() => {});

  return {
    ok: true,
    message: "facebook_comment_filled",
    anchorY: box.rect.y,
  };
}

async function submitReelComment(page, options = {}) {
  const clicked = await page.evaluate(submitOptions => {
    const anchorY = Number(submitOptions?.anchorY || 0);
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

    document.querySelectorAll('[data-codex-facebook-reel-publish-button="true"]')
      .forEach(element => element.removeAttribute("data-codex-facebook-reel-publish-button"));

    const candidates = Array.from(document.querySelectorAll('[role="button"], button'))
      .map(element => {
        if (!isVisible(element)) return false;
        const label = String(element.getAttribute("aria-label") || "").trim();
        const disabled = element.getAttribute("aria-disabled") === "true" || element.disabled;
        if (disabled || !/^(发布评论|post comment)$/i.test(label)) return null;
        const rect = element.getBoundingClientRect();
        return {
          element,
          y: rect.top + rect.height / 2,
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (anchorY) return Math.abs(a.y - anchorY) - Math.abs(b.y - anchorY);
        return b.y - a.y;
      });
    const target = candidates[0]?.element;
    target?.setAttribute("data-codex-facebook-reel-publish-button", "true");
    target?.click?.();
    return Boolean(target);
  }, options).catch(() => false);

  await page.waitForTimeout(3500).catch(() => {});
  return { clicked };
}

async function clickTopLikedFacebookReelCommentReply(page, expectedText = "") {
  const target = await page.evaluate(expected => {
    const clean = value => String(value || "").replace(/\s+/g, " ").trim();
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
    const parseCount = value => {
      const text = clean(value).replace(/,/g, "").toLowerCase();
      if (!text || /\d{4}-\d{1,2}-\d{1,2}/.test(text)) return 0;
      const chinese = text.match(/(\d+(?:\.\d+)?)\s*(万|億|亿)/);
      if (chinese) {
        const amount = Number(chinese[1]);
        if (!Number.isFinite(amount)) return 0;
        return Math.round(amount * (chinese[2] === "万" ? 10_000 : 100_000_000));
      }
      const english = text.match(/(\d+(?:\.\d+)?)\s*([km])?\b/);
      if (!english) return 0;
      const amount = Number(english[1]);
      if (!Number.isFinite(amount)) return 0;
      if (english[2] === "k") return Math.round(amount * 1000);
      if (english[2] === "m") return Math.round(amount * 1000000);
      return Math.round(amount);
    };
    const exactCount = value => {
      const text = clean(value).replace(/,/g, "").toLowerCase();
      if (!/^\d+(?:\.\d+)?\s*([km]|万|億|亿)?$/.test(text)) return 0;
      return parseCount(text);
    };
    const mainBox = Array.from(document.querySelectorAll('[contenteditable="true"][role="textbox"]'))
      .find(element => isVisible(element) && /^(写评论…?|write a comment)$/i.test(clean(
        element.getAttribute("aria-label") ||
        element.getAttribute("aria-placeholder") ||
        ""
      )));
    const mainBoxLeft = mainBox?.getBoundingClientRect?.().left || 0;
    const panelLeft = Math.max(window.innerWidth * 0.58, mainBoxLeft ? mainBoxLeft - 90 : 0);
    const ownText = clean(expected);

    const likeCandidates = Array.from(document.querySelectorAll('[aria-label], [role="button"], span, div'))
      .map(element => {
        if (!isVisible(element)) return null;
        const rect = element.getBoundingClientRect();
        if (rect.left < panelLeft || rect.width > 180 || rect.height > 90) return null;
        const text = clean(element.innerText || element.textContent || "");
        const aria = clean(element.getAttribute("aria-label") || "");
        const count = Math.max(
          exactCount(text),
          /赞|like/i.test(aria) ? parseCount(`${aria} ${text}`) : 0,
        );
        if (!count) return null;
        return {
          count,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        };
      })
      .filter(Boolean);

    const seen = new Set();
    const replyTargets = Array.from(document.querySelectorAll('button, [role="button"]'))
      .map((element, index) => {
        if (!isVisible(element)) return null;
        const text = clean(element.innerText || element.textContent || "");
        const aria = clean(element.getAttribute("aria-label") || "");
        const label = (text || aria).toLowerCase();
        if (label !== "回复" && label !== "reply") return null;
        const rect = element.getBoundingClientRect();
        if (rect.left < panelLeft) return null;
        const key = `${Math.round(rect.left)}:${Math.round(rect.top)}:${Math.round(rect.width)}:${Math.round(rect.height)}`;
        if (seen.has(key)) return null;
        seen.add(key);

        let container = element;
        let bestText = text;
        for (let depth = 0; depth < 10 && container?.parentElement; depth += 1) {
          const parent = container.parentElement;
          const parentRect = parent.getBoundingClientRect();
          const parentText = clean(parent.innerText || parent.textContent || "");
          if (parentRect.left < panelLeft - 40 || parentRect.height > 650) break;
          if (parentText.length > bestText.length && parentText.length < 3000) {
            bestText = parentText;
            container = parent;
          } else {
            container = parent;
          }
        }
        if (ownText && bestText.includes(ownText)) return null;

        const containerRect = container.getBoundingClientRect();
        const y = rect.top + rect.height / 2;
        const likeCount = likeCandidates
          .filter(candidate => (
            Math.abs(candidate.y - y) <= 52 ||
            (candidate.y >= containerRect.top - 8 && candidate.y <= containerRect.bottom + 8)
          ))
          .reduce((max, candidate) => Math.max(max, candidate.count), 0);

        return {
          x: rect.left + rect.width / 2,
          y,
          likeCount,
          commentIndex: index,
          commentText: bestText.slice(0, 220),
          commentCount: 0,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.likeCount - a.likeCount || a.y - b.y || a.commentIndex - b.commentIndex);

    if (!replyTargets.length) return null;
    return {
      ...replyTargets[0],
      commentCount: replyTargets.length,
    };
  }, expectedText).catch(() => null);

  if (!target) {
    return {
      clicked: false,
      description: "top-liked-facebook-reel-comment-reply-not-found",
      commentCount: 0,
    };
  }

  await page.mouse.click(target.x, target.y).catch(() => {});
  await page.waitForTimeout(1200).catch(() => {});
  return {
    clicked: true,
    x: Math.round(target.x),
    y: Math.round(target.y),
    likeCount: target.likeCount || 0,
    commentIndex: target.commentIndex || 0,
    commentCount: target.commentCount || 0,
    commentText: target.commentText || "",
    description: `top-liked-facebook-reel-comment-reply likes=${target.likeCount || 0}`,
  };
}

async function findReelReplyBox(page, anchorY = 0) {
  return page.evaluate(replyAnchorY => {
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
    document.querySelectorAll('[data-codex-facebook-reel-reply-box="true"]')
      .forEach(element => element.removeAttribute("data-codex-facebook-reel-reply-box"));
    const boxes = Array.from(document.querySelectorAll('[contenteditable="true"][role="textbox"]'))
      .map(element => {
        if (!isVisible(element)) return null;
        const label = String(
          element.getAttribute("aria-label") ||
          element.getAttribute("aria-placeholder") ||
          ""
        ).trim();
        if (!/^(回复|reply\b|reply to\b)/i.test(label)) return null;
        const rect = element.getBoundingClientRect();
        return {
          element,
          rect: {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          },
          distance: replyAnchorY ? Math.abs((rect.top + rect.height / 2) - replyAnchorY) : rect.top,
          label,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.distance - b.distance);
    const target = boxes[0];
    if (!target) return null;
    target.element.setAttribute("data-codex-facebook-reel-reply-box", "true");
    return {
      rect: target.rect,
      label: target.label,
    };
  }, anchorY).catch(() => null);
}

async function fillReelReplyBox(page, text, anchorY = 0) {
  let box = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    box = await findReelReplyBox(page, anchorY);
    if (box) break;
    await page.waitForTimeout(500).catch(() => {});
  }
  if (!box) {
    return {
      ok: false,
      message: "facebook_reply_box_not_found",
    };
  }

  const clicked = await page.evaluate(() => {
    const target = document.querySelector('[data-codex-facebook-reel-reply-box="true"]');
    target?.focus?.();
    target?.click?.();
    return Boolean(target);
  }).catch(() => false);
  if (!clicked) {
    return {
      ok: false,
      message: "facebook_reply_box_not_found",
    };
  }

  await page.keyboard.press("End").catch(() => {});
  await page.keyboard.type(text, { delay: 8 });
  await page.waitForTimeout(800).catch(() => {});

  return {
    ok: true,
    message: "facebook_reply_filled",
    anchorY: box.rect.y,
    selector: box.label || "facebook-reel-reply-box",
  };
}

async function replyToTopLikedFacebookReelComment(page, commentText) {
  const replyClick = await clickTopLikedFacebookReelCommentReply(page, commentText);
  if (!replyClick.clicked) {
    return {
      filled: false,
      sent: false,
      sendVerified: false,
      attempted: false,
      replyClick,
      commentCount: replyClick.commentCount || 0,
      message: replyClick.description,
    };
  }

  const fillResult = await fillReelReplyBox(page, commentText, replyClick.y);
  if (!fillResult.ok) {
    return {
      filled: false,
      sent: false,
      sendVerified: false,
      attempted: true,
      replyClick,
      commentCount: replyClick.commentCount || 0,
      message: fillResult.message,
    };
  }

  const submitResult = await submitReelComment(page, { anchorY: fillResult.anchorY });
  const sendVerified = await hasReelCommentText(page, commentText);
  return {
    filled: true,
    sent: Boolean(submitResult.clicked || sendVerified),
    sendVerified,
    attempted: true,
    replyClick,
    commentCount: replyClick.commentCount || 0,
    likeCount: replyClick.likeCount || 0,
    commentText: replyClick.commentText || "",
    message: sendVerified ? "top_liked_comment_reply_sent" : "facebook_reply_not_verified",
  };
}

async function hasReelCommentText(page, text) {
  const normalized = cleanText(text);
  return page.evaluate(expected => {
    const clean = value => String(value || "").replace(/\s+/g, " ").trim();
    return clean(document.body?.innerText || "").includes(expected);
  }, normalized).catch(() => false);
}

async function getCurrentFacebookReelHref(page) {
  const href = page.url();
  if (isFacebookReelHref(href)) return cleanFacebookUrl(href);
  return page.evaluate(() => {
    const link = document.querySelector('a[href*="/reel/"]');
    return link?.href || location.href;
  }).then(cleanFacebookUrl).catch(() => cleanFacebookUrl(href));
}

async function commentOnCurrentFacebookReel(page, commentText, deps) {
  await deps.dismissCommonPrompts(page).catch(() => {});
  const href = await getCurrentFacebookReelHref(page);
  const alreadyCommented = await hasReelCommentText(page, commentText);
  if (alreadyCommented) {
    return {
      ok: true,
      href,
      status: "skipped",
      filled: false,
      replied: false,
      sent: false,
      replySent: false,
      sendVerified: true,
      replySendVerified: false,
      alreadyCommented: true,
      commentCount: 0,
      firstCommentMatches: false,
      firstThreadHasDraft: false,
      mainCommentText: commentText,
      replyCommentText: "",
      message: "existing_comment_found",
    };
  }

  const panelOpened = await openReelCommentPanel(page);
  if (!panelOpened) {
    return {
      ok: false,
      href,
      status: "failed",
      filled: false,
      replied: false,
      sent: false,
      replySent: false,
      sendVerified: false,
      replySendVerified: false,
      message: "comment_panel_not_opened",
      screenshotPath: await deps.saveDebugScreenshot(page, "facebook-reel-comment-panel-not-opened"),
    };
  }

  const replyResult = await replyToTopLikedFacebookReelComment(page, commentText);
  const fillResult = await fillReelCommentBox(page, commentText);
  if (!fillResult.ok) {
    return {
      ok: false,
      href,
      status: "failed",
      filled: false,
      replied: Boolean(replyResult.filled),
      sent: false,
      replySent: Boolean(replyResult.sent),
      sendVerified: false,
      replySendVerified: Boolean(replyResult.sendVerified),
      commentCount: replyResult.commentCount || 0,
      firstCommentMatches: false,
      firstThreadHasDraft: false,
      mainCommentText: commentText,
      replyCommentText: replyResult.attempted ? commentText : "",
      message: fillResult.message,
      screenshotPath: await deps.saveDebugScreenshot(page, "facebook-reel-comment-box-not-found"),
    };
  }

  const submitResult = await submitReelComment(page, { anchorY: fillResult.anchorY });
  const sendVerified = await hasReelCommentText(page, commentText);
  const replyRequired = Boolean(replyResult.attempted);
  const ok = Boolean(sendVerified && (!replyRequired || replyResult.sendVerified));

  return {
    ok,
    href,
    status: ok ? "sent" : "failed",
    filled: true,
    replied: Boolean(replyResult.filled),
    sent: Boolean(submitResult.clicked || sendVerified),
    replySent: Boolean(replyResult.sent),
    sendVerified,
    replySendVerified: Boolean(replyResult.sendVerified),
    alreadyCommented: false,
    commentCount: replyResult.commentCount || 0,
    firstCommentMatches: false,
    firstThreadHasDraft: false,
    mainCommentText: commentText,
    replyCommentText: replyResult.attempted ? commentText : "",
    message: ok
      ? (replyResult.sendVerified ? "top_liked_comment_reply_and_main_comment_sent" : "main_comment_sent")
      : (sendVerified ? replyResult.message : "facebook_comment_not_verified"),
    screenshotPath: ok ? "" : await deps.saveDebugScreenshot(page, "facebook-reel-comment-not-verified"),
  };
}

async function moveToNextFacebookReel(page, previousHref) {
  const before = cleanFacebookUrl(previousHref || await getCurrentFacebookReelHref(page));
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(500).catch(() => {});

  const clicked = await page.evaluate(() => {
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
        rect.top < window.innerHeight
      );
    };

    const target = Array.from(document.querySelectorAll('[role="button"], button'))
      .find(element => {
        if (!isVisible(element)) return false;
        const label = String(element.getAttribute("aria-label") || "").trim();
        return /^(下一条快拍|next reel|next clip|next)$/i.test(label);
      });
    target?.click?.();
    return Boolean(target);
  }).catch(() => false);

  if (!clicked) {
    return {
      ok: false,
      href: before,
      previousHref: before,
      message: "next_reel_button_not_found",
    };
  }

  await page.waitForTimeout(2800).catch(() => {});
  const after = await getCurrentFacebookReelHref(page);
  if (after && after !== before && isFacebookReelHref(after)) {
    return { ok: true, href: after, method: "next-reel-button" };
  }

  return {
    ok: false,
    href: after,
    previousHref: before,
    message: "next_video_not_available",
  };
}

async function openFirstReelForKeyword(context, keyword, args, deps) {
  const searchResult = await searchFacebookReels({
    ...args,
    keyword,
    limit: 1,
    headed: true,
    keepOpen: true,
  }, deps);
  if (!searchResult.ok) {
    return {
      ok: false,
      message: searchResult.message || "no_results",
      debugState: searchResult.debugState,
    };
  }

  const href = searchResult.payload?.results?.[0]?.href || searchResult.preview?.[0]?.href || "";
  if (!href) {
    return {
      ok: false,
      message: "no_results",
    };
  }

  await deps.keepOnlyPrimaryPage(context);
  const page = context.pages()[0] || await context.newPage();
  const currentHref = await getCurrentFacebookReelHref(page);
  if (isFacebookReelHref(currentHref)) {
    return {
      ok: true,
      page,
      href: currentHref,
      openedFromSearchContext: true,
    };
  }

  await openFacebookUrl(page, href);
  if (page.openError) {
    return {
      ok: false,
      page,
      href,
      message: "open_error",
    };
  }

  return {
    ok: true,
    page,
    href: await getCurrentFacebookReelHref(page),
  };
}

async function reopenReelWithNextKeyword(context, job, args, deps) {
  for (let i = job.keywordIndex + 1; i < job.keywordPool.length; i += 1) {
    if (job.cancelled) break;
    job.keywordIndex = i;
    job.currentKeyword = job.keywordPool[i];
    const opened = await openFirstReelForKeyword(context, job.currentKeyword, args, deps);
    if (opened.ok) return opened;
  }

  return {
    ok: false,
    message: "keyword_pool_exhausted",
  };
}

function toStatusResult(result, commentText, keyword) {
  return {
    href: result.href || "",
    keyword,
    status: result.status || (result.ok ? "sent" : "failed"),
    alreadyCommented: Boolean(result.alreadyCommented),
    ownCommentDetected: Boolean(result.sendVerified),
    commentCount: Number(result.commentCount || 0),
    firstCommentMatches: Boolean(result.firstCommentMatches),
    firstThreadHasDraft: Boolean(result.firstThreadHasDraft),
    filled: Boolean(result.filled),
    replied: Boolean(result.replied),
    sent: Boolean(result.sent),
    replySent: Boolean(result.replySent),
    sendVerified: Boolean(result.sendVerified),
    replySendVerified: Boolean(result.replySendVerified),
    mainCommentText: result.mainCommentText || commentText,
    replyCommentText: result.replyCommentText || "",
    blocking: "",
    screenshotPath: result.screenshotPath || "",
    message: result.message || "",
  };
}

function startFacebookReelReviewSequence(args = {}, deps, setJob) {
  const initialHrefs = Array.from(new Set((args.hrefs || [])
    .map(item => cleanFacebookUrl(String(item || "").trim()))
    .filter(isFacebookReelHref)));
  const requestedMaxVideos = Number.isFinite(Number(args.maxVideos)) ? Number(args.maxVideos) : 100000;
  const maxVideos = Math.max(1, Math.min(Math.floor(requestedMaxVideos), 100000));
  const requestedHoldMs = Number.isFinite(Number(args.holdMs)) ? Number(args.holdMs) : 5_000;
  const requestedRandomHoldMs = Number.isFinite(Number(args.randomHoldMs)) ? Number(args.randomHoldMs) : 5_000;
  const holdMs = Math.max(1_000, Math.min(requestedHoldMs, 900_000));
  const randomHoldMs = Math.max(0, Math.min(requestedRandomHoldMs, 300_000));
  const chromeProfileName = String(args.chromeProfileName || "").trim();
  const searchKeyword = cleanText(args.searchKeyword || args.keyword || "");
  const keywordPool = normalizeKeywordPool(searchKeyword, args.keywordPool || []);
  const commentDrafts = Array.isArray(args.commentDrafts) ? args.commentDrafts.filter(Boolean) : [];

  if (!initialHrefs.length && !keywordPool.length) {
    return {
      ok: false,
      message: "No Facebook Reel link or keyword provided for review sequence.",
    };
  }

  const job = {
    channel: "facebook",
    contentType: "reel",
    hrefs: initialHrefs,
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
    currentKeyword: keywordPool[0] || searchKeyword,
    keywordPool,
    keywordIndex: 0,
  };
  setJob(job);

  (async () => {
    const context = await deps.getRetainedContext({
      headed: true,
      syncSystemProfile: false,
      chromeProfileName,
    });
    await deps.keepOnlyPrimaryPage(context);
    let page = context.pages()[0] || await context.newPage();

    if (initialHrefs[0]) {
      await openFacebookUrl(page, initialHrefs[0]);
    } else {
      const opened = await openFirstReelForKeyword(context, job.currentKeyword, args, deps);
      if (!opened.ok) {
        job.failed += 1;
        job.results.push(toStatusResult({
          href: "",
          status: "failed",
          message: opened.message || "no_results",
          screenshotPath: await deps.saveDebugScreenshot(page, "facebook-reel-open-first-failed"),
        }, "", job.currentKeyword));
        job.running = false;
        return;
      }
      page = opened.page;
    }

    for (let index = 0; index < maxVideos; index += 1) {
      if (job.cancelled) break;

      if (index > 0) {
        const previousHref = await getCurrentFacebookReelHref(page);
        const nextResult = await moveToNextFacebookReel(page, previousHref);
        if (!nextResult.ok) {
          const reopened = await reopenReelWithNextKeyword(context, job, args, deps);
          if (!reopened.ok) {
            job.failed += 1;
            job.results.push(toStatusResult({
              href: nextResult.href || previousHref,
              status: "failed",
              message: reopened.message || nextResult.message || "next_video_not_available",
              screenshotPath: await deps.saveDebugScreenshot(page, "facebook-reel-next-failed"),
            }, "", job.currentKeyword));
            break;
          }
          page = reopened.page;
          index -= 1;
          continue;
        }
      }

      const href = await getCurrentFacebookReelHref(page);
      const commentText = commentDrafts[Math.floor(Math.random() * commentDrafts.length)] || args.defaultComment || "";
      job.current = index + 1;
      job.currentHref = href;

      const result = await commentOnCurrentFacebookReel(page, commentText, deps).catch(async error => ({
        ok: false,
        href,
        status: "failed",
        filled: false,
        sent: false,
        sendVerified: false,
        message: `exception: ${error.message}`,
        screenshotPath: await deps.saveDebugScreenshot(page, "facebook-reel-comment-exception"),
      }));

      const itemResult = toStatusResult(result, commentText, job.currentKeyword);
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
        await sleep(delayMs);
      }
    }

    job.running = false;
  })().catch(() => {
    job.running = false;
  });

  return {
    ok: true,
    channel: "facebook",
    contentType: "reel",
    message: `Started Facebook Reel review sequence for up to ${maxVideos} reels.`,
    total: maxVideos,
    maxVideos,
    holdMs,
    randomHoldMs,
  };
}

module.exports = {
  extractFacebookReelResults,
  isFacebookReelHref,
  searchFacebookReels,
  startFacebookReelReviewSequence,
};
