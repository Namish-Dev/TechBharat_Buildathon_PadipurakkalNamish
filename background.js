// background.js — fast MV3 service worker with simple streaming
// - Single-pass text summarization for normal pages
// - Domain-aware prompts (generic, GitHub PR, Gmail, Jira)
// - Visual region summarization
// - PDF fallback (no extraction)
// - Streams fullText only (no delta field)

const DEFAULT_MODELS = {
  openrouter: "google/gemini-2.0-flash-001",
  gemini: "gemini-3.5-flash"
};

const REQUEST_TIMEOUT_MS = 60000;

function safeSendMessage(tabId, message) {
  chrome.tabs.sendMessage(tabId, message, () => {
    if (chrome.runtime.lastError) {
      console.warn(
        "Inline Summarizer message was not delivered:",
        chrome.runtime.lastError.message
      );
    }
  });
}

async function injectAndToggle(tab) {
  if (!tab?.id || !tab.url || !/^https?:\/\//.test(tab.url)) return;

  try {
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ["panel.css"]
    });
  } catch {}

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
  } catch (error) {
    console.error("Inline Summarizer injection failed:", error);
  }
}

chrome.action.onClicked.addListener((tab) => {
  injectAndToggle(tab);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "toggle-summarizer") injectAndToggle(tab);
});

function getSchema() {
  return `Return ONLY valid JSON.

Use exactly this shape:
{
  "twoLineSummary": "string",
  "keyPoints": ["string"],
  "actionItems": ["string"],
  "decisions": ["string"],
  "numbers": ["string"],
  "confidence": "high" | "medium" | "low",
  "confidenceReason": "string",
  "unreadableSections": ["string"]
}

Rules:
- Be faithful.
- Do not invent.
- Keep it concise.
- In the keypoints maximum is 10 items, each under 200 characters.
- If content is partial or unclear, say so in unreadableSections.
- Specifically check whether the provided text stops abruptly mid-article — e.g. it ends with a paywall prompt, a "subscribe to continue reading" message, a truncated sentence, or a sudden shift to unrelated boilerplate (related articles, footer links, comments). If so, you MUST add an entry to unreadableSections stating that the content appears cut off by a paywall or truncation point, and only summarize what was actually provided.`;
}

function buildGenericPrompt(text, title, url) {
  return `Summarize the following page faithfully for a knowledge worker.

Title: ${title}
URL: ${url}

${getSchema()}

PAGE CONTENT:
"""
${text}
"""`;
}

function buildGitHubPrPrompt(text, title, url) {
  return `Summarize the following GitHub pull request for a reviewer.

PR title: ${title}
PR URL: ${url}

${getSchema()}

GitHub PR rules:
- Summarize what changed, risk, review concerns, tests, and likely impact.
- Prefer code-review language.
- Do not invent code details.

PR CONTENT:
"""
${text}
"""`;
}

function buildGmailPrompt(text, title, url) {
  return `Summarize the following Gmail thread.

Thread title: ${title}
Thread URL: ${url}

${getSchema()}

Gmail rules:
- Summarize the purpose, status, action items, deadlines, and required response.
- Do not invent names or commitments.

EMAIL THREAD:
"""
${text}
"""`;
}

function buildJiraPrompt(text, title, url) {
  return `Summarize the following Jira page or board.

Page title: ${title}
Page URL: ${url}

${getSchema()}

Jira rules:
- Summarize work items, status, blockers, owners, and next steps.
- If it is a board, summarize the overall state.
- Do not invent ticket numbers or statuses.

JIRA CONTENT:
"""
${text}
"""`;
}

function buildPdfPrompt(text, title, url) {
  return `Summarize the following PDF document.

Document title: ${title}
Document URL: ${url}

${getSchema()}

PDF rules:
- Summarize section structure, main ideas, and conclusions.
- If the extracted text is partial, state that.
- Do not hallucinate figures, equations, or tables.

PDF TEXT:
"""
${text}
"""`;
}

function buildImagePrompt(title, url) {
  return `Summarize the visible content of this screenshot region.

Page title: ${title}
Page URL: ${url}

${getSchema()}

Visual rules:
- Only report what is directly visible.
- Prefer broader topics when visibility is limited.`;
}

function detectDomain(url) {
  const lower = String(url || "").toLowerCase();
  if (lower.endsWith(".pdf") || lower.includes(".pdf?")) return "pdf";
  if (lower.includes("github.com") && lower.includes("/pull/")) return "github_pr";
  if (lower.includes("mail.google.com")) return "gmail_thread";
  if (lower.includes("jira.") || lower.includes("/browse/") || lower.includes("/jira")) return "jira";
  return "generic";
}

function isPdfLikePage(url) {
  return /\.pdf($|\?)/i.test(String(url || ""));
}

