import { useEffect, useState, useCallback, useRef } from "react";

interface Creative {
  id: string;
  className: string;
  index: number;
  type: string;
  hasGuide: boolean;
  guides: string[];
  accentColor: string | null;
  globalIndex: number;
  frameId: number;
  top: number;
  left: number;
}

interface Status {
  type: "loading" | "error" | "warning" | "success";
  message: string;
}

function rgbToGlow(rgb: string): string {
  const m = rgb.match(/\d+/g);
  return m ? `rgba(${m[0]}, ${m[1]}, ${m[2]}, 0.18)` : "rgba(96,165,250,0.18)";
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export default function App() {
  const [creatives, setCreatives] = useState<Creative[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<Status | null>({
    type: "loading",
    message: "Scanning for creatives",
  });
  const [isWindow, setIsWindow] = useState(false);
  const tabIdRef = useRef<number | null>(null);
  const version = browser.runtime.getManifest().version;

  // Detect if we're running as a standalone window (vs popup)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const windowed = params.has("window");
    setIsWindow(windowed);
    if (windowed) document.body.classList.add("is-window");
  }, []);

  // Load creatives from all frames (does NOT touch loading state — caller handles it)
  const loadCreatives = useCallback(async (tabId: number) => {
    try {
      const frames = await browser.webNavigation.getAllFrames({ tabId });
      const allCreatives: Creative[] = [];

      const frameList = [
        { frameId: 0 },
        ...(frames || []).filter((f) => f.frameId !== 0),
      ];

      for (const frame of frameList) {
        let result: any = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            result = await browser.tabs.sendMessage(
              tabId,
              { action: "getCreatives" },
              { frameId: frame.frameId },
            );
            break;
          } catch (_) {
            if (attempt < 2) await sleep(300);
          }
        }
        if (!result?.length) continue;

        for (const creative of result) {
          allCreatives.push({
            ...creative,
            globalIndex: 0,
            frameId: frame.frameId,
          });
        }
      }

      // Sort by visual position on page (top → left), then assign globalIndex
      allCreatives.sort((a, b) => (a.top ?? 0) - (b.top ?? 0) || (a.left ?? 0) - (b.left ?? 0));
      allCreatives.forEach((c, i) => (c.globalIndex = i));

      setCreatives(allCreatives);

      // Save to storage for guide slider lookups
      await browser.storage.local.set({
        [`tab-${tabId}`]: { creatives: allCreatives },
      });

      return allCreatives;
    } catch (err: any) {
      console.error("[GWD QA] loadCreatives error:", err);
      setStatus({ type: "error", message: "Detection failed" });
      setLoading(false);
      return [];
    }
  }, []);

  // Init: get active tab and poll for creatives until found
  useEffect(() => {
    let cancelled = false;

    (async () => {
      // In window mode, use the tabId passed via query param
      const params = new URLSearchParams(window.location.search);
      const paramTabId = params.get("tabId");

      let tabId: number;
      if (paramTabId) {
        tabId = parseInt(paramTabId, 10);
      } else {
        const [tab] = await browser.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (!tab?.id) return;
        tabId = tab.id;
      }
      tabIdRef.current = tabId;

      // Poll up to 10 times (every 800ms = ~8 seconds) waiting for content scripts
      let loaded: Creative[] = [];
      for (let attempt = 0; attempt < 10; attempt++) {
        if (cancelled) return;
        loaded = await loadCreatives(tabId);
        if (loaded.length > 0) break;
        if (attempt < 9) await sleep(800);
      }

      if (cancelled) return;
      setLoading(false);

      if (loaded.length === 0) {
        setStatus(null);
      }

      // Restore previously saved selections
      const data = (await browser.storage.local.get(`tab-${tabId}`))[
        `tab-${tabId}`
      ] as { selections?: number[] } | undefined;
      if (data?.selections?.length && loaded.length) {
        const restoredSet = new Set<number>(
          data.selections.filter((gi: number) =>
            loaded.some((c) => c.globalIndex === gi),
          ),
        );
        setSelected(restoredSet);
      }

      // Keep re-fetching to pick up guides as they get injected (async Drive lookups)
      if (loaded.length > 0) {
        setStatus({ type: "loading", message: "Fetching guide images" });
        let prevGuideKey = JSON.stringify(loaded.map((c) => c.guides));
        let stableCount = 0;
        for (let i = 0; i < 15; i++) {
          if (cancelled) return;
          await sleep(2000);
          if (cancelled) return;
          const fresh = await loadCreatives(tabId);
          const guideKey = JSON.stringify(fresh.map((c) => c.guides));
          if (guideKey === prevGuideKey) {
            stableCount++;
            if (stableCount >= 2) break;
          } else {
            stableCount = 0;
            prevGuideKey = guideKey;
          }
        }

        if (cancelled) return;

        // Determine final status based on guide results
        const finalCreatives = await loadCreatives(tabId);
        const withGuides = finalCreatives.filter((c) => c.hasGuide);
        const withoutGuides = finalCreatives.filter((c) => !c.hasGuide);

        if (finalCreatives.length > 0 && withGuides.length === 0) {
          setStatus({ type: "warning", message: "No guides found" });
        } else if (withoutGuides.length > 0 && withGuides.length > 0) {
          setStatus({ type: "warning", message: "Some guides missing" });
        } else if (finalCreatives.length > 0 && withoutGuides.length === 0) {
          setStatus({ type: "success", message: "All guides found" });
        } else {
          setStatus(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadCreatives]);

  // Sync highlights + accent color + save selections whenever selection changes
  useEffect(() => {
    const tabId = tabIdRef.current;
    if (tabId === null || creatives.length === 0) return;

    const selectedArr = Array.from(selected);

    // Save selections
    (async () => {
      const existing =
        (await browser.storage.local.get(`tab-${tabId}`))[`tab-${tabId}`] || {};
      await browser.storage.local.set({
        [`tab-${tabId}`]: { ...existing, selections: selectedArr },
      });
    })();

    // Build per-frame selection maps
    const allFrameIds = new Set(creatives.map((c) => c.frameId));
    const selectionsByFrame: Record<number, number[]> = {};
    for (const gi of selected) {
      const c = creatives.find((cr) => cr.globalIndex === gi);
      if (!c) continue;
      if (!selectionsByFrame[c.frameId]) selectionsByFrame[c.frameId] = [];
      selectionsByFrame[c.frameId].push(c.index);
    }

    // Send highlight messages to all frames
    for (const frameId of allFrameIds) {
      browser.tabs
        .sendMessage(
          tabId,
          {
            action: "highlightCreatives",
            localIndices: selectionsByFrame[frameId] || [],
          },
          { frameId },
        )
        .catch(() => {});
    }

    // Apply accent color from selected creatives (highlight-sync only)
    const accentCreative = creatives.find(
      (c) => selected.has(c.globalIndex) && c.accentColor,
    );
    if (accentCreative?.accentColor) {
      document.documentElement.style.setProperty(
        "--accent",
        accentCreative.accentColor,
      );
      document.documentElement.style.setProperty(
        "--accent-glow",
        rgbToGlow(accentCreative.accentColor),
      );
    }
  }, [selected, creatives]);

  // Apply accent color as soon as any creative with a color is detected
  useEffect(() => {
    if (creatives.length === 0) return;
    const first = creatives.find((c) => c.accentColor);
    if (!first?.accentColor) return;
    document.documentElement.style.setProperty("--accent", first.accentColor);
    document.documentElement.style.setProperty(
      "--accent-glow",
      rgbToGlow(first.accentColor),
    );
  }, [creatives]);

  const toggleCreative = (globalIndex: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(globalIndex)) next.delete(globalIndex);
      else next.add(globalIndex);
      return next;
    });
  };

  const selectAll = () => {
    setSelected((prev) => {
      const allSelected = creatives.every((c) => prev.has(c.globalIndex));
      if (allSelected) return new Set();
      return new Set(creatives.map((c) => c.globalIndex));
    });
  };

  // Collect unique guide IDs from selected creatives
  const selectedGuides: string[] = [];
  const seen = new Set<string>();
  for (const c of creatives) {
    if (!selected.has(c.globalIndex)) continue;
    for (const g of c.guides || []) {
      if (!seen.has(g)) {
        seen.add(g);
        selectedGuides.push(g);
      }
    }
  }

  const handleSliderChange = (guideId: string, sliderValue: number) => {
    const tabId = tabIdRef.current;
    if (tabId === null) return;
    const opacity = { 0: 0, 1: 0.5, 2: 1 }[sliderValue] ?? 0;
    const frameIds = new Set(
      creatives
        .filter((c) => selected.has(c.globalIndex))
        .map((c) => c.frameId),
    );
    for (const frameId of frameIds) {
      browser.tabs
        .sendMessage(
          tabId,
          { action: "setGuideOpacity", guideId, opacity },
          { frameId },
        )
        .catch(() => {});
    }
  };

  const togglePopout = async () => {
    if (isWindow) {
      window.close();
    } else {
      const tabId = tabIdRef.current;
      const popupUrl = browser.runtime.getURL(
        `/popup.html?window=1&tabId=${tabId}`,
      );
      await browser.windows.create({
        url: popupUrl,
        type: "popup",
        width: 330,
        height: 400,
      });
      window.close();
    }
  };

  return (
    <>
      <header className="header">
        <span className="logo">SuperCreative</span>
        <div className="header-right">
          {status && (
            <div className={`status-indicator status-${status.type}`}>
              {status.type === "loading" && <span className="status-spinner" />}
              {status.type === "error" && (
                <svg className="status-icon" width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <circle cx="5" cy="5" r="4.5" fill="currentColor"/>
                  <path d="M5 3v2.5" stroke="var(--bg)" strokeWidth="1.3" strokeLinecap="round"/>
                  <circle cx="5" cy="7" r="0.6" fill="var(--bg)"/>
                </svg>
              )}
              {status.type === "warning" && (
                <svg className="status-icon" width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path d="M5 1L9.33 8.5H0.67L5 1Z" fill="currentColor"/>
                  <path d="M5 4v2" stroke="var(--bg)" strokeWidth="1" strokeLinecap="round"/>
                  <circle cx="5" cy="7.2" r="0.5" fill="var(--bg)"/>
                </svg>
              )}
              {status.type === "success" && (
                <svg className="status-icon" width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <circle cx="5" cy="5" r="4.5" fill="currentColor"/>
                  <path d="M3 5.2L4.5 6.7L7 3.5" stroke="var(--bg)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
              <span className="status-text">{status.message}</span>
            </div>
          )}
          <span className="version-badge">v{version}</span>
          <button
            className="btn-popout"
            onClick={togglePopout}
            title={isWindow ? "Back to popup" : "Open in window"}
          >
            {isWindow ? (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <rect x="1.5" y="1.5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
                <path d="M4.5 1.5v9" stroke="currentColor" strokeWidth="1.3"/>
                <path d="M1.5 4.5h3" stroke="currentColor" strokeWidth="1.3"/>
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M9.5 7v2.5a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1H5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M7 1.5h3.5V5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M10.5 1.5 5.5 6.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              </svg>
            )}
          </button>
        </div>
      </header>

      <div className="section">
        <div className="section-header">
          <span className="section-label">Creatives</span>
          {creatives.length > 1 && (
            <button className="btn-ghost" onClick={selectAll}>
              Select all
            </button>
          )}
        </div>
        <div className="list-panel">
          {loading ? (
            <span className="placeholder">Scanning for creatives…</span>
          ) : status?.type === "error" && creatives.length === 0 ? (
            <span className="placeholder">{status.message}</span>
          ) : creatives.length === 0 ? (
            <span className="placeholder">No creatives found</span>
          ) : (
            creatives.map((c) => {
              const checked = selected.has(c.globalIndex);
              return (
                <label
                  key={c.globalIndex}
                  className={`creative-item${checked ? " is-checked" : ""}`}
                >
                  <input
                    type="checkbox"
                    className="creative-checkbox"
                    checked={checked}
                    onChange={() => toggleCreative(c.globalIndex)}
                  />
                  <span className="creative-label" title={c.id}>
                    {c.id}
                  </span>
                  {c.hasGuide && <span className="guide-dot" />}
                </label>
              );
            })
          )}
        </div>
      </div>

      {selectedGuides.length > 0 && (
        <div className="section">
          <div className="section-divider" />
          <div className="section-header">
            <span className="section-label">Guides</span>
          </div>
          <div className="guide-sliders">
            {selectedGuides.map((guideId) => {
              const label = guideId.replace(/^guide_/, "");
              return (
                <div key={guideId} className="guide-slider-item">
                  <span className="guide-slider-name" title={label}>
                    {label}
                  </span>
                  <input
                    type="range"
                    className="guide-slider"
                    min={0}
                    max={2}
                    step={1}
                    defaultValue={0}
                    onChange={(e) =>
                      handleSliderChange(guideId, parseInt(e.target.value))
                    }
                  />
                  <div className="guide-tick-labels">
                    <span>Hidden</span>
                    <span>50%</span>
                    <span>Visible</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
