document.addEventListener("DOMContentLoaded", async () => {
  console.log("[GWD QA] Popup opened");
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  console.log("[GWD QA] Active tab:", tab.id, tab.url);

  // Set version from manifest
  const manifest = browser.runtime.getManifest();
  document.getElementById("version").textContent = `v${manifest.version}`;

  // Load creatives and display them
  await loadCreatives(tab.id);

  // Restore previous selections and guide state
  await restoreState(tab.id);

  // Select All button
  document.getElementById("select-all-btn").addEventListener("click", () => {
    const checkboxes = document.querySelectorAll(".creative-checkbox");
    const allChecked = Array.from(checkboxes).every((cb) => cb.checked);
    checkboxes.forEach((cb) => (cb.checked = !allChecked));
    updateCreativeSelection(tab.id);
  });

  // Show Guide control
  document.getElementById("toggle-guide").addEventListener("change", (e) => {
    applyControl(tab.id, "toggleGuide", e.target.checked);
  });
});

/**
 * Save current state to storage
 */
async function saveState(tabId, creatives = null, selections = null, guideEnabled = null) {
  const data = await browser.storage.local.get(`tab-${tabId}`);
  const currentState = data[`tab-${tabId}`] || {
    creatives: [],
    selections: [],
    guideEnabled: false,
  };

  // Update only the fields that were provided
  const newState = {
    creatives: creatives !== null ? creatives : currentState.creatives,
    selections: selections !== null ? selections : currentState.selections,
    guideEnabled: guideEnabled !== null ? guideEnabled : currentState.guideEnabled,
    timestamp: Date.now(),
  };

  await browser.storage.local.set({ [`tab-${tabId}`]: newState });
  console.log("[GWD QA] State saved for tab", tabId);
}

/**
 * Restore previous state from storage
 */
async function restoreState(tabId) {
  const data = await browser.storage.local.get(`tab-${tabId}`);
  const state = data[`tab-${tabId}`];

  if (!state) {
    console.log("[GWD QA] No saved state for tab", tabId);
    return;
  }

  console.log("[GWD QA] Restoring state for tab", tabId);

  // Restore selections
  if (state.selections && state.selections.length > 0) {
    const checkboxes = document.querySelectorAll(".creative-checkbox");
    checkboxes.forEach((cb) => {
      const index = parseInt(cb.getAttribute("data-index"));
      cb.checked = state.selections.includes(index);
    });

    // Update UI to reflect restored selections
    updateCreativeSelection(tabId);
  }

  // Restore guide state
  if (state.guideEnabled !== undefined) {
    document.getElementById("toggle-guide").checked = state.guideEnabled;
  }
}

/**
 * Load creatives from all frames (main + iframes)
 */
async function loadCreatives(tabId) {
  try {
    console.log("[GWD QA] Loading creatives from tab:", tabId);
    // Get all frames in the tab
    const frames = await browser.webNavigation.getAllFrames({ tabId });
    console.log("[GWD QA] Found frames in tab:", frames);

    let allCreatives = [];
    let creativeIndex = 0;

    // Query each frame for creatives
    for (const frame of frames) {
      console.log(
        `[GWD QA] Querying frame ${frame.frameId} (${frame.url.substring(0, 50)}...)`
      );
      try {
        // Add retry logic - try up to 3 times with delays
        let frameCreatives = null;
        let success = false;

        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            frameCreatives = await browser.tabs.sendMessage(
              tabId,
              { action: "getCreatives" },
              { frameId: frame.frameId }
            );
            success = true;
            break;
          } catch (err) {
            if (attempt < 2) {
              // Wait before retrying
              await new Promise((resolve) => setTimeout(resolve, 300));
            }
          }
        }

        if (!success) {
          console.log(
            `[GWD QA] Frame ${frame.frameId} not responding after retries`
          );
          continue;
        }

        console.log(
          `[GWD QA] Frame ${frame.frameId} response:`,
          frameCreatives
        );

        if (frameCreatives && frameCreatives.length > 0) {
          console.log(
            `[GWD QA] Frame ${frame.frameId} has ${frameCreatives.length} creatives`
          );
          // Re-index creatives to be globally unique
          frameCreatives.forEach((creative) => {
            allCreatives.push({
              ...creative,
              index: creativeIndex++,
              frameId: frame.frameId,
            });
          });
        }
      } catch (err) {
        console.log(
          `[GWD QA] Error querying frame ${frame.frameId}:`,
          err.message
        );
      }
    }

    console.log("[GWD QA] Total creatives found:", allCreatives.length);

    const creativesList = document.getElementById("creatives-list");
    creativesList.innerHTML = "";

    if (allCreatives.length === 0) {
      creativesList.innerHTML =
        '<span class="loading">No creatives found on this page</span>';
      return;
    }

    allCreatives.forEach((creative) => {
      const label = document.createElement("label");
      label.className = "creative-item";
      label.innerHTML = `
        <input type="checkbox" class="creative-checkbox" data-index="${creative.index}" data-frame-id="${creative.frameId}" data-has-guide="${creative.hasGuide}">
        <span class="creative-label">${creative.id}</span>
      `;
      creativesList.appendChild(label);
    });

    // Add event listeners to checkboxes
    document.querySelectorAll(".creative-checkbox").forEach((checkbox) => {
      checkbox.addEventListener("change", () => updateCreativeSelection(tabId));
    });

    // Save creatives list only (preserve selections and guide state)
    await saveState(tabId, allCreatives, null, null);
  } catch (err) {
    console.error("[GWD QA] Error loading creatives:", err);
    document.getElementById("creatives-list").innerHTML =
      '<span class="loading">Error detecting creatives</span>';
  }
}

