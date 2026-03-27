// ─── Inject QA styles into this frame ─────────────────────────────────────────
const _styleLink = document.createElement("link");
_styleLink.rel = "stylesheet";
_styleLink.href = browser.runtime.getURL("scripts/styles-injector.css");
(document.head || document.documentElement).appendChild(_styleLink);

// ─── State ────────────────────────────────────────────────────────────────────

let frameCreatives = [];
let _creativeCounter = 0; // monotonic index; never resets within a page load

// Doubles as "already seen" check AND selector cache (Map<element, cssSelector>)
const elementSelectorCache = new Map();

function _selectorFor(el, index) {
  return el.id
    ? `gwd-page#${CSS.escape(el.id)}`
    : `gwd-page:nth-of-type(${index + 1})`;
}

// ─── Creative-ID extraction ───────────────────────────────────────────────────

/**
 * Matches DCD/ACQ IDs in all their known formats:
 *   DCD545, ACQ009           — simple numeric
 *   DCD-MF-T-167, DCD-MF-R-167  — hyphenated
 *   DCD_MF_T_167             — underscore separators
 *   DCD-MF-T-167_BASE        — with qualifier suffix
 * Non-greedy, anchored by the _WIDTHxHEIGHT size token or a non-ID character.
 */
const _ID_PATTERN =
  /((?:ACQ|DCD)[\w-]+?)(?=_\d{2,4}x\d{2,4}|[^A-Za-z0-9_-]|$)/i;

/** Strip GWD qualifiers (_BASE, _F1, _F2) that aren't part of the base ID number. */
function _stripQualifiers(id) {
  return id.replace(/[_-](?:BASE|F[12])$/i, "").toUpperCase();
}

/**
 * Extract the creative ID from this frame.
 * Priority: #h5GeneratedCode Logo_Image_Name.Url → Reporting_Label → full h5 scan
 *           → resource URLs → inline scripts.
 * Handles both hyphenated (DCD-MF-T-167) and underscore (DCD_MF_T_167) variants.
 */
// Helper to sleep for a set time
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

