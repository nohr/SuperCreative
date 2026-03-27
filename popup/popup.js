document.addEventListener("DOMContentLoaded", async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });

  // Version badge
  const manifest = browser.runtime.getManifest();
  document.getElementById("version").textContent = `v${manifest.version}`;

  await loadCreatives(tab.id);
  await restoreSelections(tab.id);

  document.getElementById("select-all-btn").addEventListener("click", () => {
    const cbs      = [...document.querySelectorAll(".creative-checkbox")];
    const allOn    = cbs.every((cb) => cb.checked);
    cbs.forEach((cb) => (cb.checked = !allOn));
    syncCheckedStyles();
    updateSelection(tab.id);
  });
});

// ─── Load ─────────────────────────────────────────────────────────────────────

async function loadCreatives(tabId) {
  const list = document.getElementById("creatives-list");

  try {
    const frames = await browser.webNavigation.getAllFrames({ tabId });
    const allCreatives = [];
    let globalIndex = 0;

    // Main frame first, then child frames
    for (const frame of [{ frameId: 0 }, ...frames.filter((f) => f.frameId !== 0)]) {
      let result = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          result = await browser.tabs.sendMessage(
            tabId,
            { action: "getCreatives" },
            { frameId: frame.frameId }
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
          globalIndex: globalIndex++, // popup-assigned global index
          frameId: frame.frameId,     // creative.index is the local (frame-level) index
        });
      }
    }

    list.innerHTML = "";

    if (!allCreatives.length) {
      list.innerHTML = '<span class="placeholder">No creatives found</span>';
      document.getElementById("select-all-btn").style.display = "none";
      return;
    }

    const selectAllBtn = document.getElementById("select-all-btn");
    selectAllBtn.style.display = allCreatives.length > 1 ? "block" : "none";

    for (const creative of allCreatives) {
      const label = document.createElement("label");
      label.className = "creative-item";
      label.innerHTML = `
        <input type="checkbox" class="creative-checkbox"
          data-global-index="${creative.globalIndex}"
          data-local-index="${creative.index}"
          data-frame-id="${creative.frameId}"
          data-has-guide="${creative.hasGuide}"
          data-accent="${creative.accentColor || ""}">
        <span class="creative-label" title="${creative.id}">${creative.id}</span>
        ${creative.hasGuide ? '<span class="guide-dot"></span>' : ""}
      `;
      list.appendChild(label);
    }

    document.querySelectorAll(".creative-checkbox").forEach((cb) => {
      cb.addEventListener("change", () => {
        syncCheckedStyles();
        updateSelection(tabId);
      });
    });

    await browser.storage.local.set({ [`tab-${tabId}`]: { creatives: allCreatives } });
  } catch (err) {
    console.error("[GWD QA] loadCreatives error:", err);
    list.innerHTML = '<span class="placeholder">Error detecting creatives</span>';
  }
}

// ─── Selection ────────────────────────────────────────────────────────────────

async function updateSelection(tabId) {
  const checked = [...document.querySelectorAll(".creative-checkbox:checked")];

  // Save selected global indices
  const selectedGlobal = checked.map((cb) => parseInt(cb.dataset.globalIndex));
  await saveSelections(tabId, selectedGlobal);

  // Build per-frame local-index map for highlight messages
  const allFrameIds = new Set(
    [...document.querySelectorAll(".creative-checkbox")].map((cb) => parseInt(cb.dataset.frameId))
  );
  const selectionsByFrame = {};
  checked.forEach((cb) => {
    const fid = parseInt(cb.dataset.frameId);
    if (!selectionsByFrame[fid]) selectionsByFrame[fid] = [];
    selectionsByFrame[fid].push(parseInt(cb.dataset.localIndex));
  });

  // Send highlight to every frame (empty localIndices clears the frame's highlight)
  for (const frameId of allFrameIds) {
    browser.tabs
      .sendMessage(tabId, { action: "highlightCreatives", localIndices: selectionsByFrame[frameId] || [] }, { frameId })
      .catch(() => {});
  }

  // Apply accent color from first selected creative that has one
  const accentColor = checked.map((cb) => cb.dataset.accent).find(Boolean);
  if (accentColor) {
    document.documentElement.style.setProperty("--accent", accentColor);
    document.documentElement.style.setProperty("--accent-glow", rgbToGlow(accentColor));
  } else {
    document.documentElement.style.removeProperty("--accent");
    document.documentElement.style.removeProperty("--accent-glow");
  }

  // Rebuild guide sliders
  buildGuideSliders(tabId, checked);
}

