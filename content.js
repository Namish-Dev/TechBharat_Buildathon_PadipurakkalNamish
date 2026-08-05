// content.js
// Injected only after a deliberate toolbar-icon or keyboard-shortcut action.
// Supports:
// - Whole page text summarization
// - Current text-selection summarization
// - User-drawn screenshot region summarization
// - Structured streaming output
// - Clipboard copy and Markdown export

(function () {
  if (window.__inlineSummarizerLoaded) {
    window.__inlineSummarizerToggle?.();
    return;
  }

  window.__inlineSummarizerLoaded = true;

  let hostEl = null;
  let shadow = null;

  let lastStructured = null;
  let lastRawStream = "";
  let activeCaptureMode = "page";

  function getPageText() {
    const contentRoot =
      document.querySelector("article") ||
      document.querySelector("main") ||
      document.body;

    return (contentRoot.innerText || "")
      .replace(/\s+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  function getSelectionText() {
    return (window.getSelection()?.toString() || "")
      .replace(/\s+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  function escapeHTML(value) {
    return String(value || "").replace(/[&<>"']/g, (character) => {
      const map = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      };

      return map[character];
    });
  }

  function getElement(id) {
    return shadow?.getElementById(id);
  }

  function buildPanel() {
    hostEl = document.createElement("div");

    hostEl.id = "__inline-summarizer-host";
    hostEl.style.position = "fixed";
    hostEl.style.top = "0";
    hostEl.style.right = "0";
    hostEl.style.zIndex = "2147483647";

    document.documentElement.appendChild(hostEl);

    shadow = hostEl.attachShadow({
      mode: "open"
    });

    const style = document.createElement("style");

    style.textContent = `
      :host {
        all: initial;
      }

      .panel {
        width: 400px;
        max-height: 90vh;
        margin: 12px;
        display: flex;
        flex-direction: column;
        overflow: hidden;

        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #f4f4f7;
        background: #1d1d24;
        border: 1px solid #393944;
        border-radius: 12px;
        box-shadow: 0 12px 34px rgba(0, 0, 0, 0.45);
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 14px;
        background: #15151b;
        border-bottom: 1px solid #393944;
      }

      .title {
        color: #ffffff;
        font-size: 14px;
        font-weight: 700;
      }

      .subtitle {
        max-width: 320px;
        margin-top: 2px;
        overflow: hidden;
        color: #9d9daa;
        font-size: 11px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .close-btn {
        padding: 2px 7px;
        color: #a9a9b5;
        font-size: 18px;
        line-height: 1;
        background: transparent;
        border: none;
        border-radius: 5px;
        cursor: pointer;
      }

      .close-btn:hover {
        color: #ffffff;
        background: #30303a;
      }

      .body {
        flex: 1;
        min-height: 170px;
        padding: 14px;
        overflow-y: auto;
        font-size: 13px;
        line-height: 1.55;
      }

      .capture-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }

      .capture-actions .region-button {
        grid-column: span 2;
      }

      .action-button,
      .footer-button {
        padding: 9px 10px;
        color: #e8e8ee;
        font-size: 12px;
        font-weight: 600;
        background: #292934;
        border: 1px solid #41414d;
        border-radius: 7px;
        cursor: pointer;
      }

      .action-button:hover,
      .footer-button:hover {
        background: #353540;
      }

      .action-button.primary {
        color: #ffffff;
        background: #6957dc;
        border-color: #7c6bef;
      }

      .action-button.primary:hover {
        background: #5c4bcb;
      }

      button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .footer {
        display: flex;
        gap: 8px;
        padding: 10px 14px;
        background: #17171d;
        border-top: 1px solid #393944;
      }

      .footer-button {
        flex: 1;
      }

      .intro {
        margin-bottom: 14px;
        color: #c9c9d2;
      }

      .status {
        color: #a8a8b4;
        font-size: 12px;
      }

      .section-title {
        margin-top: 14px;
        margin-bottom: 5px;
        color: #c1b6ff;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }

      .summary-text {
        color: #f2f2f5;
      }

      ul {
        margin: 0;
        padding-left: 19px;
      }

      li {
        margin-bottom: 5px;
      }

      .empty {
        color: #92929d;
        font-size: 12px;
        font-style: italic;
      }

      .error {
        padding: 10px;
        color: #ffb8b8;
        font-size: 12px;
        line-height: 1.5;
        background: #361c23;
        border: 1px solid #66313a;
        border-radius: 7px;
      }

      .spinner {
        display: inline-block;
        width: 12px;
        height: 12px;
        margin-right: 7px;
        vertical-align: -2px;
        border: 2px solid #4a4a58;
        border-top-color: #8f80ff;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }

      .raw-stream {
        max-height: 310px;
        margin-top: 10px;
        padding: 10px;
        overflow: auto;
        color: #b6b6c0;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11px;
        line-height: 1.45;
        white-space: pre-wrap;
        background: #15151b;
        border: 1px solid #353540;
        border-radius: 6px;
      }

      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
    `;

    shadow.appendChild(style);

    const panel = document.createElement("div");
    panel.className = "panel";

    panel.innerHTML = `
      <div class="header">
        <div>
          <div class="title">Inline Summarizer</div>
          <div class="subtitle">${escapeHTML(document.title)}</div>
        </div>

        <button class="close-btn" id="close-btn" title="Close">
          ×
        </button>
      </div>

      <div class="body" id="body-area"></div>

      <div class="footer">
        <button class="footer-button" id="copy-btn" disabled>
          Copy Markdown
        </button>

        <button class="footer-button" id="export-btn" disabled>
          Export .md
        </button>
      </div>
    `;

    shadow.appendChild(panel);

    getElement("close-btn").addEventListener("click", hidePanel);
    getElement("copy-btn").addEventListener("click", copySummary);
    getElement("export-btn").addEventListener("click", exportSummary);

    renderCaptureMenu();
  }

  function showPanel() {
    if (!hostEl) {
      buildPanel();
    }

    hostEl.style.display = "block";
  }

  function hidePanel() {
    if (hostEl) {
      hostEl.style.display = "none";
    }
  }

  function togglePanel() {
    if (!hostEl) {
      showPanel();
      return;
    }

    hostEl.style.display =
      hostEl.style.display === "none" ? "block" : "none";
  }

  window.__inlineSummarizerToggle = togglePanel;

  function setBodyHTML(html) {
    const body = getElement("body-area");

    if (body) {
      body.innerHTML = html;
    }
  }

  function renderCaptureMenu() {
    setBodyHTML(`
      <div class="intro">
        Choose what you want to summarize.
      </div>

      <div class="capture-actions">
        <button class="action-button primary" id="page-btn">
          Summarize page
        </button>

        <button class="action-button" id="selection-btn">
          Summarize selection
        </button>

        <button class="action-button region-button" id="region-btn">
          Summarize visual region
        </button>
      </div>
    `);

    getElement("page-btn").addEventListener("click", () => {
      startTextSummary("page");
    });

    getElement("selection-btn").addEventListener("click", () => {
      startTextSummary("selection");
    });

    getElement("region-btn").addEventListener("click", () => {
      startRegionSelection();
    });
  }

  function showError(message) {
    const copyButton = getElement("copy-btn");
    const exportButton = getElement("export-btn");

    if (copyButton) {
      copyButton.disabled = true;
    }

    if (exportButton) {
      exportButton.disabled = true;
    }

    setBodyHTML(`
      <div class="error">
        ${escapeHTML(message)}
      </div>

      <div class="section-title">Try again</div>

      <div class="capture-actions">
        <button class="action-button primary" id="retry-page-btn">
          Summarize page
        </button>

        <button class="action-button" id="retry-selection-btn">
          Summarize selection
        </button>

        <button class="action-button region-button" id="retry-region-btn">
          Summarize visual region
        </button>
      </div>
    `);

    getElement("retry-page-btn").addEventListener("click", () => {
      startTextSummary("page");
    });

    getElement("retry-selection-btn").addEventListener("click", () => {
      startTextSummary("selection");
    });

    getElement("retry-region-btn").addEventListener("click", () => {
      startRegionSelection();
    });
  }

  async function sendRuntimeMessage(message) {
    if (!chrome.runtime?.id) {
      throw new Error(
        "Extension context was invalidated. Reload this webpage and reopen the extension."
      );
    }

    await chrome.runtime.sendMessage(message);
  }

  async function startTextSummary(mode) {
    activeCaptureMode = mode;

    const pageText =
      mode === "selection"
        ? getSelectionText()
        : getPageText();

    if (mode === "selection" && pageText.length < 20) {
      showError(
        "No usable text is selected. Highlight text on the page first, then choose Summarize selection."
      );
      return;
    }

    if (mode === "page" && pageText.length < 20) {
      showError(
        "Could not find readable page text. Try Summarize visual region for images, charts, e-paper pages, or canvas dashboards."
      );
      return;
    }

    lastStructured = null;
    lastRawStream = "";

    getElement("copy-btn").disabled = true;
    getElement("export-btn").disabled = true;

    setBodyHTML(`
      <div class="status">
        <span class="spinner"></span>
        Reading ${mode === "selection" ? "selected text" : "page"} and contacting model...
      </div>
    `);

    try {
      await sendRuntimeMessage({
        type: "SUMMARIZE_PAGE",
        payload: {
          pageText,
          title:
            mode === "selection"
              ? `Selection from ${document.title}`
              : document.title,
          url: location.href,
          captureMode: mode
        }
      });
    } catch (error) {
      console.error(error);
      showError(error.message);
    }
  }

  function startRegionSelection() {
    activeCaptureMode = "region";

    // The panel must be hidden before capture so it is not included in screenshot.
    hidePanel();

    const overlay = document.createElement("div");
    const selectionBox = document.createElement("div");
    const helper = document.createElement("div");

    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.zIndex = "2147483646";
    overlay.style.cursor = "crosshair";
    overlay.style.background = "rgba(0, 0, 0, 0.28)";
    overlay.style.userSelect = "none";

    selectionBox.style.position = "fixed";
    selectionBox.style.display = "none";
    selectionBox.style.border = "2px solid #8f80ff";
    selectionBox.style.background = "rgba(143, 128, 255, 0.18)";
    selectionBox.style.pointerEvents = "none";

    helper.style.position = "fixed";
    helper.style.top = "20px";
    helper.style.left = "50%";
    helper.style.transform = "translateX(-50%)";
    helper.style.padding = "10px 14px";
    helper.style.color = "#ffffff";
    helper.style.fontFamily =
      '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    helper.style.fontSize = "13px";
    helper.style.background = "rgba(20, 20, 26, 0.95)";
    helper.style.border = "1px solid rgba(255, 255, 255, 0.16)";
    helper.style.borderRadius = "8px";
    helper.style.boxShadow = "0 6px 24px rgba(0, 0, 0, 0.4)";
    helper.style.pointerEvents = "none";
    helper.textContent =
      "Drag over an article, chart, table, or image. Press Escape to cancel.";

    overlay.appendChild(selectionBox);
    overlay.appendChild(helper);
    document.documentElement.appendChild(overlay);

    let startX = 0;
    let startY = 0;
    let selecting = false;

    function cancelSelection() {
      overlay.remove();
      showPanel();
      renderCaptureMenu();
    }

    function getRect(currentX, currentY) {
      const left = Math.min(startX, currentX);
      const top = Math.min(startY, currentY);

      return {
        left,
        top,
        width: Math.abs(currentX - startX),
        height: Math.abs(currentY - startY)
      };
    }

    function drawSelection(rect) {
      selectionBox.style.display = "block";
      selectionBox.style.left = `${rect.left}px`;
      selectionBox.style.top = `${rect.top}px`;
      selectionBox.style.width = `${rect.width}px`;
      selectionBox.style.height = `${rect.height}px`;
    }

    overlay.addEventListener("pointerdown", (event) => {
      selecting = true;
      startX = event.clientX;
      startY = event.clientY;

      overlay.setPointerCapture(event.pointerId);

      drawSelection({
        left: startX,
        top: startY,
        width: 0,
        height: 0
      });
    });

    overlay.addEventListener("pointermove", (event) => {
      if (!selecting) {
        return;
      }

      drawSelection(getRect(event.clientX, event.clientY));
    });

    overlay.addEventListener("pointerup", async (event) => {
      if (!selecting) {
        return;
      }

      selecting = false;

      const rect = getRect(event.clientX, event.clientY);

      if (rect.width < 20 || rect.height < 20) {
        cancelSelection();
        showError(
          "The selected region is too small. Drag over a larger article, table, chart, or image."
        );
        return;
      }

      overlay.remove();
      showPanel();

      setBodyHTML(`
        <div class="status">
          <span class="spinner"></span>
          Capturing selected visual region...
        </div>
      `);

      try {
        // Give Chrome a moment to repaint without the overlay and panel.
        await new Promise((resolve) => setTimeout(resolve, 100));

        await sendRuntimeMessage({
          type: "CAPTURE_REGION",
          payload: {
            rect: {
              ...rect,
              viewportWidth: window.innerWidth,
              viewportHeight: window.innerHeight
            }
          }
        });
      } catch (error) {
        console.error(error);
        showError(error.message);
      }
    });

    window.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") {
          cancelSelection();
        }
      },
      { once: true }
    );
  }

  async function cropScreenshot(screenshotDataUrl, rect) {
    return new Promise((resolve, reject) => {
      const image = new Image();

      image.onload = () => {
        const scaleX = image.naturalWidth / rect.viewportWidth;
        const scaleY = image.naturalHeight / rect.viewportHeight;

        const sourceX = Math.max(0, Math.round(rect.left * scaleX));
        const sourceY = Math.max(0, Math.round(rect.top * scaleY));

        const sourceWidth = Math.min(
          Math.round(rect.width * scaleX),
          image.naturalWidth - sourceX
        );

        const sourceHeight = Math.min(
          Math.round(rect.height * scaleY),
          image.naturalHeight - sourceY
        );

        if (sourceWidth < 1 || sourceHeight < 1) {
          reject(new Error("The selected screenshot region was invalid."));
          return;
        }

        const canvas = document.createElement("canvas");
        canvas.width = sourceWidth;
        canvas.height = sourceHeight;

        const context = canvas.getContext("2d");

        context.drawImage(
          image,
          sourceX,
          sourceY,
          sourceWidth,
          sourceHeight,
          0,
          0,
          sourceWidth,
          sourceHeight
        );

        resolve(canvas.toDataURL("image/png"));
      };

      image.onerror = () => {
        reject(new Error("Could not read the captured screenshot."));
      };

      image.src = screenshotDataUrl;
    });
  }

  async function handleRegionScreenshot(message) {
    try {
      setBodyHTML(`
        <div class="status">
          <span class="spinner"></span>
          Preparing screenshot for visual analysis...
        </div>
      `);

      const imageDataUrl = await cropScreenshot(
        message.screenshotDataUrl,
        message.rect
      );

      await sendRuntimeMessage({
        type: "SUMMARIZE_IMAGE",
        payload: {
          imageDataUrl,
          mimeType: "image/png",
          title: `Visual region from ${document.title}`,
          url: location.href
        }
      });
    } catch (error) {
      console.error(error);
      showError(error.message);
    }
  }

  function renderList(items) {
    if (!Array.isArray(items) || items.length === 0) {
      return `<div class="empty">None detected</div>`;
    }

    return `
      <ul>
        ${items
          .map((item) => `<li>${escapeHTML(item)}</li>`)
          .join("")}
      </ul>
    `;
  }

  function renderStructuredSummary(summary) {
    lastStructured = summary;

    const sourceLabel = {
      page: "Full page text",
      selection: "Selected text",
      region: "Selected screenshot region"
    }[activeCaptureMode];

    setBodyHTML(`
      <div class="summary-text">
        ${escapeHTML(summary.twoLineSummary || "No summary was returned.")}
      </div>

      <div class="section-title">Key points</div>
      ${renderList(summary.keyPoints)}

      <div class="section-title">Action items</div>
      ${renderList(summary.actionItems)}

      <div class="section-title">Decisions</div>
      ${renderList(summary.decisions)}

      <div class="section-title">Numbers</div>
      ${renderList(summary.numbers)}

      ${
        Array.isArray(summary.unreadableSections) &&
        summary.unreadableSections.length > 0
          ? `
            <div class="section-title">Unreadable sections</div>
            ${renderList(summary.unreadableSections)}
          `
          : ""
      }

      <div class="section-title">Details</div>
      <div class="status">
        Source: ${escapeHTML(sourceLabel)} ·
        Confidence: ${escapeHTML(summary.confidence || "unknown")}
      </div>

      <div class="section-title">Summarize something else</div>

      <div class="capture-actions">
        <button class="action-button primary" id="again-page-btn">
          Summarize page
        </button>

        <button class="action-button" id="again-selection-btn">
          Summarize selection
        </button>

        <button class="action-button region-button" id="again-region-btn">
          Summarize visual region
        </button>
      </div>
    `);

    getElement("copy-btn").disabled = false;
    getElement("export-btn").disabled = false;

    getElement("again-page-btn").addEventListener("click", () => {
      startTextSummary("page");
    });

    getElement("again-selection-btn").addEventListener("click", () => {
      startTextSummary("selection");
    });

    getElement("again-region-btn").addEventListener("click", () => {
      startRegionSelection();
    });
  }

  function structuredToMarkdown(summary) {
    const listToMarkdown = (items) => {
      if (!Array.isArray(items) || items.length === 0) {
        return "_None detected_";
      }

      return items.map((item) => `- ${item}`).join("\n");
    };

    const sourceLabel = {
      page: "Full page text",
      selection: "Selected text",
      region: "Selected screenshot region"
    }[activeCaptureMode];

    return `# Summary of ${document.title}

Source URL: ${location.href}
Capture mode: ${sourceLabel}

${summary.twoLineSummary || ""}

## Key points
${listToMarkdown(summary.keyPoints)}

## Action items
${listToMarkdown(summary.actionItems)}

## Decisions
${listToMarkdown(summary.decisions)}

## Numbers
${listToMarkdown(summary.numbers)}

## Unreadable sections
${listToMarkdown(summary.unreadableSections)}

Confidence: ${summary.confidence || "unknown"}
`;
  }

  async function copySummary() {
    if (!lastStructured) {
      return;
    }

    try {
      await navigator.clipboard.writeText(
        structuredToMarkdown(lastStructured)
      );

      const copyButton = getElement("copy-btn");
      const oldText = copyButton.textContent;

      copyButton.textContent = "Copied";

      setTimeout(() => {
        copyButton.textContent = oldText;
      }, 1200);
    } catch {
      showError("Could not copy the summary to the clipboard.");
    }
  }

  function exportSummary() {
    if (!lastStructured) {
      return;
    }

    const blob = new Blob(
      [structuredToMarkdown(lastStructured)],
      {
        type: "text/markdown"
      }
    );

    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = objectUrl;
    link.download = `summary-${Date.now()}.md`;

    document.documentElement.appendChild(link);
    link.click();
    link.remove();

    URL.revokeObjectURL(objectUrl);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "TOGGLE_PANEL") {
      togglePanel();
      return;
    }

    if (message.type === "REGION_SCREENSHOT") {
      handleRegionScreenshot(message);
      return;
    }

    if (message.type === "SUMMARY_START") {
      setBodyHTML(`
        <div class="status">
          <span class="spinner"></span>
          Summarizing with your selected model...
        </div>

        <div class="raw-stream" id="raw-stream"></div>
      `);
      return;
    }

    if (message.type === "SUMMARY_STREAM") {
      lastRawStream = message.fullText || "";

      const streamElement = getElement("raw-stream");

      if (streamElement) {
        streamElement.textContent = lastRawStream;
        streamElement.scrollTop = streamElement.scrollHeight;
      }

      return;
    }

    if (message.type === "SUMMARY_DONE") {
      renderStructuredSummary(message.structured);
      return;
    }

    if (message.type === "SUMMARY_ERROR") {
      showError(
        message.message || "An unknown summarization error occurred."
      );
    }
  });

  showPanel();
})();