async function extractCreativeId() {
  const _ID_PATTERN =
    /((?:ACQ|DCD)[\w-]+?)(?=_\d{2,4}x\d{2,4}|[^A-Za-z0-9_-]|$)/i;

  // --- Core Extraction (Runs inside the polling loop) ---
  const attemptExtraction = () => {
    // 1. Strict URL/Reporting Label check
    const urlParams = new URLSearchParams(window.location.search);
    const urlLabel =
      urlParams.get("reporting_label") ||
      urlParams.get("reportingLabel") ||
      urlParams.get("rl");
    if (urlLabel) {
      const m = urlLabel.match(_ID_PATTERN);
      if (m)
        return { id: _stripQualifiers(m[1]), source: "URL Reporting Label" };
    }

    const htmlMatch = document.documentElement.innerHTML.match(
      /["']?(?:Reporting_Label|reportingLabel|reporting_label)["']?\s*:\s*["']?([^"'\\]+)["'\\]?/i,
    );
    if (htmlMatch) {
      const m = htmlMatch[1].match(_ID_PATTERN);
      if (m)
        return {
          id: _stripQualifiers(m[1]),
          source: "Strict Reporting Label in HTML",
        };
    }

    // 2. Scan rendered media elements (Very High Confidence - actual dynamic pixels)
    const mediaElements = document.querySelectorAll(
      "gwd-image, gwd-video, img, source",
    );
    for (const el of mediaElements) {
      const src =
        el.getAttribute("source") ||
        el.getAttribute("src") ||
        el.getAttribute("data-src") ||
        "";
      const m = src.match(_ID_PATTERN);
      if (m)
        return {
          id: _stripQualifiers(m[1]),
          source: `Media element: ${src.split("/").pop()}`,
        };
    }

    // 3. Scan Network Resources (Very High Confidence - catches dynamic CSS background-images)
    try {
      for (const r of performance.getEntriesByType("resource")) {
        // Skip JS and HTML files to avoid accidentally matching template names in file paths
        if (r.name.includes(".js") || r.name.includes(".html")) continue;
        const m = r.name.match(_ID_PATTERN);
        if (m)
          return {
            id: _stripQualifiers(m[1]),
            source: `Network resource: ${r.name.split("/").pop()}`,
          };
      }
    } catch (e) {}

    return null;
  };

  // Poll for the dynamic assets to load (Max 3 seconds)
  const MAX_RETRIES = 6;
  for (let i = 0; i < MAX_RETRIES; i++) {
    const result = attemptExtraction();
    if (result) {
      console.log(`[GWD QA] ✓ ID "${result.id}" found via ${result.source}`);
      return result.id;
    }

    if (i < MAX_RETRIES - 1) {
      console.log(
        `[GWD QA] Dynamic assets not loaded yet. Waiting... (Attempt ${i + 1})`,
      );
      await delay(500);
    }
  }

  console.warn(
    "[GWD QA] Safe dynamic extraction failed. Falling back to risky script scan...",
  );

  // --- Fallback (Runs ONLY if nothing loaded after 3 seconds) ---
  // This is kept at the very bottom because scripts often contain stale fallback data (like DCD515)
  for (const script of document.querySelectorAll("script")) {
    const m = script.textContent.match(_ID_PATTERN);
    if (m) {
      console.log(
        `[GWD QA] ⚠ ID "${_stripQualifiers(m[1])}" found in generic <script> scan (May be a fallback template)`,
      );
      return _stripQualifiers(m[1]);
    }
  }

  const htmlIdMatch = document.documentElement.innerHTML.match(_ID_PATTERN);
  if (htmlIdMatch) {
    console.log(
      `[GWD QA] ⚠ ID "${_stripQualifiers(htmlIdMatch[1])}" found via full HTML scan`,
    );
    return _stripQualifiers(htmlIdMatch[1]);
  }

  return null;
}

/**
 * Score a CSS rgb/rgba color string for a DARK THEME UI.
 * Favors high saturation and medium-high lightness.
 * Rejects dark colors (which blend into black) and pure whites/grays.
 */
function _colorVibrancy(rgb) {
  const m = rgb.match(/\d+/g);
  if (!m || m.length < 3) return 0;

  // Convert to 0-1 range
  const r = Number(m[0]) / 255;
  const g = Number(m[1]) / 255;
  const b = Number(m[2]) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;

  // 1. Reject colors that are too dark for a black background (< 30% lightness)
  // 2. Reject colors that are practically white (> 85% lightness)
  if (lightness < 0.3 || lightness > 0.85) return 0;

  // Calculate Saturation
  const saturation =
    max === min ? 0 : (max - min) / (1 - Math.abs(2 * lightness - 1));

  // Reject dull/gray colors
  if (saturation < 0.35) return 0;

  // Score: Multiply saturation by how close lightness is to the "sweet spot" (0.6)
  // This guarantees bright, punchy neon/pastel accents that look amazing on black
  const lightnessSweetSpot = 1 - Math.abs(lightness - 0.6);
  return saturation * lightnessSweetSpot;
}

/**
 * Helper to force any RGB color into a vibrant, bright shade
 * that looks good against a black background (boosts Lightness/Saturation).
 */
function _adjustColorForDarkTheme(rgbStr) {
  const m = rgbStr.match(/\d+/g);
  if (!m || m.length < 3) return rgbStr;

  let r = Number(m[0]) / 255;
  let g = Number(m[1]) / 255;
  let b = Number(m[2]) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0,
    s = 0,
    l = (max + min) / 2;

  // Convert RGB to HSL
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }

  // --- THE MAGIC: Adjust for Dark UI ---
  // If the color is too dark, boost its lightness to a bright "sweet spot"
  if (l < 0.55) l = 0.65;

  // If the color has some hue but is washed out/dull, boost its saturation
  if (s > 0.05 && s < 0.6) s = 0.8;

  // Convert HSL back to RGB
  let r2, g2, b2;
  if (s === 0) {
    r2 = g2 = b2 = l; // achromatic (grays)
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r2 = hue2rgb(p, q, h + 1 / 3);
    g2 = hue2rgb(p, q, h);
    b2 = hue2rgb(p, q, h - 1 / 3);
  }

  return `rgb(${Math.round(r2 * 255)}, ${Math.round(g2 * 255)}, ${Math.round(b2 * 255)})`;
}

/**
 * Extract the most vibrant accent color from the creative.
 * Checks well-known GWD element IDs first (headline, CTA, background, etc.),
 * then falls back to a general layout scan.
 */
function sampleAccentColor(el) {
  const GWD_IDS = [
    "#headline",
    "#cta",
    "#background_color",
    "#headline_2",
    "#subheadline",
    "#bg",
    "#background",
    "#logo",
  ];
  const candidates = [];

  for (const id of GWD_IDS) {
    const node = el.querySelector(id);
    if (!node) continue;
    const style = getComputedStyle(node);
    for (const prop of ["backgroundColor", "color"]) {
      const c = style[prop];
      if (c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent") {
        candidates.push(c);
      }
    }
  }

  // Fallback: general layout elements
  if (!candidates.length) {
    for (const node of [
      el,
      ...el.querySelectorAll(".gwd-page-content, .gwd-div"),
    ]) {
      const bg = getComputedStyle(node).backgroundColor;
      if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
        candidates.push(bg);
        if (candidates.length >= 4) break;
      }
    }
  }

  if (!candidates.length) return null;

  // 1. Sort by our original vibrancy checker to find the most colorful candidate
  const bestColor = candidates.sort(
    (a, b) => _colorVibrancy(b) - _colorVibrancy(a),
  )[0];

  // 2. Pass the winner through our dark-theme adjuster so it pops on black!
  return _adjustColorForDarkTheme(bestColor);
} // ─── Detection ────────────────────────────────────────────────────────────────

