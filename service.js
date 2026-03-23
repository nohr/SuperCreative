// Import polyfill if you are using a bundler,
// or ensure it's available in the global scope.
import "./lib/browser-polyfill.js";

console.log("[GWD QA] Service worker loaded");

// Auto-open popup on matching pages
const ALLOWED_URLS = [
  "https://doc-04-6k-adspreview.googleusercontent.com/preview/",
  "https://www.google.com/doubleclick/preview/dynamic/previewsheet/",
  "http://localhost:62585/"
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