// ─── Guide sliders ────────────────────────────────────────────────────────────

async function buildGuideSliders(tabId, checkedCbs) {
  const { [`tab-${tabId}`]: state } = await browser.storage.local.get(`tab-${tabId}`);
  const allCreatives = state?.creatives || [];

  const guidesSection = document.getElementById("guides-section");
  const sliderArea    = document.getElementById("guide-sliders");
  sliderArea.innerHTML = "";

  if (!checkedCbs.length) { guidesSection.style.display = "none"; return; }

  // Collect unique guides from all selected creatives
  const selectedGuides = new Set();
  checkedCbs.forEach((cb) => {
    const gi       = parseInt(cb.dataset.globalIndex);
    const creative = allCreatives.find((c) => c.globalIndex === gi);
    creative?.guides?.forEach((g) => selectedGuides.add(g));
  });

  if (!selectedGuides.size) { guidesSection.style.display = "none"; return; }

  guidesSection.style.display = "block";

  // All frame IDs participating in the current selection
  const frameIds = new Set(checkedCbs.map((cb) => parseInt(cb.dataset.frameId)));

  for (const guideId of selectedGuides) {
    const label    = guideId.replace(/^guide_/, "");
    const item     = document.createElement("div");
    item.className = "guide-slider-item";
    item.innerHTML = `
      <span class="guide-slider-name" title="${label}">${label}</span>
      <input type="range" class="guide-slider" min="0" max="2" step="1" value="0"
             data-guide-id="${guideId}">
      <div class="guide-tick-labels"><span>Hidden</span><span>50%</span><span>Visible</span></div>
    `;
    sliderArea.appendChild(item);

    item.querySelector(".guide-slider").addEventListener("input", (e) => {
      const opacity = { 0: 0, 1: 0.5, 2: 1 }[parseInt(e.target.value)];
      for (const frameId of frameIds) {
        browser.tabs.sendMessage(
          tabId,
          { action: "setGuideOpacity", guideId, opacity },
          { frameId }
        ).catch(() => {});
      }
    });
  }
}

// ─── State ────────────────────────────────────────────────────────────────────

async function saveSelections(tabId, globalIndices) {
  const existing = (await browser.storage.local.get(`tab-${tabId}`))[`tab-${tabId}`] || {};
  await browser.storage.local.set({ [`tab-${tabId}`]: { ...existing, selections: globalIndices } });
}

async function restoreSelections(tabId) {
  const data  = (await browser.storage.local.get(`tab-${tabId}`))[`tab-${tabId}`];
  if (!data?.selections?.length) return;

  const checkboxes = document.querySelectorAll(".creative-checkbox");
  checkboxes.forEach((cb) => {
    cb.checked = data.selections.includes(parseInt(cb.dataset.globalIndex));
  });
  syncCheckedStyles();
  updateSelection(tabId);
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

/** Mirror checkbox state to the parent label's visual class. */
function syncCheckedStyles() {
  document.querySelectorAll(".creative-item").forEach((label) => {
    const cb = label.querySelector(".creative-checkbox");
    label.classList.toggle("is-checked", cb?.checked ?? false);
  });
}

/** Convert "rgb(r, g, b)" → "rgba(r, g, b, 0.18)" for glow variable. */
function rgbToGlow(rgb) {
  const m = rgb.match(/\d+/g);
  return m ? `rgba(${m[0]}, ${m[1]}, ${m[2]}, 0.18)` : "rgba(96,165,250,0.18)";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
