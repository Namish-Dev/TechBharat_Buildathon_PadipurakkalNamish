// background.js — Manifest V3 service worker
// Supports:
// - OpenRouter text + vision models
// - Gemini text + vision models
// - Whole page summarization
// - Selected text summarization
// - Drawn visual-region screenshot summarization
// - Chunked map-reduce summarization for long text pages

const DEFAULT_MODELS = {
  openrouter: "google/gemma-4-26b-a4b-it:free",
  gemini: "gemini-3.5-flash"
};

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
  if (!tab?.id || !tab.url || !/^https?:\/\//.test(tab.url)) {
    return;
  }

  try {
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ["panel.css"]
    });
  } catch {
    // CSS may already be inserted.
  }

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
  if (command === "toggle-summarizer") {
    injectAndToggle(tab);
  }
});

function getCommonJsonSchema() {
  return `Return ONLY valid JSON.

Do not use markdown fences.
Do not write any explanation before or after the JSON.

Use exactly this JSON shape:
{
  "twoLineSummary": "string, maximum two sentences",
  "keyPoints": ["string"],
  "actionItems": ["string"],
  "decisions": ["string"],
  "numbers": ["string"],
  "confidence": "high",
  "confidenceReason": "string",
  "unreadableSections": ["string"]
}

Rules:
- Be faithful to the supplied source.
- Never invent facts, names, dates, numbers, decisions, or action items.
- Keep keyPoints to at most 6 short items.
- Use empty arrays when a category has no relevant content.
- confidence must be exactly "high", "medium", or "low".
- confidenceReason must explain why that confidence level was chosen.
- Every item in numbers must preserve context, for example "Revenue: ₹5 crore", never just "5 crore".
- If source content is incomplete, unreadable, vague, cropped, or ambiguous, state that in unreadableSections.`;
}

function buildTextPrompt(text, title, url) {
  return `You are summarizing a web page for a knowledge worker.

Page title: ${title}
Page URL: ${url}

${getCommonJsonSchema()}

Text-specific rules:
- Extract concrete names and numbers only when explicitly present in the text.
- Do not infer missing context.
- Keep the two-line summary focused on the actual subject, not the webpage layout.

PAGE CONTENT:
"""
${text}
"""`;
}

function buildChunkPrompt(chunkText, chunkIndex, chunkCount, title, url) {
  return `You are summarizing part ${chunkIndex} of ${chunkCount} from a web page.

Page title: ${title}
Page URL: ${url}

${getCommonJsonSchema()}

Chunk rules:
- Summarize only what is present in this chunk.
- Preserve exact numbers, names, and key claims from this chunk.
- Keep the output concise and information-dense.
- If the chunk is mostly navigation or repeated boilerplate, say so in unreadableSections.

CHUNK ${chunkIndex} OF ${chunkCount}:
"""
${chunkText}
"""`;
}

function buildReducePrompt(chunkSummaries, title, url) {
  return `You are combining chunk-level summaries into one final structured summary.

Page title: ${title}
Page URL: ${url}

${getCommonJsonSchema()}

Important combine rules:
- Use only the chunk summaries below.
- Merge duplicate points.
- Preserve exact numbers and named entities when they appear consistently across chunks.
- Prefer the most specific faithful wording supported by the chunk summaries.
- Do not invent facts that are not present in the chunk summaries.
- Keep the final summary concise and well-structured.

CHUNK SUMMARIES:
"""
${chunkSummaries}
"""`;
}