function normalizeSummary(summary) {
  const allowed = ["high", "medium", "low"];

  return {
    twoLineSummary:
      typeof summary.twoLineSummary === "string"
        ? summary.twoLineSummary.trim()
        : "",
    keyPoints: Array.isArray(summary.keyPoints) ? summary.keyPoints : [],
    actionItems: Array.isArray(summary.actionItems) ? summary.actionItems : [],
    decisions: Array.isArray(summary.decisions) ? summary.decisions : [],
    numbers: Array.isArray(summary.numbers) ? summary.numbers : [],
    confidence: allowed.includes(summary.confidence)
      ? summary.confidence
      : "medium",
    confidenceReason:
      typeof summary.confidenceReason === "string"
        ? summary.confidenceReason.trim()
        : "",
    unreadableSections: Array.isArray(summary.unreadableSections)
      ? summary.unreadableSections
      : []
  };
}

function capVisual(summary) {
  const s = normalizeSummary(summary);
  if (s.confidence === "high") s.confidence = "medium";
  if (
    !s.unreadableSections.some((x) =>
      String(x).toLowerCase().includes("visual")
    )
  ) {
    s.unreadableSections.unshift(
      "Visual-source limitation: screenshot text or labels may be cropped, small, or partially unreadable."
    );
  }
  if (!s.confidenceReason) {
    s.confidenceReason = "Confidence capped because the source is a screenshot region.";
  }
  return s;
}

const KNOWN_GEMINI_MODELS = {
  "gemini-3.5-flash": "gemini-2.5-flash",
  "gemini-3.6-flash": "gemini-2.5-flash",
  "gemini-3.0-flash": "gemini-2.5-flash",
  "gemini-3.5-pro": "gemini-1.5-pro"
};

function normalizeModelName(provider, model) {
  if (!model) return DEFAULT_MODELS[provider];
  const trimmed = model.trim();
  if (provider === "gemini" && KNOWN_GEMINI_MODELS[trimmed.toLowerCase()]) {
    return KNOWN_GEMINI_MODELS[trimmed.toLowerCase()];
  }
  return trimmed;
}

function parseJsonFromText(text) {
  const cleaned = String(text || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const start = cleaned.indexOf("{");
  if (start === -1) {
    throw new Error("No JSON object found in model response.");
  }

  let lastIndex = cleaned.length;
  while (true) {
    const end = cleaned.lastIndexOf("}", lastIndex);
    if (end === -1 || end <= start) break;

    const candidate = cleaned.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch (e) {
      lastIndex = end - 1;
    }
  }

  const sanitized = cleaned.slice(start)
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
    .replace(/,\s*([\}\]])/g, "$1");

  lastIndex = sanitized.length;
  while (true) {
    const end = sanitized.lastIndexOf("}", lastIndex);
    if (end === -1 || end <= 0) break;

    const candidate = sanitized.slice(0, end + 1);
    try {
      return JSON.parse(candidate);
    } catch (e) {
      lastIndex = end - 1;
    }
  }

  throw new Error("Could not parse valid JSON from model response.");
}

// Some providers/proxies keep the HTTP stream open for a while after the
// model has actually finished emitting the JSON — sitting in the read loop
// waiting for a formal "done" from the connection can hang the whole
// request even though nothing has actually failed. This lets us detect
// completion from the CONTENT itself and stop reading early, instead of
// depending on the connection to close.
function looksJsonComplete(text) {
  const trimmed = String(text || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
  if (!trimmed.endsWith("}")) return false;
  try {
    const parsed = parseJsonFromText(trimmed);
    return !!parsed && typeof parsed === "object" && "twoLineSummary" in parsed;
  } catch {
    return false;
  }
}

async function getModelSettings() {
  const { apiProvider, apiKey, apiModel } = await chrome.storage.local.get([
    "apiProvider",
    "apiKey",
    "apiModel"
  ]);

  const provider = apiProvider || "openrouter";

  if (!["openrouter", "gemini"].includes(provider)) {
    throw new Error("Invalid provider. Choose OpenRouter or Gemini in extension settings.");
  }
  if (!apiKey?.trim()) {
    throw new Error("No API key found. Open extension settings, paste your API key, and save.");
  }

  const rawModel = apiModel?.trim() || DEFAULT_MODELS[provider];

  return {
    provider,
    apiKey: apiKey.trim(),
    model: normalizeModelName(provider, rawModel)
  };
}

async function streamOpenRouter(apiKey, model, messages, onChunk) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://inline-summarizer.local",
      "X-Title": "Inline Summarizer"
    },
    body: JSON.stringify({
      model,
      stream: true,
      temperature: 0.2,
      messages
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  if (!response.ok || !response.body) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `OpenRouter request failed (${response.status}): ${errorText.slice(0, 250)}`
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let buffer = "";
  let completed = false;

  const processDataPayload = (data) => {
    if (!data || data === "[DONE]") return;
    try {
      const parsed = JSON.parse(data);
      const delta = parsed.choices?.[0]?.delta?.content || "";
      if (delta) {
        fullText += delta;
        onChunk(fullText);
        if (!completed && looksJsonComplete(fullText)) {
          completed = true;
        }
      }
    } catch {}
  };

  readLoop: while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() || "";

    for (const part of parts) {
      const lines = part.split(/\r?\n/);
      const dataLines = [];
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          dataLines.push(line.slice(6));
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5));
        }
      }
      // SSE spec: multiple "data:" lines in one event are joined with "\n",
      // not concatenated directly - otherwise multi-line JSON gets corrupted.
      processDataPayload(dataLines.join("\n").trim());
      if (completed) break readLoop;
    }
  }

  if (!completed && buffer.trim()) {
    const lines = buffer.split(/\r?\n/);
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith("data: ")) dataLines.push(line.slice(6));
      else if (line.startsWith("data:")) dataLines.push(line.slice(5));
    }
    processDataPayload(dataLines.join("\n").trim());
  }

  if (completed) {
    // Stop reading immediately rather than waiting for the server to close
    // the connection - the content is already complete.
    try {
      await reader.cancel();
    } catch {}
  }

  return fullText;
}

