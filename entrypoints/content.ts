export default defineContentScript({
  matches: [
    "https://*.adspreview.googleusercontent.com/*",
    "https://www.google.com/doubleclick/preview/dynamic/previewsheet/*",
    "http://localhost/*",
    "https://s0.2mdn.net/*",
    "https://tpc.googlesyndication.com/*",
  ],
  allFrames: true,
  runAt: "document_start",

  main() {
    // ─── Inject QA styles into this frame ─────────────────────────────────────
    const _styleLink = document.createElement("link");
    _styleLink.rel = "stylesheet";
    _styleLink.href = browser.runtime.getURL("/styles-injector.css");
    (document.head || document.documentElement).appendChild(_styleLink);

    // ─── State ──────────────────────────────────────────────────────────────────

    let frameCreatives: any[] = [];
    let _creativeCounter = 0;
    const elementSelectorCache = new Map<Element, string>();

    // Frame variant helpers — matches f1, f2, f3, … (any f followed by digits)
    const VARIANT_SUFFIXES = ["_f1", "_f2"];
    const isVariantSuffix = (s: string) => /^_f\d+$/i.test(s);
    const isVariantGuideId = (g: string) => /_f\d+$/i.test(g);

    function _selectorFor(el: Element, index: number): string {
      return el.id
        ? `gwd-page#${CSS.escape(el.id)}`
        : `gwd-page:nth-of-type(${index + 1})`;
    }

    // ─── Creative-ID extraction ─────────────────────────────────────────────────

    const _ID_PATTERN =
      /((?:ACQ|DCD)[\w-]+?)(?=_\d{2,4}x\d{2,4}|[^A-Za-z0-9_-]|$)/i;

    function _stripQualifiers(id: string): string {
      return id.replace(/[_-](?:BASE|F[12])$/i, "").toUpperCase();
    }

    const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

    async function extractCreativeId(): Promise<string | null> {
      const _ID_RE =
        /((?:ACQ|DCD)[\w-]+?)(?=_\d{2,4}x\d{2,4}|[^A-Za-z0-9_-]|$)/i;

      const attemptExtraction = (): { id: string; source: string } | null => {
        // 1. URL Reporting Label
        const urlParams = new URLSearchParams(window.location.search);
        const urlLabel =
          urlParams.get("reporting_label") ||
          urlParams.get("reportingLabel") ||
          urlParams.get("rl");
        if (urlLabel) {
          const m = urlLabel.match(_ID_RE);
          if (m)
            return {
              id: _stripQualifiers(m[1]),
              source: "URL Reporting Label",
            };
        }

        // 2. HTML Reporting Label
        const htmlMatch = document.documentElement.innerHTML.match(
          /["']?(?:Reporting_Label|reportingLabel|reporting_label)["']?\s*:\s*["']?([^"'\\]+)["'\\]?/i,
        );
        if (htmlMatch) {
          const m = htmlMatch[1].match(_ID_RE);
          if (m)
            return {
              id: _stripQualifiers(m[1]),
              source: "Strict Reporting Label in HTML",
            };
        }

        // 3. Media elements
        const mediaElements = document.querySelectorAll(
          "gwd-image, gwd-video, img, source",
        );
        for (const el of mediaElements) {
          const src =
            el.getAttribute("source") ||
            el.getAttribute("src") ||
            el.getAttribute("data-src") ||
            "";
          const m = src.match(_ID_RE);
          if (m)
            return {
              id: _stripQualifiers(m[1]),
              source: `Media element: ${src.split("/").pop()}`,
            };
        }

        // 4. Network resources
        try {
          for (const r of performance.getEntriesByType("resource")) {
            if (r.name.includes(".js") || r.name.includes(".html")) continue;
            const m = r.name.match(_ID_RE);
            if (m)
              return {
                id: _stripQualifiers(m[1]),
                source: `Network resource: ${r.name.split("/").pop()}`,
              };
          }
        } catch (e) {}

        return null;
      };

      // Poll for dynamic assets (Max 3 seconds)
      const MAX_RETRIES = 6;
      for (let i = 0; i < MAX_RETRIES; i++) {
        const result = attemptExtraction();
        if (result) {
          console.log(
            `[GWD QA] ✓ ID "${result.id}" found via ${result.source}`,
          );
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

      // Fallback: script scan
      for (const script of document.querySelectorAll("script")) {
        const m = script.textContent?.match(_ID_PATTERN);
        if (m) {
          console.log(
            `[GWD QA] ⚠ ID "${_stripQualifiers(m[1])}" found in generic <script> scan`,
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

    // ─── Color analysis ─────────────────────────────────────────────────────────

    function _colorVibrancy(rgb: string): number {
      const m = rgb.match(/\d+/g);
      if (!m || m.length < 3) return 0;

      const r = Number(m[0]) / 255;
      const g = Number(m[1]) / 255;
      const b = Number(m[2]) / 255;

      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const lightness = (max + min) / 2;

      if (lightness < 0.3 || lightness > 0.85) return 0;

      const saturation =
        max === min ? 0 : (max - min) / (1 - Math.abs(2 * lightness - 1));

      if (saturation < 0.35) return 0;

      const lightnessSweetSpot = 1 - Math.abs(lightness - 0.6);
      return saturation * lightnessSweetSpot;
    }

    function _adjustColorForDarkTheme(rgbStr: string): string {
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

      if (l < 0.55) l = 0.65;
      if (s > 0.05 && s < 0.6) s = 0.8;

      let r2: number, g2: number, b2: number;
      if (s === 0) {
        r2 = g2 = b2 = l;
      } else {
        const hue2rgb = (p: number, q: number, t: number) => {
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

    function sampleAccentColor(el: Element): string | null {
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
      const candidates: string[] = [];

      for (const id of GWD_IDS) {
        const node = el.querySelector(id);
        if (!node) continue;
        const style = getComputedStyle(node);
        for (const prop of ["backgroundColor", "color"] as const) {
          const c = style[prop];
          if (c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent") {
            candidates.push(c);
          }
        }
      }

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

      const bestColor = candidates.sort(
        (a, b) => _colorVibrancy(b) - _colorVibrancy(a),
      )[0];

      return _adjustColorForDarkTheme(bestColor);
    }

    // ─── Client detection ─────────────────────────────────────────────────────

    type Client = "walmart" | "capitalOne";

    function detectClient(el: Element): Client {
      const advertiser = el
        .querySelector("gwd-gpa-data-provider")
        ?.getAttribute("advertiser-name")
        ?.toLowerCase();
      if (advertiser && advertiser.includes("walmart")) return "walmart";
      return "capitalOne";
    }

    // ─── Walmart guide stem mapping ──────────────────────────────────────────

    const WALMART_GUIDE_STEMS: string[] = [
      "Digital Flyer",
    ];

    function getWalmartGuideStem(profileName: string): string | null {
      const lower = profileName.toLowerCase();
      for (const stem of WALMART_GUIDE_STEMS) {
        if (lower.startsWith(stem.toLowerCase())) return stem;
      }
      return null;
    }

    // ─── Capital One campaign format mapping ─────────────────────────────────

    const CAPONE_FORMATS: string[] = [
      "VentureX",
    ];

    function getCapOneFormat(profileName: string): string | null {
      const lower = profileName.toLowerCase();
      for (const fmt of CAPONE_FORMATS) {
        if (lower.includes(fmt.toLowerCase())) return fmt;
      }
      return null;
    }

    // ─── Reporting label extraction (raw, no ACQ/DCD filter) ─────────────────

    function extractReportingLabel(): string | null {
      const urlParams = new URLSearchParams(window.location.search);
      const urlLabel =
        urlParams.get("reporting_label") ||
        urlParams.get("reportingLabel") ||
        urlParams.get("rl");
      if (urlLabel) return urlLabel.trim();

      const htmlMatch = document.documentElement.innerHTML.match(
        /["']?(?:Reporting_Label|reportingLabel|reporting_label)["']?\s*:\s*["']?([^"'\\]+)["'\\]?/i,
      );
      if (htmlMatch) return htmlMatch[1].trim();

      return null;
    }

    // ─── Detection ──────────────────────────────────────────────────────────────

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
      const injectionPromises: Promise<void>[] = [];

      for (const [i, el] of gwdPages.entries()) {
        if (elementSelectorCache.has(el)) continue;
        elementSelectorCache.set(el, _selectorFor(el, i));

        const client = detectClient(el);
        const profileName =
          el
            .querySelector("gwd-gpa-data-provider")
            ?.getAttribute("profile-name") || null;
        const w = (el as HTMLElement).offsetWidth;
        const h = (el as HTMLElement).offsetHeight;
        const size = w > 0 && h > 0 ? `${w}x${h}` : null;

        let idNum: string | null = null;
        let originalIdNum: string | null = null;
        let label: string;
        let reportingLabel: string | null = null;

        if (client === "capitalOne") {
          // ── Capital One: ACQ/DCD ID extraction ──
          const rawIdNum = await extractCreativeId();
          idNum = rawIdNum;
          if (rawIdNum) {
            try {
              const res = await browser.runtime.sendMessage({
                action: "reserveCreativeId",
                idNum: rawIdNum,
              });
              idNum = res.effectiveIdNum;
              originalIdNum = res.originalIdNum;
              if (originalIdNum)
                console.log(
                  `[GWD QA] ⚠ Duplicate "${rawIdNum}" → using "${idNum}"`,
                );
            } catch (_) {}
          }
          label =
            idNum && size
              ? `${idNum}_${size}`
              : profileName || el.id || `gwd-page-${_creativeCounter}`;
        } else {
          // ── Walmart: reporting label / profile name ──
          reportingLabel = extractReportingLabel();
          const baseName = reportingLabel || profileName || el.id || `gwd-page-${_creativeCounter}`;
          label = size ? `${baseName}_${size}` : baseName;
          console.log(
            `[GWD QA] Walmart creative: label="${label}" profile="${profileName}"`,
          );
        }

        const existingGuide =
          el.querySelector("gwd-image[id^='guide']") ||
          el.querySelector("gwd-image[id^='GUIDE']") ||
          el.querySelector("img[id^='guide_']");

        const creative = {
          id: label,
          client,
          idNum,
          originalIdNum,
          profileName,
          reportingLabel,
          className: el.className,
          index: _creativeCounter++,
          type: "gwd-page",
          element: el,
          hasGuide: !!existingGuide,
          guides: existingGuide?.id ? [existingGuide.id] : [],
          guideSrcs: {} as Record<string, string>,
          accentColor: sampleAccentColor(el),
        };

        frameCreatives.push(creative);
        console.log(`[GWD QA] 🎬 "${label}" idNum=${idNum} size=${size}`);

        if (!creative.hasGuide)
          injectionPromises.push(injectGuideImage(creative));
      }

      await Promise.all(injectionPromises);
      await fillMissingVariants();
      return gwdPages.length;
    }

    // ─── Guide injection ────────────────────────────────────────────────────────

    async function injectGuideImage(creative: any) {
      const element = creative.element;
      const sizeMatch = creative.id?.match(/(\d+)x(\d+)/);
      const width = sizeMatch
        ? parseInt(sizeMatch[1], 10)
        : element.offsetWidth;
      const height = sizeMatch
        ? parseInt(sizeMatch[2], 10)
        : element.offsetHeight;
      const contentDiv = element.querySelector(
        "div.gwd-page-content.gwd-page-size",
      );

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

      if (creative.client === "walmart") {
        // ── Walmart guide injection ──
        const profileName = creative.profileName;
        if (!profileName) {
          console.log(`[GWD QA] Walmart: no profile name — skipping guide injection`);
          return;
        }
        const stem = getWalmartGuideStem(profileName);
        if (!stem) {
          console.log(
            `[GWD QA] Walmart: no known guide stem for "${profileName}" — skipping`,
          );
          return;
        }

        const stemSlug = stem.replace(/\s+/g, "_");
        const searchSuffixes = ["", ...VARIANT_SUFFIXES];
        let found = false;
        const available = new Map<string, string>();

        for (const suffix of searchSuffixes) {
          const elemId = `guide_${stemSlug}_${size}${suffix}`;
          const query = `${stem} guide ${size}${suffix}`;

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
              creative.guideSrcs[elemId] = url;
            }
          } catch (err: any) {
            console.error(`[GWD QA] Drive error (${query}):`, err.message);
          }
        }

        const hasBase = available.has("");
        const variantSuffixes = [...available.keys()].filter((k) => isVariantSuffix(k));

        let toInject: string[] = [];
        if (hasBase) {
          toInject.push("");
          toInject.push(...variantSuffixes);
        } else {
          toInject.push(...variantSuffixes);
        }

        for (const suffix of toInject) {
          const elemId = `guide_${stemSlug}_${size}${suffix}`;
          const url = available.get(suffix)!;

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
            console.log(`[GWD QA] ✓ Walmart injected: ${elemId} → "${creative.id}"`);

            if (isVariantSuffix(suffix)) {
              browser.runtime
                .sendMessage({
                  action: "shareVariantGuide",
                  size,
                  suffix,
                  guideId: elemId,
                  src: url,
                })
                .catch(() => {});
            }
          }
        }

        if (found) creative.hasGuide = true;
        else console.log(`[GWD QA] No Walmart guides found for "${creative.id}"`);
        return;
      }

      // ── Capital One guide injection (original flow) ──
      const idNum = creative.idNum || (await extractCreativeId());

      if (!idNum) {
        console.log(`[GWD QA] No ID — skipping guide injection`);
        return;
      }

      if (!creative.idNum) {
        creative.idNum = idNum;
        creative.id = `${idNum}_${size}`;
      }

      const queryBases = [`${idNum}_${size}`];
      if (creative.originalIdNum)
        queryBases.push(`${creative.originalIdNum}_${size}`);

      const searchSuffixes = ["", ...VARIANT_SUFFIXES];

      let found = false;

      for (const queryBase of queryBases) {
        if (found) break;
        if (queryBase !== queryBases[0])
          console.log(
            `[GWD QA] Falling back to original ID "${creative.originalIdNum}"`,
          );

        const available = new Map<string, string>();

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
              creative.guideSrcs[elemId] = url;
            }
          } catch (err: any) {
            console.error(`[GWD QA] Drive error (${query}):`, err.message);
          }
        }

        const hasBase = available.has("");
        const variantSuffixes = [...available.keys()].filter((k) => isVariantSuffix(k));

        let toInject: string[] = [];

        if (hasBase) {
          toInject.push("");
          toInject.push(...variantSuffixes);
        } else {
          toInject.push(...variantSuffixes);
        }

        for (const suffix of toInject) {
          const elemId = `guide_${queryBase}${suffix}`;
          const url = available.get(suffix)!;

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

            if (isVariantSuffix(suffix)) {
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

      // ── Fallback: advertiser-based search (e.g. CapOne_AnimationExpansion_VentureX_300x250_DCD305) ──
      if (!found) {
        const baseKeywords = ["CapOne", size, idNum];
        const format = creative.profileName ? getCapOneFormat(creative.profileName) : null;
        if (format) baseKeywords.push(format);
        console.log(
          `[GWD QA] Standard search failed, trying fallback: ${baseKeywords.join(" + ")}`,
        );

        for (const suffix of searchSuffixes) {
          const variantToken = suffix.replace(/^_/, "");
          const keywords = [...baseKeywords];
          if (variantToken) keywords.push(variantToken);
          const excludeVariants = !variantToken;
          const elemId = `guide_${idNum}_${size}${suffix}`;

          if (element.querySelector(`#${CSS.escape(elemId)}`)) {
            if (!creative.guides.includes(elemId)) creative.guides.push(elemId);
            found = true;
            continue;
          }
          try {
            const url = await browser.runtime.sendMessage({
              action: "getGuideByParts",
              keywords,
              excludeVariants,
            });
            if (url) {
              const img = document.createElement("img");
              img.id = elemId;
              img.src = url;
              img.style.cssText = `width:${width}px;height:${height}px;position:absolute;top:0;left:0;pointer-events:none;opacity:0;`;
              contentDiv.appendChild(img);
              if (!creative.guides.includes(elemId)) creative.guides.push(elemId);
              found = true;
              console.log(`[GWD QA] ✓ Fallback injected: ${elemId} → "${creative.id}"`);

              if (isVariantSuffix(suffix)) {
                browser.runtime
                  .sendMessage({
                    action: "shareVariantGuide",
                    size,
                    suffix,
                    guideId: elemId,
                    src: url,
                  })
                  .catch(() => {});
              }
            }
          } catch (err: any) {
            console.error(`[GWD QA] Fallback search error:`, err.message);
          }
        }
      }

      if (found) creative.hasGuide = true;
      else console.log(`[GWD QA] No guides found for "${creative.id}"`);
    }

    // ─── Cross-creative variant sharing ─────────────────────────────────────────

    async function fillMissingVariants() {
      let sharedVariants: any[] = [];
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

        const hasBaseGuide = creative.guides.some(
          (g: string) => !isVariantGuideId(g),
        );
        if (!hasBaseGuide) continue;

        const applicable = sharedVariants.filter((v: any) => v.size === size);
        for (const variant of applicable) {
          if (variant.suffix === "_f1") continue;

          const alreadyHasVariant = creative.guides.some((g: string) =>
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

    // ─── Guide state persistence ────────────────────────────────────────────────

    function saveGuideState(guideId: string, opacity: number) {
      localStorage.setItem(
        `gwd-qa:${location.href}:${guideId}`,
        String(opacity),
      );
    }

    function restoreGuideStates() {
      for (const creative of frameCreatives) {
        for (const guideId of creative.guides) {
          const stored = localStorage.getItem(
            `gwd-qa:${location.href}:${guideId}`,
          );
          if (!stored || stored === "0") continue;
          const el = creative.element.querySelector(`#${CSS.escape(guideId)}`);
          if (el) (el as HTMLElement).style.opacity = stored;
        }
      }
    }

    // ─── Highlight overlay ──────────────────────────────────────────────────────

    const HIGHLIGHT_CLASS = "gwd-qa-highlight";

    function getAccentRgbParts(colorStr: string | null): string {
      if (!colorStr) return "96, 165, 250";
      const m = colorStr.match(/\d+/g);
      if (m && m.length >= 3) return `${m[0]}, ${m[1]}, ${m[2]}`;
      return "96, 165, 250";
    }

    function applyHighlight(creative: any) {
      if (creative.element.querySelector(`.${HIGHLIGHT_CLASS}`)) return;
      if (getComputedStyle(creative.element).position === "static") {
        creative.element.style.position = "relative";
      }

      const rgbParts = getAccentRgbParts(creative.accentColor);
      const overlay = document.createElement("div");
      overlay.className = HIGHLIGHT_CLASS;

      overlay.style.cssText = `
        position:absolute;inset:0;pointer-events:none;z-index:9999;
        border:1px solid rgba(${rgbParts}, 0.9);border-radius:0px;
        box-shadow:0 0 20px rgba(${rgbParts}, 0.45);
        animation:gwd-qa-pulse 1s ease-in-out infinite;
        --qa-glow-dim: rgba(${rgbParts}, 0.1);
        --qa-border-dim: rgba(${rgbParts}, 0.4);
        --qa-glow-bright: rgba(${rgbParts}, 0.7);
        --qa-border-bright: rgba(${rgbParts}, 1);
      `;

      creative.element.appendChild(overlay);
    }

    function removeHighlight(creative: any) {
      creative.element.querySelector(`.${HIGHLIGHT_CLASS}`)?.remove();
    }

    // ─── Init ───────────────────────────────────────────────────────────────────

    async function init() {
      console.log("[GWD QA] Starting detection…");
      window.scrollTo(0, document.body.scrollHeight);
      await detectCreatives();
      restoreGuideStates();
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }

    // ─── Message listener ───────────────────────────────────────────────────────

    browser.runtime.onMessage.addListener(async (request: any) => {
      if (request.action === "receiveSharedVariant") {
        const { size, suffix, guideId, src } = request;
        for (const creative of frameCreatives) {
          const m = creative.id?.match(/(\d+)x(\d+)/);
          if (!m) continue;
          const cSize = `${m[1]}x${m[2]}`;
          if (cSize !== size) continue;

          const hasBaseGuide = creative.guides.some(
            (g: string) => !isVariantGuideId(g),
          );
          if (!hasBaseGuide) continue;
          if (suffix === "_f1") continue;

          const alreadyHasVariant = creative.guides.some((g: string) =>
            g.endsWith(suffix),
          );
          if (alreadyHasVariant) continue;
          if (creative.element.querySelector(`#${CSS.escape(guideId)}`))
            continue;

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

      if (request.action === "runDetection") {
        await init();
        return;
      }

      if (request.action === "getCreatives") {
        await detectCreatives();
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
          client: c.client,
          className: c.className,
          index: c.index,
          type: c.type,
          hasGuide: c.hasGuide,
          guides: c.guides,
          accentColor: c.accentColor,
          top: c.element.getBoundingClientRect().top,
          left: c.element.getBoundingClientRect().left,
        }));
      }

      if (request.action === "highlightCreatives") {
        for (const creative of frameCreatives) {
          if (request.localIndices?.includes(creative.index))
            applyHighlight(creative);
          else removeHighlight(creative);
        }
        return;
      }

      if (request.action === "setGuideOpacity") {
        document
          .querySelectorAll(`[id="${CSS.escape(request.guideId)}"]`)
          .forEach((guide) => {
            (guide as HTMLElement).style.opacity = request.opacity;
          });
        saveGuideState(request.guideId, request.opacity);
        return;
      }
    });
  },
});