async function detectCreatives() {
  // Prune stale elements
  for (const [el] of elementSelectorCache) {
    if (!document.contains(el)) {
      elementSelectorCache.delete(el);
      const idx = frameCreatives.findIndex((c) => c.element === el);
      if (idx !== -1) frameCreatives.splice(idx, 1);
    }
  }

  const gwdPages = [...document.querySelectorAll("gwd-page")];
  const injectionPromises = [];

  for (const [i, el] of gwdPages.entries()) {
    if (elementSelectorCache.has(el)) continue; // already processed
    elementSelectorCache.set(el, _selectorFor(el, i));

    const rawIdNum = await extractCreativeId();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const size = w > 0 && h > 0 ? `${w}x${h}` : null;

    // SW assigns a unique ID across all frames in this tab;
    // duplicates are incremented: DCD545 → DCD546 → DCD547 …
    let idNum = rawIdNum,
      originalIdNum = null;
    if (rawIdNum) {
      try {
        const res = await browser.runtime.sendMessage({
          action: "reserveCreativeId",
          idNum: rawIdNum,
        });
        idNum = res.effectiveIdNum;
        originalIdNum = res.originalIdNum;
        if (originalIdNum)
          console.log(`[GWD QA] ⚠ Duplicate "${rawIdNum}" → using "${idNum}"`);
      } catch (_) {}
    }

    const label =
      idNum && size
        ? `${idNum}_${size}`
        : el
            .querySelector("gwd-gpa-data-provider")
            ?.getAttribute("profile-name") ||
          el.id ||
          `gwd-page-${_creativeCounter}`;

    const existingGuide =
      el.querySelector("gwd-image[id^='guide']") ||
      el.querySelector("gwd-image[id^='GUIDE']") ||
      el.querySelector("img[id^='guide_']");

    const creative = {
      id: label,
      idNum,
      originalIdNum,
      className: el.className,
      index: _creativeCounter++,
      type: "gwd-page",
      element: el,
      hasGuide: !!existingGuide,
      guides: existingGuide?.id ? [existingGuide.id] : [],
      guideSrcs: {}, // guideId → data URL; survives GWD DOM re-renders
      accentColor: sampleAccentColor(el),
    };

    frameCreatives.push(creative);
    console.log(`[GWD QA] 🎬 "${label}" idNum=${idNum} size=${size}`);

    if (!creative.hasGuide) injectionPromises.push(injectGuideImage(creative));
  }

  await Promise.all(injectionPromises);
  await fillMissingVariants(); // Make sure to add 'await' here!
  return gwdPages.length;
}

