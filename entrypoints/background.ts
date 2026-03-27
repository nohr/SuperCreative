export default defineBackground({
  type: "module",

  main() {
    console.log("[GWD QA] Service worker ready");

    // ─── Allowed pages ──────────────────────────────────────────────────────────

    const ALLOWED_HOSTS = [
      "adspreview.googleusercontent.com",
      "www.google.com/doubleclick/preview",
      "localhost",
    ];

    function isAllowedPage(url: string) {
      return ALLOWED_HOSTS.some((h) => url.includes(h));
    }

    // ─── Auth + Drive ─────────────────────────────────────────────────────────────

    let _cachedToken: string | null = null;
    let _authPromise: Promise<string | null> | null = null;

    async function getAuthToken(): Promise<string | null> {
      if (_cachedToken) return _cachedToken;
      if (_authPromise) return _authPromise;

      _authPromise = (async () => {
        const result = await browser.storage.local.get("authToken");
        const authToken = result.authToken as string | undefined;
        if (authToken) {
          _cachedToken = authToken;
          _authPromise = null;
          return authToken;
        }

        try {
          const response = await (browser.identity as any).getAuthToken({
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
          _authPromise = null;
          return token;
        } catch (err: any) {
          console.error("[GWD QA] Auth error:", err.message || err);
          _authPromise = null;
          return null;
        }
      })();

      return _authPromise;
    }

    async function searchGoogleDrive(query: string): Promise<string | null> {
      const token = await getAuthToken();
      if (!token) return null;

      try {
        const parts = query.split(/[-_ ]+/);

        let qString = `name contains 'guide' and mimeType != 'application/vnd.google-apps.folder' and trashed = false`;
        let isVariant = false;

        for (const part of parts) {
          if (!part) continue;
          qString += ` and name contains '${part}'`;
          if (/^f\d+$/i.test(part)) {
            isVariant = true;
          }
        }

        if (!isVariant) {
          qString += ` and not name contains 'f1' and not name contains 'f2'`;
        }

        return await fetchDriveFile(token, qString);
      } catch (err: any) {
        console.error("[GWD QA] Drive error:", err.message);
        return null;
      }
    }

    // Flexible search: caller provides explicit keyword list, no hardcoded "guide" requirement
    async function searchDriveByParts(
      keywords: string[],
      excludeVariants: boolean,
    ): Promise<string | null> {
      const token = await getAuthToken();
      if (!token) return null;

      try {
        let qString = `mimeType != 'application/vnd.google-apps.folder' and trashed = false`;
        for (const kw of keywords) {
          if (!kw) continue;
          qString += ` and name contains '${kw}'`;
        }
        if (excludeVariants) {
          qString += ` and not name contains 'f1' and not name contains 'f2'`;
        }
        return await fetchDriveFile(token, qString);
      } catch (err: any) {
        console.error("[GWD QA] Drive error:", err.message);
        return null;
      }
    }

    async function fetchDriveFile(
      token: string,
      qString: string,
    ): Promise<string | null> {
      const q = encodeURIComponent(qString);
      const url = `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=modifiedTime desc&includeItemsFromAllDrives=true&supportsAllDrives=true&fields=files(id,name)&pageSize=1`;

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.status === 401) {
        _cachedToken = null;
        await browser.storage.local.remove("authToken");
        // Retry once after clearing stale token
        const newToken = await getAuthToken();
        if (!newToken) return null;
        const retryRes = await fetch(url, {
          headers: { Authorization: `Bearer ${newToken}` },
        });
        if (!retryRes.ok) return null;
        const retryData = await retryRes.json();
        if (!retryData.files?.length) return null;
        return await downloadFileAsDataUrl(newToken, retryData.files[0].id);
      }
      if (!res.ok) {
        console.error(`[GWD QA] Drive API ${res.status}:`, await res.text());
        return null;
      }

      const { files } = await res.json();
      if (!files?.length) return null;
      return await downloadFileAsDataUrl(token, files[0].id);
    }

    async function downloadFileAsDataUrl(
      token: string,
      fileId: string,
    ): Promise<string | null> {
      const fileRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!fileRes.ok) return null;

      const blob = await fileRes.blob();
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    }

    // ─── Per-tab state registries ─────────────────────────────────────────────

    const tabCreativeCounts = new Map<number, Map<string, number>>();
    const tabSharedGuides = new Map<number, any[]>();

    // ─── Message handler ──────────────────────────────────────────────────────────

    browser.runtime.onMessage.addListener((request: any, sender: any) => {
      if (request.action === "shareVariantGuide") {
        const tabId = sender.tab?.id;
        if (!tabId) return Promise.resolve(false);

        if (!tabSharedGuides.has(tabId)) tabSharedGuides.set(tabId, []);
        const cache = tabSharedGuides.get(tabId)!;

        const exists = cache.find((g: any) => g.guideId === request.guideId);
        if (!exists) {
          cache.push(request);
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
        return Promise.resolve(tabSharedGuides.get(tabId!) || []);
      }

      if (request.action === "reserveCreativeId") {
        const tabId = sender.tab?.id;
        const { idNum } = request;
        if (!tabCreativeCounts.has(tabId!))
          tabCreativeCounts.set(tabId!, new Map());
        const counts = tabCreativeCounts.get(tabId!)!;
        const count = counts.get(idNum) || 0;
        counts.set(idNum, count + 1);

        let effectiveIdNum = idNum,
          originalIdNum: string | null = null;
        if (count > 0) {
          const m = idNum.match(/^([A-Za-z]+)(\d+)$/);
          if (m) {
            effectiveIdNum =
              `${m[1]}${parseInt(m[2], 10) + count}`.toUpperCase();
            originalIdNum = idNum;
          }
        }
        return Promise.resolve({ effectiveIdNum, originalIdNum });
      }

      if (request.action === "getGuideURL") {
        return searchGoogleDrive(request.searchQuery);
      }

      if (request.action === "getGuideByParts") {
        return searchDriveByParts(
          request.keywords,
          request.excludeVariants ?? true,
        );
      }

      if (request.action === "clearAuth") {
        _cachedToken = null;
        browser.storage.local.remove("authToken");
        console.log("[GWD QA] Auth cleared");
        return;
      }
    });

    // ─── Tab lifecycle ────────────────────────────────────────────────────────────

    browser.tabs.onRemoved.addListener(async (tabId: number) => {
      tabCreativeCounts.delete(tabId);
      tabSharedGuides.delete(tabId);
      await browser.storage.local.remove(`tab-${tabId}`);
    });

    browser.webNavigation.onBeforeNavigate.addListener(
      ({ tabId, frameId }: { tabId: number; frameId: number }) => {
        if (frameId === 0) {
          tabCreativeCounts.delete(tabId);
          tabSharedGuides.delete(tabId);
        }
      },
    );

    // Trigger detection in every frame as it finishes loading
    browser.webNavigation.onCompleted.addListener(
      ({
        tabId,
        frameId,
        url,
      }: {
        tabId: number;
        frameId: number;
        url: string;
      }) => {
        if (!isAllowedPage(url)) return;
        browser.tabs
          .sendMessage(tabId, { action: "runDetection" }, { frameId })
          .catch(() => {});
      },
    );

    // Auto-open popup when landing on an allowed page
    browser.tabs.onUpdated.addListener(
      (tabId: number, changeInfo: any, tab: any) => {
        if (
          changeInfo.status === "complete" &&
          tab.url &&
          isAllowedPage(tab.url)
        ) {
          browser.action.openPopup().catch(() => {});
        }
      },
    );
  },
});