async function streamGemini(apiKey, model, parts, onChunk) {
  const endpoint =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    `${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      systemInstruction: {
        parts: [{ text: "You are an instant AI summarizer. Return ONLY valid JSON." }]
      },
      generationConfig: {
        temperature: 0.2,
        // Gemini 2.5 Flash runs an internal "thinking" pass by default before
        // it emits any visible output — those reasoning tokens are what was
        // eating 8-10s of TTFT. Setting the budget to 0 disables it so the
        // model starts streaming the answer immediately.
        thinkingConfig: { thinkingBudget: 0 }
      }
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  if (!response.ok || !response.body) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Gemini request failed (${response.status}): ${errorText.slice(0, 250)}`
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let buffer = "";
  let completed = false;

  const processDataPayload = (data) => {
    if (!data) return;
    try {
      const parsed = JSON.parse(data);
      const delta =
        parsed.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
      if (delta) {
        fullText += delta;
        onChunk(fullText);
        if (!completed && looksJsonComplete(fullText)) {
          completed = true;
        }
      }
    } catch {}
  };

  readLoop: while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() || "";

    for (const part of parts) {
      const lines = part.split(/\r?\n/);
      const dataLines = [];
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          dataLines.push(line.slice(6));
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5));
        }
      }
      // SSE spec: multiple "data:" lines in one event are joined with "\n",
      // not concatenated directly - otherwise multi-line JSON gets corrupted.
      processDataPayload(dataLines.join("\n").trim());
      if (completed) break readLoop;
    }
  }

  if (!completed && buffer.trim()) {
    const lines = buffer.split(/\r?\n/);
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith("data: ")) dataLines.push(line.slice(6));
      else if (line.startsWith("data:")) dataLines.push(line.slice(5));
    }
    processDataPayload(dataLines.join("\n").trim());
  }

  if (completed) {
    try {
      await reader.cancel();
    } catch {}
  }

  return fullText;
}

function friendlyErrorMessage(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") {
    return "The model did not respond within 60 seconds. Try again or switch models.";
  }
  return error?.message || "The model request failed.";
}

async function summarizeTextOnce(tabId, text, title, url, domain) {
  const settings = await getModelSettings();

  let prompt;
  if (domain === "github_pr") prompt = buildGitHubPrPrompt(text, title, url);
  else if (domain === "gmail_thread") prompt = buildGmailPrompt(text, title, url);
  else if (domain === "jira") prompt = buildJiraPrompt(text, title, url);
  else if (domain === "pdf") prompt = buildPdfPrompt(text, title, url);
  else prompt = buildGenericPrompt(text, title, url);

  const startTime = Date.now();
  let firstTokenTime = null;

  console.log(`[Inline Summarizer TTFT Debug] 🚀 Sent request to provider '${settings.provider}' using model '${settings.model}' at ${new Date(startTime).toLocaleTimeString()}.${startTime % 1000}`);

  safeSendMessage(tabId, { type: "SUMMARY_START", startTime, model: settings.model });

  let raw = "";

  const onChunk = (fullText) => {
    raw = fullText;
    if (!firstTokenTime) {
      firstTokenTime = Date.now();
      const ttftMs = firstTokenTime - startTime;
      console.log(`[Inline Summarizer TTFT Debug] ⚡ 1ST TOKEN ARRIVED! TTFT = ${ttftMs}ms (${(ttftMs / 1000).toFixed(2)}s) for model '${settings.model}'`);
      safeSendMessage(tabId, {
        type: "FIRST_TOKEN_TIMING",
        ttftMs,
        model: settings.model
      });
    }

    safeSendMessage(tabId, {
      type: "SUMMARY_STREAM",
      fullText
    });
  };

  try {
    if (settings.provider === "openrouter") {
      raw = await streamOpenRouter(
        settings.apiKey,
        settings.model,
        [{ role: "user", content: prompt }],
        onChunk
      );
    } else {
      raw = await streamGemini(
        settings.apiKey,
        settings.model,
        [{ text: prompt }],
        onChunk
      );
    }

    const totalMs = Date.now() - startTime;
    const ttftMs = firstTokenTime ? (firstTokenTime - startTime) : totalMs;
    console.log(`[Inline Summarizer TTFT Debug] ✅ SUMMARY COMPLETED! Total time: ${totalMs}ms (${(totalMs / 1000).toFixed(2)}s), TTFT: ${ttftMs}ms (${(ttftMs / 1000).toFixed(2)}s).`);

    const parsed = normalizeSummary(parseJsonFromText(raw));

    safeSendMessage(tabId, {
      type: "SUMMARY_DONE",
      structured: parsed,
      timing: {
        ttftMs,
        totalMs,
        model: settings.model
      }
    });
  } catch (error) {
    safeSendMessage(tabId, {
      type: "SUMMARY_ERROR",
      message: friendlyErrorMessage(error)
    });
  }
}