// ─── Guide injection ──────────────────────────────────────────────────────────

async function injectGuideImage(creative) {
  // Capture targets before any await to prevent cross-contamination
  const element = creative.element;
  const idNum = creative.idNum || (await extractCreativeId());
  const sizeMatch = creative.id?.match(/(\d+)x(\d+)/);
  const width = sizeMatch ? parseInt(sizeMatch[1], 10) : element.offsetWidth;
  const height = sizeMatch ? parseInt(sizeMatch[2], 10) : element.offsetHeight;
  const contentDiv = element.querySelector(
    "div.gwd-page-content.gwd-page-size",
  );

  if (!idNum) {
    console.log(`[GWD QA] No ID — skipping guide injection`);
    return;
  }
  if (!width || !height) {
    console.log(`[GWD QA] Dimensions 0 — skipping`);
    return;
  }
  if (!contentDiv) {
    console.log(`[GWD QA] gwd-page-content not found`);
    return;
  }

  if (getComputedStyle(contentDiv).position === "static")
    contentDiv.style.position = "relative";

  const size = `${width}x${height}`;
  if (!creative.idNum) {
    creative.idNum = idNum;
    creative.id = `${idNum}_${size}`;
  }

  const queryBases = [`${idNum}_${size}`];
  if (creative.originalIdNum)
    queryBases.push(`${creative.originalIdNum}_${size}`);

  // We ALWAYS search for the Base, F1, and F2 guides
  const searchSuffixes = ["", "_f1", "_f2"];

  let found = false;

  for (const queryBase of queryBases) {
    if (found) break;
    if (queryBase !== queryBases[0])
      console.log(
        `[GWD QA] Falling back to original ID "${creative.originalIdNum}"`,
      );

    const available = new Map();

    // Probe Drive for all 3 possible files concurrently
    for (const suffix of searchSuffixes) {
      const elemId = `guide_${queryBase}${suffix}`;
      const query = `${queryBase}${suffix}`;

      if (element.querySelector(`#${CSS.escape(elemId)}`)) {
        available.set(suffix, "dom");
        continue;
      }
      try {
        const url = await browser.runtime.sendMessage({
          action: "getGuideURL",
          searchQuery: query,
        });
        if (url) {
          available.set(suffix, url);
          creative.guideSrcs[elemId] = url; // cache for re-injection
        }
      } catch (err) {
        console.error(`[GWD QA] Drive error (${query}):`, err.message);
      }
    }

    // --- STRICT VARIANT LOGIC ---
    const hasBase = available.has("");
    const hasF1 = available.has("_f1");
    const hasF2 = available.has("_f2");

    let toInject = [];

    if (hasBase) {
      // 1. If we found a Base guide, it serves as the first frame.
      toInject.push("");
      // 2. We ONLY inject F2 if the base guide is found.
      if (hasF2) toInject.push("_f2");
      // 3. We intentionally ignore F1 to prevent injecting 3 guides!
    } else {
      // If no Base guide exists, fallback to injecting the frames if the designer uploaded them
      if (hasF1) toInject.push("_f1");
      if (hasF2) toInject.push("_f2");
    }

    // Inject whatever made it into the array as totally separate DOM elements
    for (const suffix of toInject) {
      const elemId = `guide_${queryBase}${suffix}`;
      const url = available.get(suffix);

      if (url === "dom") {
        if (!creative.guides.includes(elemId)) creative.guides.push(elemId);
        found = true;
      } else {
        const img = document.createElement("img");
        img.id = elemId;
        img.src = url;
        img.style.cssText = `width:${width}px;height:${height}px;position:absolute;top:0;left:0;pointer-events:none;opacity:0;`;
        contentDiv.appendChild(img);
        if (!creative.guides.includes(elemId)) creative.guides.push(elemId);
        found = true;
        console.log(`[GWD QA] ✓ Injected: ${elemId} → "${creative.id}"`);

        // NEW: If we just fetched an f1 or f2 variant, broadcast it to sister creatives!
        if (suffix === "_f1" || suffix === "_f2") {
          browser.runtime
            .sendMessage({
              action: "shareVariantGuide",
              size: size,
              suffix: suffix,
              guideId: elemId,
              src: url,
            })
            .catch(() => {});
        }
      }
    }
  }

  if (found) creative.hasGuide = true;
  else console.log(`[GWD QA] No guides found for "${creative.id}"`);
}

