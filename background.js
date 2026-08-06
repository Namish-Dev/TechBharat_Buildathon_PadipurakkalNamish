// background.js — fast, simplified MV3 service worker
// - Single-pass text summarization for normal pages
// - Domain-aware prompts
// - Visual region summarization kept
// - PDF fallback kept honest
// - No chunking pipeline

const DEFAULT_MODELS = {
  openrouter: "google/gemma-4-a4b-it:free",
  gemini: "gemini-3.5-flash"
};

function safeSendMessage(tabId, message) {
  chrome.tabs.sendMessage(tabId, message, () => {
    if (chrome.runtime.lastError) {
      console.warn("Inline Summarizer message was not delivered:", chrome.runtime.lastError.message);
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
- If content is partial or unclear, say so in unreadableSections.`;
}

function buildGenericPrompt(text, title, url) {
  return `You are summarizing a web page for a knowledge worker.

Page title: ${title}
Page URL: ${url}

${getSchema()}

PAGE CONTENT:
"""
${text}
"""`;
}

function buildGitHubPrPrompt(text, title, url) {
  return `You are summarizing a GitHub pull request for a reviewer.

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
  return `You are summarizing a Gmail thread.

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
  return `You are summarizing a Jira page or board.

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
  return `You are summarizing a PDF document.

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
  return `You are analyzing a screenshot region from a webpage.

Page title: ${title}
Page URL: ${url}

${getSchema()}

Visual rules:
- Only report what is directly visible.
- Do not guess cropped or blurry names or numbers.
- Prefer broader topics when visibility is limited.

SCREENSHOT REGION`;
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
    twoLineSummary: typeof summary.twoLineSummary === "string" ? summary.twoLineSummary.trim() : "",
    keyPoints: Array.isArray(summary.keyPoints) ? summary.keyPoints : [],
    actionItems: Array.isArray(summary.actionItems) ? summary.actionItems : [],
    decisions: Array.isArray(summary.decisions) ? summary.decisions : [],
    numbers: Array.isArray(summary.numbers) ? summary.numbers : [],
    confidence: allowed.includes(summary.confidence) ? summary.confidence : "medium",
    confidenceReason: typeof summary.confidenceReason === "string" ? summary.confidenceReason.trim() : "",
    unreadableSections: Array.isArray(summary.unreadableSections) ? summary.unreadableSections : []
  };
}

function capVisual(summary) {
  const s = normalizeSummary(summary);
  if (s.confidence === "high") s.confidence = "medium";
  if (!s.unreadableSections.some((x) => String(x).toLowerCase().includes("visual"))) {
    s.unreadableSections.unshift("Visual-source limitation: screenshot text or labels may be cropped, small, or partially unreadable.");
  }
  if (!s.confidenceReason) {
    s.confidenceReason = "Confidence capped because the source is a screenshot region.";
  }
  return s;
}

function parseJsonFromText(text) {
  const cleaned = String(text || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object found in model response.");
  }
  return JSON.parse(cleaned.slice(start, end + 1));
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

  return {
    provider,
    apiKey: apiKey.trim(),
    model: apiModel?.trim() || DEFAULT_MODELS[provider]
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
      messages
    })
  });

  if (!response.ok || !response.body) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`OpenRouter request failed (${response.status}): ${errorText.slice(0, 250)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (!data || data === "[DONE]") continue;

      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          fullText += delta;
          onChunk(delta, fullText);
        }
      } catch {}
    }
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
      contents: [{ role: "user", parts }]
    })
  });

  if (!response.ok || !response.body) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Gemini request failed (${response.status}): ${errorText.slice(0, 250)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (!data) continue;

      try {
        const parsed = JSON.parse(data);
        const delta =
          parsed.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
        if (delta) {
          fullText += delta;
          onChunk(delta, fullText);
        }
      } catch {}
    }
  }

  return fullText;
}

async function summarizeTextOnce(tabId, text, title, url, domain) {
  const settings = await getModelSettings();

  let prompt;
  if (domain === "github_pr") prompt = buildGitHubPrPrompt(text, title, url);
  else if (domain === "gmail_thread") prompt = buildGmailPrompt(text, title, url);
  else if (domain === "jira") prompt = buildJiraPrompt(text, title, url);
  else if (domain === "pdf") prompt = buildPdfPrompt(text, title, url);
  else prompt = buildGenericPrompt(text, title, url);

  safeSendMessage(tabId, { type: "SUMMARY_START" });

  let raw = "";
  if (settings.provider === "openrouter") {
    raw = await streamOpenRouter(
      settings.apiKey,
      settings.model,
      [{ role: "user", content: prompt }],
      (_, fullText) => {
        raw = fullText;
      }
    );
  } else {
    raw = await streamGemini(
      settings.apiKey,
      settings.model,
      [{ text: prompt }],
      (_, fullText) => {
        raw = fullText;
      }
    );
  }

  const parsed = normalizeSummary(parseJsonFromText(raw));
  safeSendMessage(tabId, { type: "SUMMARY_DONE", structured: parsed });
}

async function summarizePage(tabId, payload, senderTabUrl) {
  const text = payload.pageText || "";
  const title = payload.title || "";
  const url = payload.url || senderTabUrl || "";
  const domain = detectDomain(payload.domainHint || url);

  if (domain === "pdf" || isPdfLikePage(url)) {
    safeSendMessage(tabId, {
      type: "SUMMARY_ERROR",
      message: "This looks like a PDF, but PDF text extraction is not yet bundled. Use visual region capture for now."
    });
    return;
  }

  if (!text || text.trim().length < 20) {
    safeSendMessage(tabId, {
      type: "SUMMARY_ERROR",
      message: "Could not find readable text on this page. Try Summarize visual region for image-based content."
    });
    return;
  }

  try {
    await summarizeTextOnce(tabId, text, title, url, domain);
  } catch (error) {
    safeSendMessage(tabId, {
      type: "SUMMARY_ERROR",
      message: error.message || "The model request failed."
    });
  }
}

async function captureRegion(sender, payload) {
  const tabId = sender.tab?.id;
  const windowId = sender.tab?.windowId;
  if (!tabId || windowId === undefined) return;

  try {
    const screenshotDataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    safeSendMessage(tabId, {
      type: "REGION_SCREENSHOT",
      screenshotDataUrl,
      rect: payload.rect
    });
  } catch {
    safeSendMessage(tabId, {
      type: "SUMMARY_ERROR",
      message: "Could not capture the selected region. Ensure the page is active, then try again."
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
  let raw = "";

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
        (_, fullText) => {
          raw = fullText;
        }
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
        (_, fullText) => {
          raw = fullText;
        }
      );
    }

    const parsed = normalizeSummary(parseJsonFromText(raw));
    safeSendMessage(tabId, { type: "SUMMARY_DONE", structured: capVisual(parsed) });
  } catch (error) {
    safeSendMessage(tabId, {
      type: "SUMMARY_ERROR",
      message: error.message || "The visual summary request failed."
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