async function summarizePage(tabId, payload, senderTabUrl) {
  const text = payload.pageText || "";
  const title = payload.title || "";
  const url = payload.url || senderTabUrl || "";
  const domain = detectDomain(payload.domainHint || url);

  if (domain === "pdf" || isPdfLikePage(url)) {
    safeSendMessage(tabId, {
      type: "SUMMARY_ERROR",
      message:
        "This looks like a PDF, but PDF text extraction is not yet bundled. Use visual region capture for now."
    });
    return;
  }

  if (!text || text.trim().length < 20) {
    safeSendMessage(tabId, {
      type: "SUMMARY_ERROR",
      message:
        "Could not find readable text on this page. Try Summarize visual region for image-based content."
    });
    return;
  }

  await summarizeTextOnce(tabId, text, title, url, domain);
}

async function captureRegion(sender, payload) {
  const tabId = sender.tab?.id;
  const windowId = sender.tab?.windowId;
  if (!tabId || windowId === undefined) return;

  try {
    const screenshotDataUrl = await chrome.tabs.captureVisibleTab(windowId, {
      format: "png"
    });

    safeSendMessage(tabId, {
      type: "REGION_SCREENSHOT",
      screenshotDataUrl,
      rect: payload.rect
    });
  } catch {
    safeSendMessage(tabId, {
      type: "SUMMARY_ERROR",
      message:
        "Could not capture the selected region. Ensure the page is active, then try again."
    });
  }
}

async function summarizeImage(tabId, payload) {
  const { imageDataUrl, mimeType = "image/png", title, url } = payload;

  if (!imageDataUrl?.startsWith("data:image/")) {
    safeSendMessage(tabId, {
      type: "SUMMARY_ERROR",
      message: "The selected region could not be converted into an image."
    });
    return;
  }

  const settings = await getModelSettings();
  const prompt = buildImagePrompt(title, url);

  safeSendMessage(tabId, { type: "SUMMARY_START" });

  let raw = "";

  const onChunk = (fullText) => {
    raw = fullText;
    safeSendMessage(tabId, {
      type: "SUMMARY_STREAM",
      fullText
    });
  };

  try {
    if (settings.provider === "openrouter") {
      raw = await streamOpenRouter(
        settings.apiKey,
        settings.model,
        [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: imageDataUrl } }
          ]
        }],
        onChunk
      );
    } else {
      const base64Data = imageDataUrl.split(",")[1];
      raw = await streamGemini(
        settings.apiKey,
        settings.model,
        [
          { text: prompt },
          { inline_data: { mime_type: mimeType, data: base64Data } }
        ],
        onChunk
      );
    }

    const parsed = normalizeSummary(parseJsonFromText(raw));
    const capped = capVisual(parsed);

    safeSendMessage(tabId, {
      type: "SUMMARY_DONE",
      structured: capped
    });
  } catch (error) {
    safeSendMessage(tabId, {
      type: "SUMMARY_ERROR",
      message: friendlyErrorMessage(error)
    });
  }
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === "SUMMARIZE_PAGE" && sender.tab?.id) {
    summarizePage(sender.tab.id, message.payload, sender.tab.url || "");
  }

  if (message.type === "CAPTURE_REGION") {
    captureRegion(sender, message.payload);
  }

  if (message.type === "SUMMARIZE_IMAGE" && sender.tab?.id) {
    summarizeImage(sender.tab.id, message.payload);
  }
});