function buildImagePrompt(title, url) {
  return `You are analyzing a user-selected screenshot region from a webpage.

Page title: ${title}
Page URL: ${url}

The screenshot may contain Telugu, English, other Indian languages, news thumbnails, charts, tables, dashboards, scanned text, or article content.

${getCommonJsonSchema()}

Visual-summary rules:
- Only report information directly visible.
- Do not reconstruct cropped or partially hidden headlines.
- If a headline cannot be read completely, summarize its topic rather than inferring missing details.
- Prefer broader categories over specific names or numbers when visibility is limited.
- If a monetary value, person's name, or statistic is not fully legible, omit it rather than guessing.
- Never invent English transliterations of Telugu names.
- Never guess missing Telugu words.
- Do not begin with "This screenshot shows" or "This page contains".
- Do not describe the grid/layout unless that is directly relevant.
- Keep keyPoints to at most 6 short items.
- Every number must include clear context. Do not return a number by itself.
- Screenshot confidence should normally be medium or low.

Before returning the summary, self-check:
For every named person, number, location, organization, monetary value, event, statistic, and specific claim:
Can this be clearly read from the screenshot?
If no: remove it or replace it with a broader topic-level description.`;
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
    throw new Error(
      `OpenRouter request failed (${response.status}): ${errorText.slice(0, 250)}`
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let fullText = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) {
        continue;
      }

      const data = line.slice(6).trim();

      if (!data || data === "[DONE]") {
        continue;
      }

      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content;

        if (delta) {
          fullText += delta;
          onChunk(delta, fullText);
        }
      } catch {
        // Ignore partial SSE fragments.
      }
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
      contents: [
        {
          role: "user",
          parts
        }
      ]
    })
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

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) {
        continue;
      }

      const data = line.slice(6).trim();

      if (!data) {
        continue;
      }

      try {
        const parsed = JSON.parse(data);
        const delta =
          parsed.candidates?.[0]?.content?.parts
            ?.map((part) => part.text || "")
            .join("") || "";

        if (delta) {
          fullText += delta;
          onChunk(delta, fullText);
        }
      } catch {
        // Ignore partial SSE fragments.
      }
    }
  }

  return fullText;
}

function parseStructuredSummary(fullText) {
  const cleaned = fullText.replace(/```json/gi, "").replace(/```/g, "").trim();

  const jsonStart = cleaned.indexOf("{");
  const jsonEnd = cleaned.lastIndexOf("}");

  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
    throw new Error("No valid JSON object found in the model response.");
  }

  return JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1));
}

function normalizeTextSummary(summary) {
  const confidenceValues = ["high", "medium", "low"];

  return {
    twoLineSummary:
      typeof summary.twoLineSummary === "string"
        ? summary.twoLineSummary.trim()
        : "",
    keyPoints: Array.isArray(summary.keyPoints) ? summary.keyPoints : [],
    actionItems: Array.isArray(summary.actionItems) ? summary.actionItems : [],
    decisions: Array.isArray(summary.decisions) ? summary.decisions : [],
    numbers: Array.isArray(summary.numbers) ? summary.numbers : [],
    confidence: confidenceValues.includes(summary.confidence)
      ? summary.confidence
      : "medium",
    confidenceReason:
      typeof summary.confidenceReason === "string"
        ? summary.confidenceReason.trim()
        : "Confidence was estimated from the readable source content.",
    unreadableSections: Array.isArray(summary.unreadableSections)
      ? summary.unreadableSections
      : []
  };
}

function applyVisualTrustGuard(summary) {
  const normalized = normalizeTextSummary(summary);

  if (normalized.confidence === "high") {
    normalized.confidence = "medium";
  }

  const reason = normalized.confidenceReason || "";

  normalized.confidenceReason =
    `${reason} `.trim() +
    "Confidence is capped for screenshot-region summaries because visual content can be cropped, blurry, or partially unreadable.";

  if (
    !normalized.unreadableSections.some((item) =>
      String(item).toLowerCase().includes("visual")
    )
  ) {
    normalized.unreadableSections.unshift(
      "Visual-source limitation: screenshot text, labels, or details may be cropped, small, or partially unreadable."
    );
  }

  return normalized;
}

function chunkText(text, targetSize = 7000, overlap = 400) {
  const paragraphs = String(text || "")
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  const chunks = [];
  let current = "";

  function pushCurrent() {
    const trimmed = current.trim();
    if (trimmed) {
      chunks.push(trimmed);
    }
    current = "";
  }

  for (const paragraph of paragraphs) {
    const candidate =
      current.length > 0 ? `${current}\n\n${paragraph}` : paragraph;

    if (candidate.length <= targetSize) {
      current = candidate;
      continue;
    }

    if (current.trim()) {
      pushCurrent();
    }

    if (paragraph.length <= targetSize) {
      current = paragraph;
      continue;
    }

    // Hard split for very long paragraphs.
    let start = 0;
    while (start < paragraph.length) {
      const end = Math.min(start + targetSize, paragraph.length);
      chunks.push(paragraph.slice(start, end));
      start = end - overlap;
      if (start < 0) start = 0;
      if (start >= paragraph.length) break;
    }
  }

  pushCurrent();

  return chunks.length ? chunks : [String(text || "").trim()].filter(Boolean);
}

