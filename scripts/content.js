// Inject QA styles into the page
const styleLink = document.createElement("link");
styleLink.rel = "stylesheet";
styleLink.href = browser.runtime.getURL("scripts/styles-injector.css");
(document.head || document.documentElement).appendChild(styleLink);

const isMainFrame = window.self === window.top;
console.log(
  "[GWD QA] Content script loaded in",
  isMainFrame
    ? "MAIN FRAME"
    : `IFRAME (${window.location.href.substring(0, 60)}...)`,
);

// Store all found creatives
let frameCreatives = [];
const elementMap = new Map();
const seenElements = new WeakSet();

/**
 * Detect gwd-page elements with detailed logging
 */
function detectCreatives() {
  const gwdPages = document.querySelectorAll("gwd-page");
  console.log(`[GWD QA] querySelectorAll("gwd-page") returned ${gwdPages.length} elements`);

  gwdPages.forEach((el) => {
    // Skip if already tracked
    if (seenElements.has(el)) {
      return;
    }

    seenElements.add(el);

    // Get reporting label from the h5GeneratedCode script
    let reportingLabel = null;
    const h5Script = document.querySelector("#h5GeneratedCode");
    if (h5Script) {
      const scriptText = h5Script.textContent;
      // Look for: Reporting_Label = "VALUE"
      const match = scriptText.match(/Reporting_Label\s*=\s*["']([^"']+)["']/);
      if (match && match[1]) {
        reportingLabel = match[1];
      }
    }

    // Fallback to profile-name if no reporting label found
    if (!reportingLabel) {
      const gpaProvider = document.querySelector("gwd-gpa-data-provider");
      reportingLabel = gpaProvider?.getAttribute("profile-name");
    }

    // Fallback to id if still nothing
    if (!reportingLabel) {
      reportingLabel = el.id || `gwd-page-${frameCreatives.length}`;
    }

    // Check if this creative has any guide elements
    const guide = el.querySelector("gwd-image[id^='guide']");
    const hasGuide = !!guide;

    const creative = {
      id: reportingLabel,
      className: el.className,
      index: frameCreatives.length,
      type: "gwd-page",
      element: el,
      hasGuide: hasGuide,
    };

    frameCreatives.push(creative);
    elementMap.set(creative.index, creative);
    console.log(`[GWD QA] 🎬 Added creative: id="${reportingLabel}" (has guide: ${hasGuide})`);
  });

  return gwdPages.length;
}

// Initial detection
console.log("[GWD QA] Starting initial detection...");
const initialCount = detectCreatives();
console.log(`[GWD QA] Initial scan: ${initialCount} gwd-page element(s) found`);

// Detailed scan with timing
setTimeout(() => {
  console.log("[GWD QA] === 500ms check ===");
  console.log(`[GWD QA]   Body children: ${document.body?.children?.length || 0}`);
  console.log(`[GWD QA]   Total elements: ${document.querySelectorAll("*").length}`);
  const count = detectCreatives();
  console.log(`[GWD QA]   Found ${count} gwd-page elements`);
  restoreAllGuideStates();
}, 500);

setTimeout(() => {
  console.log("[GWD QA] === 1000ms check ===");
  const count = detectCreatives();
  console.log(`[GWD QA]   Found ${count} gwd-page elements`);
  restoreAllGuideStates();
}, 1000);

setTimeout(() => {
  console.log("[GWD QA] === 2000ms check ===");
  const count = detectCreatives();
  console.log(`[GWD QA]   Found ${count} gwd-page elements`);
  restoreAllGuideStates();
}, 2000);

setTimeout(() => {
  console.log("[GWD QA] === 3000ms check ===");
  const count = detectCreatives();
  console.log(`[GWD QA]   Found ${count} gwd-page elements`);
  restoreAllGuideStates();
}, 3000);

// Log total creatives found
console.log(`[GWD QA] Content script ready. Tracked ${frameCreatives.length} creatives.`);

/**
 * Save guide state to storage
 */
function saveGuideState(creativeIndex, enabled) {
  const frameUrl = window.location.href;
  const key = `gwd-qa-guide-${frameUrl}-${creativeIndex}`;
  localStorage.setItem(key, enabled ? "1" : "0");
}

/**
 * Restore guide state from storage
 */
function restoreGuideState(creativeIndex) {
  const frameUrl = window.location.href;
  const key = `gwd-qa-guide-${frameUrl}-${creativeIndex}`;
  const stored = localStorage.getItem(key);
  if (stored === "1") {
    const creative = elementMap.get(creativeIndex);
    if (creative && creative.element) {
      const guide = creative.element.querySelector("gwd-image[id^='guide']");
      if (guide) {
        guide.style.opacity = "0.5";
        console.log(`[GWD QA] Restored guide state for creative ${creativeIndex}`);
      }
    }
  }
}

/**
 * Restore all saved guide states
 */
function restoreAllGuideStates() {
  frameCreatives.forEach((creative, idx) => {
    restoreGuideState(idx);
  });
}

// Listen for messages from popup
browser.runtime.onMessage.addListener((request, sender) => {
  console.log(`[GWD QA] Message received: ${request.action}`);

  if (request.action === "getCreatives") {
    console.log(`[GWD QA] getCreatives query - currently have ${frameCreatives.length} creatives`);

    // Quick re-scan in case new ones loaded
    detectCreatives();

    const creativesInfo = frameCreatives.map((c) => ({
      id: c.id,
      className: c.className,
      index: c.index,
      type: c.type,
      hasGuide: c.hasGuide,
    }));
    console.log(`[GWD QA] Returning ${creativesInfo.length} creatives to popup`);
    return Promise.resolve(creativesInfo);
  }

  if (request.action === "highlightCreatives") {
    console.log(
      `[GWD QA] Highlighting ${request.selectedIndices.length} creatives`,
    );

    // Clear all previous highlights from iframes
    document.querySelectorAll("iframe[id^='safe-frame-']").forEach((iframe) => {
      iframe.classList.remove("qa-creative-selected");
      iframe.style.outline = "none";
      iframe.style.outlineOffset = "0";
      iframe.style.boxShadow = "none";
    });

    // Add highlight to selected creatives
    request.selectedIndices.forEach((idx) => {
      // Try to find the corresponding iframe
      // The safe-frame iframe usually contains the gwd-page
      const safedFrames = document.querySelectorAll("iframe[id^='safe-frame-']");
      if (safedFrames.length > idx) {
        const iframe = safedFrames[idx];
        iframe.classList.add("qa-creative-selected");
        // Apply inline styles directly
        iframe.style.outline = "4px solid #007aff";
        iframe.style.outlineOffset = "2px";
        iframe.style.boxShadow = "0 0 12px rgba(0, 122, 255, 0.6)";
        console.log(`[GWD QA]   ✓ Highlighted iframe at index ${idx}`);
      }
    });
  }

  if (request.action === "toggleGuide") {
    console.log(`[GWD QA] Toggle guide: ${request.enabled ? "ON" : "OFF"}`);
    request.selectedIndices.forEach((idx) => {
      const creative = elementMap.get(idx);
      if (creative && creative.element) {
        const guide = creative.element.querySelector("gwd-image[id^='guide']");
        if (guide) {
          guide.style.opacity = request.enabled ? "0.5" : "0";
          // Save guide state to storage
          saveGuideState(idx, request.enabled);
          console.log(
            `[GWD QA]   ✓ Guide opacity: ${request.enabled ? "0.5" : "0"}`,
          );
        } else {
          console.log(`[GWD QA]   ✗ Guide not found in creative ${idx}`);
        }
      }
    });
  }
});
