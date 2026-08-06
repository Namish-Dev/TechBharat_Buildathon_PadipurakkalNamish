# Inline Summarizer

Inline Summarizer is a Chromium Manifest V3 extension that captures and summarizes page content in-place. It supports text and visual-region summarization, domain-aware prompts (GitHub PRs, Gmail threads, Jira pages, PDFs), PDF extraction via an offscreen document, streaming model output, and follow-up Q&A against the last captured content.

## Key features

- Capture modes: full page, selection, visual region (screenshot), and PDF extraction.
- Domain-aware prompts for better summaries on GitHub PRs, Gmail threads, Jira, and PDFs.
- Streaming display of partial model output while the model responds.
- Structured JSON summaries with `twoLineSummary`, `keyPoints`, `actionItems`, `decisions`, `numbers`, `confidence`, `confidenceReason`, and `unreadableSections`.
- Follow-up Q&A: ask questions about the last captured content without re-capturing.
- Export summary as Markdown or copy to clipboard.

## Project layout

- [manifest.json](manifest.json) - Extension metadata and permissions.
- [background.js](background.js) - Service worker: model integration, streaming, PDF offscreen orchestration, follow-up context storage.
- [content.js](content.js) - In-page UI panel, capture logic (page/selection/region/PDF), and follow-up chat UI.
- [offscreen.html](offscreen.html) & [offscreen.js](offscreen.js) - Offscreen document for PDF text extraction using `pdfjs-dist`.
- [options.html](options.html) & [options.js](options.js) - Settings page for provider, API key, and model.
- [panel.css](panel.css) - Host-page stylesheet (the panel itself uses Shadow DOM styles).
- [icons/](icons/) - Toolbar and extension icons.
- [pdf.min.mjs](pdf.min.mjs), [pdf.worker.min.mjs](pdf.worker.min.mjs) - Bundled PDF runtime used by the offscreen document.

## Requirements

- Chromium-based browser with Manifest V3 (Chrome, Edge, Brave, etc.).
- An API key for either OpenRouter or Google Gemini (set in Options).

Optional for development:

- Node/npm to install `pdfjs-dist` if you change the PDF extraction build: `npm install` will populate dependencies listed in `package.json`.

## Installation (user)

1. Open the browser Extensions page.
2. Enable Developer mode.
3. Click "Load unpacked" and select this folder.
4. Go to the extension Options page and add your API key and model, then save.

## Quick usage

- Open the panel by clicking the extension icon or pressing `Ctrl+Shift+Y` (Windows/Linux) / `Command+Shift+Y` (macOS).
- Choose `Summarize page`, `Summarize selection`, `Summarize visual region`, or `Summarize PDF` depending on the content type.
- While the model runs, partial tokens appear in the panel; final structured JSON is rendered when complete.
- Use the follow-up input to ask short questions about the last captured content (e.g., "what did it say about pricing?").

## Settings

- Provider: `openrouter` or `gemini`.
- API key: stored locally in `chrome.storage.local`.
- Model: enter the model ID supported by the provider.

## Permissions and privacy

- Requested permissions: `activeTab`, `scripting`, `storage`, `commands`, `clipboardWrite`, and `offscreen` (for PDF extraction).
- Host permissions for the model endpoints are declared in the manifest.
- API keys are stored locally in the browser profile; summarized page text or screenshots are sent to the provider you selected.

## Developer notes

- PDF extraction: `offscreen.js` runs inside an offscreen document and uses `pdfjs-dist`. The repo bundles `pdf.min.mjs` and `pdf.worker.min.mjs`, but if you rebuild or update, run:

```powershell
npm install
```

- Follow-up Q&A: the service worker saves the last captured summary to `chrome.storage.session` so the user can ask follow-ups without re-capturing. Stored context is cleaned when a tab closes.
- Request timeout: streaming requests use a timeout to avoid hanging on very slow models.

## Troubleshooting

- If the panel reports "No API key found", open Options and paste your provider key, then save.
- If PDF extraction fails, try opening the PDF directly in the tab (same origin) or use visual-region capture.
- If the model returns invalid JSON, the panel shows the raw text and an error — try switching models in Options.

## Where to look in the code

- Capture & UI: [content.js](content.js)
- Model integration, streaming, follow-up logic, PDF orchestration: [background.js](background.js)
- PDF extraction worker: [offscreen.js](offscreen.js)
- Settings UI: [options.html](options.html) and [options.js](options.js)

## **Notes**

- We recommend Gemini models for summarization because they typically provide lower latency in this application.
- The **Summarize Visual Region** feature requires a Vision Language Model (VLM).
- Translation and document structuring quality depend on the selected LLM. In general, more capable models produce higher-quality results.