function extractChunkSummaryText(summary) {
  const points = Array.isArray(summary.keyPoints) ? summary.keyPoints : [];
  const actions = Array.isArray(summary.actionItems) ? summary.actionItems : [];
  const decisions = Array.isArray(summary.decisions) ? summary.decisions : [];
  const numbers = Array.isArray(summary.numbers) ? summary.numbers : [];

  return [
    `Summary: ${summary.twoLineSummary || ""}`,
    points.length ? `Key points:\n- ${points.join("\n- ")}` : "Key points: None",
    actions.length ? `Action items:\n- ${actions.join("\n- ")}` : "Action items: None",
    decisions.length ? `Decisions:\n- ${decisions.join("\n- ")}` : "Decisions: None",
    numbers.length ? `Numbers:\n- ${numbers.join("\n- ")}` : "Numbers: None",
    `Confidence: ${summary.confidence || "medium"}`,
    `Confidence reason: ${summary.confidenceReason || ""}`
  ].join("\n\n");
}

async function getModelSettings() {
  const { apiProvider, apiKey, apiModel } = await chrome.storage.local.get([
    "apiProvider",
    "apiKey",
    "apiModel"
  ]);

  const provider = apiProvider || "openrouter";

  if (!["openrouter", "gemini"].includes(provider)) {
    throw new Error(
      "Invalid provider. Choose OpenRouter or Gemini in extension settings."
    );
  }

  if (!apiKey?.trim()) {
    throw new Error(
      "No API key found. Open extension settings, paste your API key, and save."
    );
  }

  return {
    provider,
    apiKey: apiKey.trim(),
    model: apiModel?.trim() || DEFAULT_MODELS[provider]
  };
}

async function runSummary(tabId, request) {
  let settings;

  try {
    settings = await getModelSettings();
  } catch (error) {
    safeSendMessage(tabId, {
      type: "SUMMARY_ERROR",
      message: error.message
    });
    return;
  }

  safeSendMessage(tabId, {
    type: "SUMMARY_START"
  });

  const onChunk = (chunk, fullText) => {
    safeSendMessage(tabId, {
      type: "SUMMARY_STREAM",
      chunk,
      fullText
    });
  };

  let fullText = "";

  try {
    if (settings.provider === "openrouter") {
      fullText = await streamOpenRouter(
        settings.apiKey,
        settings.model,
        request.openRouterMessages,
        onChunk
      );
    } else {
      fullText = await streamGemini(
        settings.apiKey,
        settings.model,
        request.geminiParts,
        onChunk
      );
    }
  } catch (error) {
    safeSendMessage(tabId, {
      type: "SUMMARY_ERROR",
      message: error.message || "The model request failed."
    });
    return;
  }

  try {
    const parsedSummary = parseStructuredSummary(fullText);

    const structured =
      request.captureMode === "region"
        ? applyVisualTrustGuard(parsedSummary)
        : normalizeTextSummary(parsedSummary);

    safeSendMessage(tabId, {
      type: "SUMMARY_DONE",
      structured
    });
  } catch {
    safeSendMessage(tabId, {
      type: "SUMMARY_ERROR",
      message:
        "The model returned an invalid structured response. Try again or select another model.",
      rawText: fullText
    });
  }
}

