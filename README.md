# Inline Summarizer

Inline Summarizer is a Chrome Manifest V3 extension that summarizes a web page, a text selection, or a user-drawn screenshot region without leaving the current tab. It supports OpenRouter and Google Gemini, streams results into an in-page panel, and can copy or export the final summary as Markdown.

## What it does

- Summarizes the visible page text.
- Summarizes only the currently selected text.
- Lets you drag-select a visual region for screenshot-based summarization.
- Streams partial model output while the request is running.
- Produces a structured summary with key points, action items, decisions, numbers, unreadable sections, and confidence.
- Copies the summary to the clipboard or exports it as a `.md` file.

## Project Structure

- [manifest.json](manifest.json) - Extension metadata, permissions, action button, keyboard shortcut, and options page registration.
- [background.js](background.js) - Service worker that injects the content script, reads saved settings, calls OpenRouter or Gemini, chunks long text, and coordinates summarization.
- [content.js](content.js) - In-page panel UI, text-selection handling, screenshot region selection, result rendering, copy/export actions, and streaming display.
- [options.html](options.html) - Settings page UI for provider, API key, and model selection.
- [options.js](options.js) - Loads and saves settings in `chrome.storage.local`.
- [panel.css](panel.css) - Reserved for page-level styles outside the Shadow DOM panel.
- [icons/](icons/) - Extension icons used by the toolbar action and manifest.

## Requirements

- Google Chrome or another Chromium-based browser with Manifest V3 support.
- An OpenRouter API key or a Google Gemini API key.
- A model name supported by the provider you choose.

## Installation

1. Open your browser’s Extensions page.
2. Enable Developer mode.
3. Choose Load unpacked and select this folder.
4. Open the extension’s Options page and save your provider, API key, and model.

## Usage

### Open the panel

- Click the extension icon in the toolbar, or
- Press `Ctrl+Shift+Y` on Windows/Linux, or `Command+Shift+Y` on macOS.

### Summarize a page

1. Open a normal `http` or `https` page.
2. Open the panel.
3. Choose Summarize page.

### Summarize selected text

1. Highlight some text on the page.
2. Open the panel.
3. Choose Summarize selection.

### Summarize a visual region

1. Open the panel.
2. Choose Summarize visual region.
3. Drag over the article, chart, table, dashboard, or image you want summarized.
4. Release to capture and summarize the cropped region.

## Settings

The options page stores settings locally in `chrome.storage.local`.

- Provider: OpenRouter or Google Gemini.
- API key: Saved only in your local browser profile.
- Model: Editable text field, so you can use any supported model name.

## Output Format

The extension asks the model to return structured JSON with these fields:

- `twoLineSummary`
- `keyPoints`
- `actionItems`
- `decisions`
- `numbers`
- `confidence`
- `confidenceReason`
- `unreadableSections`

The panel renders those fields directly and also lets you copy or export them as Markdown.

## Implementation Notes

- `background.js` streams responses from OpenRouter or Gemini and normalizes the final JSON.
- Long pages are split into chunks, summarized individually, then combined into a final summary.
- Screenshot-region summaries are treated more cautiously and capped to lower confidence because the source can be cropped or blurry.
- The content script uses a Shadow DOM panel so page CSS does not restyle the UI.
- The extension only injects on regular `http` and `https` pages.

## Permissions

The manifest requests these permissions:

- `activeTab` and `scripting` for injecting the panel and capture logic.
- `storage` for saving provider settings and API keys.
- `commands` for the keyboard shortcut.
- `clipboardWrite` for copying summaries.
- Host permissions for OpenRouter and Google Gemini API endpoints.

## Privacy

- API keys stay in your local browser profile.
- The page text or screenshot you summarize is sent to the provider you selected.
- No local backend is included in this project.

## Notes

- The extension works best on pages with readable article text.
- If a page has little or no selectable text, use Summarize visual region instead.
- If the model returns invalid JSON, the panel will show an error and let you try again.