// ─── Cross-creative variant sharing ───────────────────────────────────────────

async function fillMissingVariants() {
  let sharedVariants = [];
  try {
    sharedVariants = await browser.runtime.sendMessage({
      action: "requestSharedVariants",
    });
  } catch (e) {}

  if (!sharedVariants || !sharedVariants.length) return;

  for (const creative of frameCreatives) {
    const m = creative.id?.match(/(\d+)x(\d+)/);
    if (!m) continue;
    const size = `${m[1]}x${m[2]}`;

    // RULE: We only copy F2 if this creative successfully found its own Base guide
    const hasBaseGuide = creative.guides.some(
      (g) => !g.endsWith("_f1") && !g.endsWith("_f2"),
    );
    if (!hasBaseGuide) continue;

    const applicable = sharedVariants.filter((v) => v.size === size);
    for (const variant of applicable) {
      // RULE: Since we have a Base guide, we DO NOT want the shared _f1 (that would make 3 guides)
      if (variant.suffix === "_f1") continue;

      const alreadyHasVariant = creative.guides.some((g) =>
        g.endsWith(variant.suffix),
      );
      if (alreadyHasVariant) continue;
      if (creative.element.querySelector(`#${CSS.escape(variant.guideId)}`))
        continue;

      const contentDiv = creative.element.querySelector(
        "div.gwd-page-content.gwd-page-size",
      );
      if (!contentDiv) continue;

      const img = document.createElement("img");
      img.id = variant.guideId;
      img.src = variant.src;
      img.style.cssText = `width:${m[1]}px;height:${m[2]}px;position:absolute;top:0;left:0;pointer-events:none;opacity:0;`;
      contentDiv.appendChild(img);

      creative.guides.push(variant.guideId);
      creative.hasGuide = true;
      console.log(
        `[GWD QA] ✓ Cross-frame injected: "${variant.guideId}" → "${creative.id}"`,
      );
    }
  }
}

// ─── Guide state persistence ──────────────────────────────────────────────────

function saveGuideState(guideId, opacity) {
  localStorage.setItem(`gwd-qa:${location.href}:${guideId}`, String(opacity));
}

function restoreGuideStates() {
  for (const creative of frameCreatives) {
    for (const guideId of creative.guides) {
      const stored = localStorage.getItem(`gwd-qa:${location.href}:${guideId}`);
      if (!stored || stored === "0") continue;
      const el = creative.element.querySelector(`#${CSS.escape(guideId)}`);
      if (el) el.style.opacity = stored;
    }
  }
}

// ─── Highlight overlay ────────────────────────────────────────────────────────

const HIGHLIGHT_CLASS = "gwd-qa-highlight";

/** Helper to extract raw "R, G, B" numbers from an rgb string */
function getAccentRgbParts(colorStr) {
  if (!colorStr) return "96, 165, 250"; // default blue
  const m = colorStr.match(/\d+/g);
  if (m && m.length >= 3) return `${m[0]}, ${m[1]}, ${m[2]}`;
  return "96, 165, 250";
}

function applyHighlight(creative) {
  if (creative.element.querySelector(`.${HIGHLIGHT_CLASS}`)) return;
  if (getComputedStyle(creative.element).position === "static") {
    creative.element.style.position = "relative";
  }

  const rgbParts = getAccentRgbParts(creative.accentColor);
  const overlay = document.createElement("div");
  overlay.className = HIGHLIGHT_CLASS;

  // Apply the CSS variables directly to the element so the animation can use them
  overlay.style.cssText = `
    position:absolute;inset:0;pointer-events:none;z-index:9999;
    border:3px solid rgba(${rgbParts}, 0.9);border-radius:4px;
    box-shadow:0 0 20px rgba(${rgbParts}, 0.45);
    animation:gwd-qa-pulse 1.5s ease-in-out infinite;
    --qa-glow-dim: rgba(${rgbParts}, 0.4);
    --qa-border-dim: rgba(${rgbParts}, 0.8);
    --qa-glow-bright: rgba(${rgbParts}, 0.7);
    --qa-border-bright: rgba(${rgbParts}, 1);
  `;

  creative.element.appendChild(overlay);
}