async function summarizeText(tabId, payload) {
  const { pageText, title, url, captureMode } = payload;

  if (!pageText || pageText.trim().length < 20) {
    safeSendMessage(tabId, {
      type: "SUMMARY_ERROR",
      message:
        "Could not find readable text on this page. Try Summarize visual region for image-based content."
    });
    return;
  }

  const chunks = chunkText(pageText, 7000, 400);

  if (chunks.length <= 1) {
    const prompt = buildTextPrompt(pageText, title, url);

    await runSummary(tabId, {
      captureMode: captureMode || "page",
      openRouterMessages: [
        {
          role: "user",
          content: prompt
        }
      ],
      geminiParts: [
        {
          text: prompt
        }
      ]
    });

    return;
  }

  safeSendMessage(tabId, {
    type: "SUMMARY_STATUS",
    message: `Splitting long text into ${chunks.length} chunks...`
  });

  const chunkSummaries = [];

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const chunkIndex = i + 1;
    const prompt = buildChunkPrompt(chunk, chunkIndex, chunks.length, title, url);

    safeSendMessage(tabId, {
      type: "SUMMARY_STATUS",
      message: `Summarizing chunk ${chunkIndex} of ${chunks.length}...`
    });

    let chunkRaw = "";

    if ((await getModelSettings()).provider === "openrouter") {
      chunkRaw = await streamOpenRouter(
        (await getModelSettings()).apiKey,
        (await getModelSettings()).model,
        [
          {
            role: "user",
            content: prompt
          }
        ],
        () => {}
      );
    } else {
      chunkRaw = await streamGemini(
        (await getModelSettings()).apiKey,
        (await getModelSettings()).model,
        [
          {
            text: prompt
          }
        ],
        () => {}
      );
    }

    const chunkParsed = normalizeTextSummary(parseStructuredSummary(chunkRaw));
    chunkSummaries.push(
      `CHUNK ${chunkIndex} OF ${chunks.length}\n` +
      extractChunkSummaryText(chunkParsed)
    );
  }

  const reducePrompt = buildReducePrompt(
    chunkSummaries.join("\n\n---\n\n"),
    title,
    url
  );

  safeSendMessage(tabId, {
    type: "SUMMARY_STATUS",
    message: "Combining chunk summaries..."
  });

  const settings = await getModelSettings();

  let combinedRaw = "";

  if (settings.provider === "openrouter") {
    combinedRaw = await streamOpenRouter(
      settings.apiKey,
      settings.model,
      [
        {
          role: "user",
          content: reducePrompt
        }
      ],
      (chunk, fullText) => {
        combinedRaw = fullText;
      }
    );
  } else {
    combinedRaw = await streamGemini(
      settings.apiKey,
      settings.model,
      [
        {
          text: reducePrompt
        }
      ],
      (chunk, fullText) => {
        combinedRaw = fullText;
      }
    );
  }

  try {
    const parsedSummary = parseStructuredSummary(combinedRaw);

    safeSendMessage(tabId, {
      type: "SUMMARY_DONE",
      structured: normalizeTextSummary(parsedSummary)
    });
  } catch {
    safeSendMessage(tabId, {
      type: "SUMMARY_ERROR",
      message:
        "The final combined response could not be parsed as JSON.",
      rawText: combinedRaw
    });
  }
}

async function captureRegion(sender, payload) {
  const tabId = sender.tab?.id;
  const windowId = sender.tab?.windowId;

  if (!tabId || windowId === undefined) {
    return;
  }

  try {
    const screenshotDataUrl = await chrome.tabs.captureVisibleTab(
      windowId,
      {
        format: "png"
      }
    );

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

  const base64Data = imageDataUrl.split(",")[1];

  if (!base64Data) {
    safeSendMessage(tabId, {
      type: "SUMMARY_ERROR",
      message: "The selected screenshot image is invalid."
    });
    return;
  }

  const prompt = buildImagePrompt(title, url);

  const settings = await getModelSettings();

  if (settings.provider === "openrouter") {
    await runSummary(tabId, {
      captureMode: "region",
      openRouterMessages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: prompt
            },
            {
              type: "image_url",
              image_url: {
                url: imageDataUrl
              }
            }
          ]
        }
      ],
      geminiParts: [
        {
          text: prompt
        },
        {
          inline_data: {
            mime_type: mimeType,
            data: base64Data
          }
        }
      ]
    });
  } else {
    await runSummary(tabId, {
      captureMode: "region",
      openRouterMessages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: prompt
            },
            {
              type: "image_url",
              image_url: {
                url: imageDataUrl
              }
            }
          ]
        }
      ],
      geminiParts: [
        {
          text: prompt
        },
        {
          inline_data: {
            mime_type: mimeType,
            data: base64Data
          }
        }
      ]
    });
  }
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === "SUMMARIZE_PAGE" && sender.tab?.id) {
    summarizeText(sender.tab.id, message.payload);
  }

  if (message.type === "CAPTURE_REGION") {
    captureRegion(sender, message.payload);
  }

  if (message.type === "SUMMARIZE_IMAGE" && sender.tab?.id) {
    summarizeImage(sender.tab.id, message.payload);
  }
});