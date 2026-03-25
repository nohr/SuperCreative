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

  // Guide opacity slider
  document.getElementById("guide-opacity-slider").addEventListener("input", (e) => {
    const sliderValue = parseInt(e.target.value);
    const opacityMap = { 0: 0, 1: 0.5, 2: 1 };
    const opacity = opacityMap[sliderValue];
    applyControl(tab.id, "toggleGuide", opacity);
  });
});

/**
 * Save current state to storage
 */
async function saveState(tabId, creatives = null, selections = null, guideOpacity = null) {
  const data = await browser.storage.local.get(`tab-${tabId}`);
  const currentState = data[`tab-${tabId}`] || {
    creatives: [],
    selections: [],
    guideOpacity: 0,
  };

  // Update only the fields that were provided
  const newState = {
    creatives: creatives !== null ? creatives : currentState.creatives,
    selections: selections !== null ? selections : currentState.selections,
    guideOpacity: guideOpacity !== null ? guideOpacity : currentState.guideOpacity,
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

  // Restore guide opacity
  if (state.guideOpacity !== undefined) {
    const opacityToSlider = { 0: 0, 0.5: 1, 1: 2 };
    const sliderValue = opacityToSlider[state.guideOpacity] ?? 0;
    document.getElementById("guide-opacity-slider").value = sliderValue;
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
    console.log("[GWD QA] Found frames from getAllFrames:", frames.map(f => ({ frameId: f.frameId, url: f.url.substring(0, 50) })));

    let allCreatives = [];
    let creativeIndex = 0;

    // Always query main frame (frameId 0) first
    const mainFrameFn = async () => {
      try {
        const response = await browser.tabs.sendMessage(tabId, { action: "getCreatives" }, { frameId: 0 });
        console.log("[GWD QA] Main frame (0) returned:", response?.length || 0, "creatives");
        return response || [];
      } catch (err) {
        console.log("[GWD QA] Main frame query failed:", err.message);
        return [];
      }
    };

    const mainFrameCreatives = await mainFrameFn();
    if (mainFrameCreatives.length > 0) {
      mainFrameCreatives.forEach((creative) => {
        allCreatives.push({
          ...creative,
          index: creativeIndex++,
          frameId: 0,
        });
      });
    }

    // Then query detected iframes
    // Query each frame for creatives
    for (const frame of frames) {
      // Skip main frame since we already queried it
      if (frame.frameId === 0) {
        continue;
      }
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
      document.getElementById("select-all-btn").style.display = "none";
      return;
    }

    // Hide Select All button if only one creative
    document.getElementById("select-all-btn").style.display =
      allCreatives.length > 1 ? "block" : "none";

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
  const guideSlider = document.getElementById("guide-opacity-slider");
  const sliderContainer = document.querySelector(".guide-slider-container");

  if (selectedCheckboxes.length > 0) {
    // Check if all selected creatives have guides
    const allHaveGuides = Array.from(selectedCheckboxes).every((cb) => {
      return cb.getAttribute("data-has-guide") === "true";
    });

    // Enable/disable slider based on guide availability
    if (allHaveGuides) {
      guideSlider.disabled = false;
      sliderContainer.classList.remove("disabled");
    } else {
      guideSlider.disabled = true;
      sliderContainer.classList.add("disabled");
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
    guideSlider.disabled = true;
    sliderContainer.classList.add("disabled");

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
function applyControl(tabId, action, opacity) {
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
        opacity: opacity,
      },
      { frameId: parseInt(frameId) }
    );
  });

  // Save guide opacity state
  saveState(tabId, null, null, opacity);
}