function removeHighlight(creative) {
  creative.element.querySelector(`.${HIGHLIGHT_CLASS}`)?.remove();
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  console.log("[GWD QA] Starting detection…");

  // Scroll to the bottom of the page immediately to trigger lazy-loaded elements
  window.scrollTo(0, document.body.scrollHeight);

  await detectCreatives();
  restoreGuideStates();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

// ─── Message listener ─────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener(async (request) => {
  // NEW: Catch real-time broadcasts if a sister creative finishes loading variants late
  if (request.action === "receiveSharedVariant") {
    const { size, suffix, guideId, src } = request;
    for (const creative of frameCreatives) {
      const m = creative.id?.match(/(\d+)x(\d+)/);
      if (!m) continue;
      const cSize = `${m[1]}x${m[2]}`;
      if (cSize !== size) continue; // Must be identical dimensions

      // RULE: We only accept broadcasts if we successfully found our own Base guide
      const hasBaseGuide = creative.guides.some(
        (g) => !g.endsWith("_f1") && !g.endsWith("_f2"),
      );
      if (!hasBaseGuide) continue;

      // RULE: Since we have a Base guide, we DO NOT want the shared _f1
      if (suffix === "_f1") continue;

      const alreadyHasVariant = creative.guides.some((g) => g.endsWith(suffix));
      if (alreadyHasVariant) continue;
      if (creative.element.querySelector(`#${CSS.escape(guideId)}`)) continue;

      const contentDiv = creative.element.querySelector(
        "div.gwd-page-content.gwd-page-size",
      );
      if (!contentDiv) continue;

      const img = document.createElement("img");
      img.id = guideId;
      img.src = src;
      img.style.cssText = `width:${m[1]}px;height:${m[2]}px;position:absolute;top:0;left:0;pointer-events:none;opacity:0;`;
      contentDiv.appendChild(img);

      creative.guides.push(guideId);
      creative.hasGuide = true;
      console.log(
        `[GWD QA] ✓ Real-time injected: "${guideId}" → "${creative.id}"`,
      );
    }
    return;
  }

  // Popup requests the creative list
  if (request.action === "getCreatives") {
    await detectCreatives();
    // Sync guides array with whatever is in the DOM right now
    for (const creative of frameCreatives) {
      const guideEls = [
        ...creative.element.querySelectorAll("gwd-image[id^='guide']"),
        ...creative.element.querySelectorAll("gwd-image[id^='GUIDE']"),
        ...creative.element.querySelectorAll("img[id^='guide_']"),
      ];
      for (const g of guideEls) {
        if (g.id && !creative.guides.includes(g.id)) {
          creative.guides.push(g.id);
          creative.hasGuide = true;
        }
      }
    }
    return frameCreatives.map((c) => ({
      id: c.id,
      className: c.className,
      index: c.index,
      type: c.type,
      hasGuide: c.hasGuide,
      guides: c.guides,
      accentColor: c.accentColor,
    }));
  }

  // Popup sends local frame indices; highlight matching creatives, clear the rest
  if (request.action === "highlightCreatives") {
    for (const creative of frameCreatives) {
      if (request.localIndices?.includes(creative.index))
        applyHighlight(creative);
      else removeHighlight(creative);
    }
    return;
  }

  // Individual guide opacity control.
  // Use querySelectorAll (not getElementById) so that if two creatives in the same
  // document share a guide ID (e.g. the copied _f2 overlay), both respond.
  if (request.action === "setGuideOpacity") {
    document
      .querySelectorAll(`[id="${CSS.escape(request.guideId)}"]`)
      .forEach((guide) => {
        guide.style.opacity = request.opacity;
      });
    saveGuideState(request.guideId, request.opacity);
    return;
  }
});
