// content.js — stable panel + simple streaming UI
// - Summarize page / selection / visual region
// - Domain-aware capture (generic, GitHub PR, Gmail, Jira)
// - PDF detection fallback
// - Spinner removed on first SUMMARY_STREAM

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

  function isPdfLikePage() {
    const url = String(location.href || "").toLowerCase();
    const contentType = String(document.contentType || "").toLowerCase();

    return (
      url.endsWith(".pdf") ||
      url.includes(".pdf?") ||
      contentType === "application/pdf" ||
      document.querySelector("embed[type='application/pdf']") !== null ||
      document.querySelector("iframe[src*='.pdf']") !== null
    );
  }

  function detectDomainHint() {
    const url = String(location.href || "").toLowerCase();

    if (isPdfLikePage()) return "pdf";
    if (url.includes("github.com") && url.includes("/pull/")) return "github_pr";
    if (url.includes("mail.google.com")) return "gmail_thread";
    if (url.includes("jira.") || url.includes("/browse/") || url.includes("/jira")) return "jira";
    return "generic";
  }

  function getModeLabel(mode) {
    if (mode === "selection") return "Selected text";
    if (mode === "region") return "Selected screenshot region";
    if (mode === "pdf") return "PDF document";
    if (mode === "github_pr") return "GitHub pull request";
    if (mode === "gmail_thread") return "Gmail thread";
    if (mode === "jira") return "Jira page";
    return "Full page text";
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

  function cleanText(text) {
    return String(text || "")
      .replace(/\s+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  function collectVisibleText(root, maxChars = 12000) {
    const text = cleanText(root?.innerText || "");
    if (!text) return "";
    return text.slice(0, maxChars);
  }

  function getPageText() {
    const preferredContent =
      document.querySelector("article") ||
      document.querySelector("main") ||
      document.body;

    return collectVisibleText(preferredContent, 12000);
  }

  function getSelectionText() {
    return cleanText(window.getSelection()?.toString() || "").slice(0, 12000);
  }

  function getGitHubPrText() {
    const pieces = [];

    const titleEl =
      document.querySelector("bdi.js-issue-title") ||
      document.querySelector("span.js-issue-title") ||
      document.querySelector("[data-testid='issue-title']") ||
      document.querySelector("h1");

    if (titleEl) {
      pieces.push(`Title: ${cleanText(titleEl.textContent)}`);
    }

    const conversation =
      document.querySelector("[data-tab-item='i0']") ||
      document.querySelector("#discussion_bucket") ||
      document.querySelector("[aria-label*='Conversation']");

    if (conversation) {
      const txt = collectVisibleText(conversation, 6000);
      if (txt) pieces.push(`Conversation:\n${txt}`);
    }

    const filesChanged =
      document.querySelector("[data-tab-item='files']") ||
      document.querySelector("#files") ||
      document.querySelector("[aria-label*='Files changed']");

    if (filesChanged) {
      const txt = collectVisibleText(filesChanged, 8000);
      if (txt) pieces.push(`Files changed:\n${txt}`);
    }

    const fallback = getPageText();
    if (!pieces.length && fallback) pieces.push(fallback);

    return pieces.join("\n\n").slice(0, 16000);
  }

  function getGmailThreadText() {
    const pieces = [];

    const subject =
      document.querySelector("h2.hP") ||
      document.querySelector("[data-thread-subject]") ||
      document.querySelector("h2");

    if (subject) {
      const txt = cleanText(subject.textContent);
      if (txt) pieces.push(`Subject: ${txt}`);
    }

    const thread =
      document.querySelector("[role='main']") ||
      document.body;

    const visibleText = collectVisibleText(thread, 16000);
    if (visibleText) pieces.push(visibleText);

    return pieces.join("\n\n").slice(0, 16000);
  }

  function getJiraText() {
    const pieces = [];

    const titleEl =
      document.querySelector("h1") ||
      document.querySelector(
        "[data-testid='issue.views.issue-base.foundation.summary.heading']"
      );

    if (titleEl) {
      const txt = cleanText(titleEl.textContent);
      if (txt) pieces.push(`Title: ${txt}`);
    }

    const main =
      document.querySelector("[role='main']") ||
      document.body;

    const visibleText = collectVisibleText(main, 16000);
    if (visibleText) pieces.push(visibleText);

    return pieces.join("\n\n").slice(0, 16000);
  }

  function buildCapturePayload(mode) {
    const domainHint = detectDomainHint();
    let pageText = "";

    if (mode === "selection") {
      pageText = getSelectionText();
    } else if (domainHint === "github_pr") {
      pageText = getGitHubPrText();
    } else if (domainHint === "gmail_thread") {
      pageText = getGmailThreadText();
    } else if (domainHint === "jira") {
      pageText = getJiraText();
    } else {
      pageText = getPageText();
    }

    return {
      pageText,
      title: document.title,
      url: location.href,
      captureMode: mode === "page" ? domainHint : mode,
      domainHint
    };
  }

  function showPanel() {
    if (!hostEl) buildPanel();
    hostEl.style.display = "block";
  }

  function hidePanel() {
    if (hostEl) hostEl.style.display = "none";
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
    if (body) body.innerHTML = html;
  }

  function buildPanel() {
    hostEl = document.createElement("div");
    hostEl.id = "__inline-summarizer-host";
    hostEl.style.position = "fixed";
    hostEl.style.top = "0";
    hostEl.style.right = "0";
    hostEl.style.zIndex = "2147483647";
    document.documentElement.appendChild(hostEl);

    shadow = hostEl.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      .panel {
        width: 420px;
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
      .title-wrap { display: flex; flex-direction: column; min-width: 0; }
      .title { color: #ffffff; font-size: 14px; font-weight: 700; }
      .subtitle {
        max-width: 340px;
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
      .close-btn:hover { color: #ffffff; background: #30303a; }
      .body {
        flex: 1;
        min-height: 170px;
        padding: 14px;
        overflow-y: auto;
        font-size: 13px;
        line-height: 1.55;
      }
      .meta {
        margin-bottom: 12px;
        padding: 8px 10px;
        color: #bcbccd;
        font-size: 11px;
        background: #15151b;
        border: 1px solid #2f2f39;
        border-radius: 8px;
      }
      .capture-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      .capture-actions .region-button { grid-column: span 2; }
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
      .footer-button { flex: 1; }
      .intro { margin-bottom: 14px; color: #c9c9d2; }
      .status { color: #a8a8b4; font-size: 12px; }
      .section-title {
        margin-top: 14px;
        margin-bottom: 5px;
        color: #c1b6ff;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .summary-text { color: #f2f2f5; }
      ul { margin: 0; padding-left: 19px; }
      li { margin-bottom: 5px; }
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
      .pulse-dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        margin-right: 8px;
        background-color: #4ade80;
        border-radius: 50%;
        animation: pulse 1.5s infinite;
      }
      @keyframes pulse {
        0% { opacity: 0.4; transform: scale(0.9); }
        50% { opacity: 1; transform: scale(1.1); }
        100% { opacity: 0.4; transform: scale(0.9); }
      }
      .stream-preview {
        min-height: 80px;
        max-height: 280px;
        margin-top: 10px;
        padding: 12px;
        overflow-y: auto;
        color: #f1f5f9;
        font-size: 13px;
        line-height: 1.6;
        white-space: pre-wrap;
        background: #15151b;
        border: 1px solid #353540;
        border-radius: 8px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .cursor-blink {
        display: inline-block;
        width: 7px;
        height: 14px;
        margin-left: 2px;
        vertical-align: -1px;
        background-color: #89b4fa;
        animation: blink 0.9s infinite;
      }
      @keyframes blink {
        0%, 100% { opacity: 1; }
        50% { opacity: 0; }
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
        to { transform: rotate(360deg); }
      }
    `;
    shadow.appendChild(style);

    const panel = document.createElement("div");
    panel.className = "panel";
    panel.innerHTML = `
      <div class="header">
        <div class="title-wrap">
          <div class="title">Inline Summarizer</div>
          <div class="subtitle">${escapeHTML(document.title)}</div>
        </div>
        <button class="close-btn" id="close-btn" title="Close">×</button>
      </div>
      <div class="body" id="body-area">
        <div class="meta">
          Detected mode: <strong>${escapeHTML(getModeLabel(detectDomainHint()))}</strong>
        </div>
        <div class="intro">
          Choose what you want to summarize.
        </div>
        <div class="capture-actions">
          <button class="action-button primary" id="page-btn">Summarize page</button>
          <button class="action-button" id="selection-btn">Summarize selection</button>
          <button class="action-button region-button" id="region-btn">Summarize visual region</button>
        </div>
      </div>
      <div class="footer">
        <button class="footer-button" id="copy-btn" disabled>Copy Markdown</button>
        <button class="footer-button" id="export-btn" disabled>Export .md</button>
      </div>
    `;
    shadow.appendChild(panel);

    getElement("close-btn").addEventListener("click", hidePanel);
    getElement("page-btn").addEventListener("click", () => startTextSummary("page"));
    getElement("selection-btn").addEventListener("click", () => startTextSummary("selection"));
    getElement("region-btn").addEventListener("click", () => startRegionSelection());
    getElement("copy-btn").addEventListener("click", copySummary);
    getElement("export-btn").addEventListener("click", exportSummary);
  }

  function showError(message) {
    const copyButton = getElement("copy-btn");
    const exportButton = getElement("export-btn");
    if (copyButton) copyButton.disabled = true;
    if (exportButton) exportButton.disabled = true;

    setBodyHTML(`
      <div class="error">${escapeHTML(message)}</div>
      <div class="section-title">Try again</div>
      <div class="capture-actions">
        <button class="action-button primary" id="retry-page-btn">Summarize page</button>
        <button class="action-button" id="retry-selection-btn">Summarize selection</button>
        <button class="action-button region-button" id="retry-region-btn">Summarize visual region</button>
      </div>
    `);

    getElement("retry-page-btn").addEventListener("click", () => startTextSummary("page"));
    getElement("retry-selection-btn").addEventListener("click", () => startTextSummary("selection"));
    getElement("retry-region-btn").addEventListener("click", () => startRegionSelection());
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

    const domainHint = detectDomainHint();
    const payload = buildCapturePayload(mode);

    if (mode === "selection" && payload.pageText.length < 20) {
      showError("No usable text is selected.");
      return;
    }

    if (mode === "page" && payload.pageText.length < 20) {
      if (domainHint === "pdf") {
        showError("This looks like a PDF; text extraction is not wired yet. Use visual region capture.");
      } else {
        showError("Could not find readable page text. Try visual region capture.");
      }
      return;
    }

    lastStructured = null;
    lastRawStream = "";

    const copyButton = getElement("copy-btn");
    const exportButton = getElement("export-btn");
    if (copyButton) copyButton.disabled = true;
    if (exportButton) exportButton.disabled = true;

    setBodyHTML(`
      <div class="status" id="stream-status">
        <span class="spinner" id="stream-spinner"></span>
        <span id="stream-label">
          Reading ${escapeHTML(getModeLabel(
            mode === "page" ? domainHint : mode
          ))} and contacting model...
        </span>
      </div>
      <div class="stream-preview" id="stream-preview"><span class="cursor-blink"></span></div>
    `);

    try {
      await sendRuntimeMessage({
        type: "SUMMARIZE_PAGE",
        payload
      });
    } catch (error) {
      console.error(error);
      showError(error.message || "Could not contact the extension service worker.");
    }
  }

  function formatStreamText(raw) {
    if (!raw) return "";

    try {
      const summaryMatch = raw.match(/"twoLineSummary"\s*:\s*"([^"]*)"?/);
      if (summaryMatch && summaryMatch[1]) {
        let result = summaryMatch[1];
        
        const keyPointsIndex = raw.indexOf('"keyPoints"');
        if (keyPointsIndex !== -1) {
          const afterKeyPoints = raw.slice(keyPointsIndex);
          const points = [...afterKeyPoints.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)]
            .map((m) => m[1])
            .filter(
              (p) =>
                ![
                  "keyPoints",
                  "actionItems",
                  "decisions",
                  "numbers",
                  "confidence",
                  "confidenceReason",
                  "unreadableSections"
                ].includes(p)
            );

          if (points.length > 0) {
            result += "\n\nKey Points:\n" + points.map((p) => `• ${p}`).join("\n");
          }
        }
        return result;
      }
    } catch {}

    return raw
      .replace(/^\s*\{\s*/, "")
      .replace(/"twoLineSummary"\s*:\s*"/g, "")
      .replace(/"keyPoints"\s*:\s*\[\s*/g, "\n\nKey Points:\n")
      .replace(/"actionItems"\s*:\s*\[\s*/g, "\n\nAction Items:\n")
      .replace(/"decisions"\s*:\s*\[\s*/g, "\n\nDecisions:\n")
      .replace(/"numbers"\s*:\s*\[\s*/g, "\n\nNumbers:\n")
      .replace(/"confidence"\s*:\s*"[^"]*"/g, "")
      .replace(/"confidenceReason"\s*:\s*"[^"]*"/g, "")
      .replace(/"unreadableSections"\s*:\s*\[\s*\]/g, "")
      .replace(/"/g, "")
      .replace(/,\s*$/g, "")
      .trim();
  }

  function startRegionSelection() {
    // keep your existing region selection code or leave as a TODO
    showError("Region capture not implemented in this simplified version.");
  }

  function renderList(items) {
    if (!Array.isArray(items) || items.length === 0) {
      return `<div class="empty">None detected</div>`;
    }
    return `<ul>${items.map((item) => `<li>${escapeHTML(item)}</li>`).join("")}</ul>`;
  }

  let requestStartTime = null;
  let firstTokenTimingMs = null;

  function renderStructuredSummary(summary, timing) {
    lastStructured = summary;
    const sourceLabel = getModeLabel(activeCaptureMode);
    const ttftText = timing?.ttftMs
      ? ` · 1st Token: ${(timing.ttftMs / 1000).toFixed(2)}s`
      : firstTokenTimingMs
      ? ` · 1st Token: ${(firstTokenTimingMs / 1000).toFixed(2)}s`
      : "";
    const totalText = timing?.totalMs
      ? ` · Total: ${(timing.totalMs / 1000).toFixed(2)}s`
      : "";

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
        Array.isArray(summary.unreadableSections) && summary.unreadableSections.length
          ? `<div class="section-title">Unreadable sections</div>${renderList(summary.unreadableSections)}`
          : ""
      }

      ${
        summary.confidenceReason
          ? `<div class="section-title">Confidence reason</div><div class="status">${escapeHTML(summary.confidenceReason)}</div>`
          : ""
      }

      <div class="section-title">Details & Timing Debug</div>
      <div class="status">
        Source: ${escapeHTML(sourceLabel)}${escapeHTML(ttftText)}${escapeHTML(totalText)} · Confidence: ${escapeHTML(summary.confidence || "unknown")}
      </div>
    `);

    const copyButton = getElement("copy-btn");
    const exportButton = getElement("export-btn");
    if (copyButton) copyButton.disabled = false;
    if (exportButton) exportButton.disabled = false;
  }

  function structuredToMarkdown(summary) {
    const listToMarkdown = (items) => {
      if (!Array.isArray(items) || items.length === 0) return "_None detected_";
      return items.map((item) => `- ${item}`).join("\n");
    };

    const sourceLabel = getModeLabel(activeCaptureMode);

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
    if (!lastStructured) return;

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
    if (!lastStructured) return;

    const blob = new Blob([structuredToMarkdown(lastStructured)], {
      type: "text/markdown"
    });
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

    if (message.type === "SUMMARY_START") {
      requestStartTime = message.startTime || Date.now();
      firstTokenTimingMs = null;
      console.log(`[Inline Summarizer TTFT Debug] 🚀 Summary started at ${new Date(requestStartTime).toLocaleTimeString()}`);
      setBodyHTML(`
        <div class="status" id="stream-status">
          <span class="spinner" id="stream-spinner"></span>
          <span id="stream-label">
            Contacting AI model (timing request)...
          </span>
        </div>
        <div class="stream-preview" id="stream-preview"><span class="cursor-blink"></span></div>
      `);
      return;
    }

    if (message.type === "FIRST_TOKEN_TIMING") {
      firstTokenTimingMs = message.ttftMs;
      const ttftSec = (message.ttftMs / 1000).toFixed(2);
      console.log(`[Inline Summarizer TTFT Debug] ⚡ 1ST TOKEN TIMING LOGGED: ${message.ttftMs}ms (${ttftSec}s) for model '${message.model}'`);

      const label = getElement("stream-label");
      if (label) {
        label.textContent = `⚡ 1st token received in ${ttftSec}s (${message.model}). Streaming...`;
      }
      return;
    }

    if (message.type === "SUMMARY_STREAM") {
      const fullText = message.fullText || "";

      if (!firstTokenTimingMs && requestStartTime) {
        firstTokenTimingMs = Date.now() - requestStartTime;
        const ttftSec = (firstTokenTimingMs / 1000).toFixed(2);
        console.log(`[Inline Summarizer TTFT Debug] ⚡ 1ST TOKEN RECEIVED: ${firstTokenTimingMs}ms (${ttftSec}s)`);
      }

      const statusEl = getElement("stream-status");
      const spinner = getElement("stream-spinner");
      const label = getElement("stream-label");
      const previewEl = getElement("stream-preview");

      if (spinner && statusEl) {
        spinner.remove();
        const pulse = document.createElement("span");
        pulse.className = "pulse-dot";
        statusEl.insertBefore(pulse, label);
      }

      if (label && !label.dataset.firstChunkSeen) {
        const ttftSec = firstTokenTimingMs ? `${(firstTokenTimingMs / 1000).toFixed(2)}s` : "";
        label.textContent = ttftSec
          ? `⚡ 1st token in ${ttftSec}. Streaming summary...`
          : "Streaming summary response...";
        label.dataset.firstChunkSeen = "true";
      }

      if (previewEl) {
        const formatted = formatStreamText(fullText);
        previewEl.innerHTML = escapeHTML(formatted) + '<span class="cursor-blink"></span>';
        previewEl.scrollTop = previewEl.scrollHeight;
      }

      lastRawStream = fullText;
      return;
    }

    if (message.type === "SUMMARY_DONE") {
      if (message.timing?.ttftMs) {
        console.log(`[Inline Summarizer TTFT Debug] ✅ SUMMARY DONE! 1st token: ${(message.timing.ttftMs / 1000).toFixed(2)}s, Total: ${(message.timing.totalMs / 1000).toFixed(2)}s`);
      }
      renderStructuredSummary(message.structured, message.timing);
      return;
    }

    if (message.type === "SUMMARY_ERROR") {
      showError(message.message || "An unknown summarization error occurred.");
    }
  });

  showPanel();
})();