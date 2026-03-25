// Import polyfill if you are using a bundler,
// or ensure it's available in the global scope.
import "./lib/browser-polyfill.js";

console.log("[GWD QA] Service worker loaded");

// OAuth token management
let cachedToken = null;

async function getAuthToken() {
  // Check if we have a cached token
  if (cachedToken) {
    console.log("[GWD QA] Using cached auth token");
    return cachedToken;
  }

  // Try to get stored token
  const { authToken } = await browser.storage.local.get("authToken");
  if (authToken) {
    console.log("[GWD QA] Using stored auth token");
    cachedToken = authToken;
    return authToken;
  }

  // Request new token
  try {
    console.log("[GWD QA] Requesting new auth token (interactive)...");
    const response = await browser.identity.getAuthToken({ interactive: true });
    console.log("[GWD QA] Got auth token response:", response);

    // Extract token from response object
    const token = response?.token || response;
    console.log("[GWD QA] Token type:", typeof token);
    console.log("[GWD QA] Token value:", typeof token === 'string' ? token.substring(0, 20) + "..." : token);

    if (!token || typeof token !== 'string') {
      console.error("[GWD QA] Invalid token response - expected string, got:", typeof token);
      return null;
    }

    cachedToken = token;
    await browser.storage.local.set({ authToken: token });
    console.log("[GWD QA] Token saved and cached");
    return token;
  } catch (err) {
    console.error("[GWD QA] Failed to get auth token:", err.message || err);
    if (err.message && err.message.includes("function")) {
      console.error("[GWD QA] Possibly incorrect OAuth2 setup in manifest");
    }
    return null;
  }
}

async function searchGoogleDrive(searchQuery) {
  console.log("[GWD QA] searchGoogleDrive called with:", searchQuery);
  const token = await getAuthToken();
  if (!token) {
    console.error("[GWD QA] No auth token available - cannot search Google Drive");
    return null;
  }

  console.log("[GWD QA] Got auth token, querying Google Drive...");

  try {
    // Search for the file in both personal and shared drives
    const query = encodeURIComponent(
      `name contains "${searchQuery}" and trashed = false`
    );
    const url = `https://www.googleapis.com/drive/v3/files?q=${query}&includeTeamDriveItems=true&supportsTeamDrives=true&fields=files(id,name,webContentLink,driveId)&pageSize=1`;

    console.log("[GWD QA] Drive API request URL:", url.substring(0, 80) + "...");

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    console.log("[GWD QA] Drive API response status:", response.status);

    if (!response.ok) {
      const errorBody = await response.text();
      console.error("[GWD QA] Google Drive API error:", response.status, response.statusText);
      console.error("[GWD QA] Error body:", errorBody);

      if (response.status === 401) {
        // Token expired, clear cache and retry
        console.log("[GWD QA] Token expired (401), clearing cache and retrying...");
        cachedToken = null;
        await browser.storage.local.remove("authToken");
        return searchGoogleDrive(searchQuery);
      }
      return null;
    }

    const data = await response.json();
    console.log("[GWD QA] Drive API response:", data);

    if (data.files && data.files.length > 0) {
      const file = data.files[0];
      console.log(`[GWD QA] Found guide: ${file.name} (${file.id})`);
      // Fetch the file content with auth token
      const fileResponse = await fetch(
        `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (!fileResponse.ok) {
        console.error("[GWD QA] Failed to fetch file content:", fileResponse.status);
        return null;
      }

      const blob = await fileResponse.blob();

      // Convert blob to data URL since createObjectURL doesn't work in service workers
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result;
          console.log("[GWD QA] Created data URL for image");
          resolve(dataUrl);
        };
        reader.onerror = () => {
          console.error("[GWD QA] Failed to read blob");
          reject(reader.error);
        };
        reader.readAsDataURL(blob);
      });
    }

    console.log(`[GWD QA] No guide found for: ${searchQuery}`);
    return null;
  } catch (err) {
    console.error("[GWD QA] Error searching Google Drive:", err.message, err);
    return null;
  }
}

// Listen for requests from content scripts
browser.runtime.onMessage.addListener((request, sender) => {
  console.log("[GWD QA] onMessage received - action:", request.action);

  if (request.action === "getGuideURL") {
    console.log(
      `[GWD QA] searchGuideURL request for: ${request.searchQuery}`
    );
    // Return a promise that will resolve with the guide URL
    return searchGoogleDrive(request.searchQuery);
  }

  if (request.action === "clearAuth") {
    cachedToken = null;
    browser.storage.local.remove("authToken");
    console.log("[GWD QA] Auth cleared");
  }
});

// Auto-open popup on matching pages
const ALLOWED_URLS = [
  "https://doc-04-6k-adspreview.googleusercontent.com/preview/",
  "https://www.google.com/doubleclick/preview/dynamic/previewsheet/",
  "http://localhost:62585/",
  "http://localhost:56258/"
];

function isAllowedPage(url) {
  return ALLOWED_URLS.some(allowed => url.startsWith(allowed));
}

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url && isAllowedPage(tab.url)) {
    console.log("[GWD QA] Allowed page loaded, attempting to open popup");
    // Try to open the popup
    browser.action.openPopup().catch((err) => {
      console.log("[GWD QA] Could not auto-open popup:", err.message);
    });
  }
});
