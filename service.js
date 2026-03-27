import "./lib/browser-polyfill.js";

console.log("[GWD QA] Service worker ready");

// ─── Allowed pages ────────────────────────────────────────────────────────────

const ALLOWED_HOSTS = [
  "adspreview.googleusercontent.com",
  "www.google.com/doubleclick/preview",
  "localhost:62585",
  "localhost:56258",
];

function isAllowedPage(url) {
  return ALLOWED_HOSTS.some((h) => url.includes(h));
}

// ─── Auth + Drive ─────────────────────────────────────────────────────────────

// NOTE: browser.identity.getAuthToken is Chrome-specific.
// For Firefox/Safari ports, replace with browser.identity.launchWebAuthFlow.

let _cachedToken = null;
let _authPromise = null; // NEW: Acts as a lock to prevent concurrent auth spam

async function getAuthToken() {
  if (_cachedToken) return _cachedToken;

  // If another creative is already fetching the token, wait for its result!
  if (_authPromise) return _authPromise;

  _authPromise = (async () => {
    const { authToken } = await browser.storage.local.get("authToken");
    if (authToken) {
      _cachedToken = authToken;
      _authPromise = null; // Release lock
      return authToken;
    }

    try {
      const response = await browser.identity.getAuthToken({
        interactive: true,
      });
      const token = response?.token ?? response;
      if (!token || typeof token !== "string") {
        console.error("[GWD QA] Invalid token response:", typeof token);
        _authPromise = null;
        return null;
      }
      _cachedToken = token;
      await browser.storage.local.set({ authToken: token });
      _authPromise = null; // Release lock
      return token;
    } catch (err) {
      console.error("[GWD QA] Auth error:", err.message || err);
      _authPromise = null; // Release lock
      return null;
    }
  })();

  return _authPromise;
}

async function searchGoogleDrive(query) {
  const token = await getAuthToken();
  if (!token) return null;

  try {
    // Split ONLY by underscores, hyphens, or spaces.
    // DO NOT split by 'x', so "160x600" stays as a single searchable word.
    // Example: "DCD539_160x600_f2" -> ["DCD539", "160x600", "f2"]
    const parts = query.split(/[-_ ]+/);

    // 1. MUST use single quotes for Google Drive API strings
    // 2. MUST exclude folders, or it might accidentally download a folder named "Guides"
    let qString = `name contains 'guide' and mimeType != 'application/vnd.google-apps.folder' and trashed = false`;
    let isVariant = false;

    // Add each piece of the query
    for (const part of parts) {
      if (!part) continue;
      qString += ` and name contains '${part}'`;
      if (part.toLowerCase() === "f1" || part.toLowerCase() === "f2") {
        isVariant = true;
      }
    }

    // Exclude variants when searching for the base guide
    if (!isVariant) {
      qString += ` and not name contains 'f1' and not name contains 'f2'`;
    }

    const q = encodeURIComponent(qString);

    // 3. Updated API parameters: 'supportsTeamDrives' is deprecated, use 'supportsAllDrives'
    // 4. Added 'orderBy=modifiedTime desc' to guarantee we grab the most recent version
    const url = `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=modifiedTime desc&includeItemsFromAllDrives=true&supportsAllDrives=true&fields=files(id,name)&pageSize=1`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 401) {
      // Token expired — clear and retry once
      _cachedToken = null;
      await browser.storage.local.remove("authToken");
      return searchGoogleDrive(query);
    }
    if (!res.ok) {
      console.error(`[GWD QA] Drive API ${res.status}:`, await res.text());
      return null;
    }

    const { files } = await res.json();
    if (!files?.length) return null;

    const fileRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${files[0].id}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!fileRes.ok) return null;

    const blob = await fileRes.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch (err) {
    console.error("[GWD QA] Drive error:", err.message);
    return null;
  }
}

// ─── Per-tab state registries ─────────────────────────────────────────────
// tabCreativeCounts: Map<tabId, Map<rawIdNum, count>> — guarantees unique IDs
// tabSharedGuides: Map<tabId, Array> — caches found _f1/_f2 variants to share across iframes

const tabCreativeCounts = new Map();
const tabSharedGuides = new Map();

// ─── Message handler ──────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((request, sender) => {
  if (request.action === "shareVariantGuide") {
    const tabId = sender.tab?.id;
    if (!tabId) return Promise.resolve(false);

    if (!tabSharedGuides.has(tabId)) tabSharedGuides.set(tabId, []);
    const cache = tabSharedGuides.get(tabId);

    // Prevent duplicate broadcasts
    const exists = cache.find((g) => g.guideId === request.guideId);
    if (!exists) {
      cache.push(request);
      // Broadcast to all frames in the tab simultaneously
      browser.tabs
        .sendMessage(tabId, {
          action: "receiveSharedVariant",
          ...request,
        })
        .catch(() => {});
    }
    return Promise.resolve(true);
  }

  if (request.action === "requestSharedVariants") {
    const tabId = sender.tab?.id;
    return Promise.resolve(tabSharedGuides.get(tabId) || []);
  }

  if (request.action === "reserveCreativeId") {
    const tabId = sender.tab?.id;
    const { idNum } = request;
    if (!tabCreativeCounts.has(tabId)) tabCreativeCounts.set(tabId, new Map());
    const counts = tabCreativeCounts.get(tabId);
    const count = counts.get(idNum) || 0;
    counts.set(idNum, count + 1);

    let effectiveIdNum = idNum,
      originalIdNum = null;
    if (count > 0) {
      const m = idNum.match(/^([A-Za-z]+)(\d+)$/);
      if (m) {
        effectiveIdNum = `${m[1]}${parseInt(m[2], 10) + count}`.toUpperCase();
        originalIdNum = idNum;
      }
    }
    return Promise.resolve({ effectiveIdNum, originalIdNum });
  }

  if (request.action === "getGuideURL") {
    return searchGoogleDrive(request.searchQuery);
  }

  if (request.action === "clearAuth") {
    _cachedToken = null;
    browser.storage.local.remove("authToken");
    console.log("[GWD QA] Auth cleared");
    return;
  }
});

// ─── Tab lifecycle ────────────────────────────────────────────────────────────

browser.tabs.onRemoved.addListener(async (tabId) => {
  tabCreativeCounts.delete(tabId);
  tabSharedGuides.delete(tabId);
  await browser.storage.local.remove(`tab-${tabId}`);
});

browser.webNavigation.onBeforeNavigate.addListener(({ tabId, frameId }) => {
  if (frameId === 0) {
    tabCreativeCounts.delete(tabId);
    tabSharedGuides.delete(tabId);
  }
});

// Reset ID counters on main-frame navigation (page refresh / new URL)
browser.webNavigation.onBeforeNavigate.addListener(({ tabId, frameId }) => {
  if (frameId === 0) tabCreativeCounts.delete(tabId);
});

// Trigger detection in every frame as it finishes loading
browser.webNavigation.onCompleted.addListener(({ tabId, frameId, url }) => {
  if (!isAllowedPage(url)) return;
  browser.tabs
    .sendMessage(tabId, { action: "runDetection" }, { frameId })
    .catch(() => {});
});

// Auto-open popup when landing on an allowed page
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url && isAllowedPage(tab.url)) {
    browser.action.openPopup().catch(() => {});
  }
});