/**
 * Update creative selection and highlight them
 */
function updateCreativeSelection(tabId) {
  const selectedCheckboxes = document.querySelectorAll(
    ".creative-checkbox:checked"
  );

  // Get selected indices for storage
  const selectedIndices = Array.from(selectedCheckboxes).map((cb) =>
    parseInt(cb.getAttribute("data-index"))
  );

  // Group selections by frameId for highlighting
  const selectionsByFrame = {};
  selectedCheckboxes.forEach((cb) => {
    const frameId = parseInt(cb.getAttribute("data-frame-id"));
    const index = parseInt(cb.getAttribute("data-index"));

    if (!selectionsByFrame[frameId]) {
      selectionsByFrame[frameId] = [];
    }
    selectionsByFrame[frameId].push(index);
  });

  // Send highlight messages to each frame
  Object.entries(selectionsByFrame).forEach(([frameId, indices]) => {
    browser.tabs.sendMessage(
      tabId,
      {
        action: "highlightCreatives",
        selectedIndices: indices,
      },
      { frameId: parseInt(frameId) }
    );
  });

  // Enable/disable controls based on selection
  const controlsSection = document.getElementById("controls-section");
  const toggleGuide = document.getElementById("toggle-guide");
  const toggleGuideLabel = document.querySelector("label.switch");

  if (selectedCheckboxes.length > 0) {
    toggleGuide.checked = false;

    // Check if all selected creatives have guides
    const allHaveGuides = Array.from(selectedCheckboxes).every((cb) => {
      return cb.getAttribute("data-has-guide") === "true";
    });

    // Disable/enable toggle based on guide availability
    if (allHaveGuides) {
      toggleGuide.disabled = false;
      toggleGuideLabel.classList.remove("disabled");
    } else {
      toggleGuide.disabled = true;
      toggleGuideLabel.classList.add("disabled");
    }

    // Send highlight to main frame (frame 0) to highlight iframes
    browser.tabs.sendMessage(
      tabId,
      {
        action: "highlightCreatives",
        selectedIndices: selectedIndices,
      },
      { frameId: 0 }
    );

    // Save state (update selections only)
    saveState(tabId, null, selectedIndices, null);
  } else {
    toggleGuide.disabled = true;
    toggleGuideLabel.classList.add("disabled");

    // Clear highlights in main frame
    browser.tabs.sendMessage(
      tabId,
      {
        action: "highlightCreatives",
        selectedIndices: [],
      },
      { frameId: 0 }
    );

    // Save state (update selections only)
    saveState(tabId, null, selectedIndices, null);
  }
}

/**
 * Apply a control action to selected creatives
 */
function applyControl(tabId, action, enabled) {
  const selectedCheckboxes = document.querySelectorAll(
    ".creative-checkbox:checked"
  );
  const selectedIndices = Array.from(selectedCheckboxes).map((cb) =>
    parseInt(cb.getAttribute("data-index"))
  );

  // Group selections by frameId
  const selectionsByFrame = {};
  selectedCheckboxes.forEach((cb) => {
    const frameId = parseInt(cb.getAttribute("data-frame-id"));
    const index = parseInt(cb.getAttribute("data-index"));

    if (!selectionsByFrame[frameId]) {
      selectionsByFrame[frameId] = [];
    }
    selectionsByFrame[frameId].push(index);
  });

  // Send messages to each frame for toggleGuide
  Object.entries(selectionsByFrame).forEach(([frameId, indices]) => {
    browser.tabs.sendMessage(
      tabId,
      {
        action: "toggleGuide",
        selectedIndices: indices,
        enabled: enabled,
      },
      { frameId: parseInt(frameId) }
    );
  });

  // Save guide state (update guideEnabled only)
  saveState(tabId, null, null, enabled);
}
