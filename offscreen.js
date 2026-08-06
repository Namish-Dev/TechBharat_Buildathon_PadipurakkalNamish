import * as pdfjsLib from "./pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("pdf.worker.min.mjs");

function toArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data;
  if (data?.buffer instanceof ArrayBuffer) return data.buffer;
  return null;
}

async function extractPdfText(arrayBuffer) {
  const loadingTask = pdfjsLib.getDocument({
    data: arrayBuffer,
    useWorkerFetch: false
  });

  const pdf = await loadingTask.promise;
  const pageTexts = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();

    const text = content.items
      .map((item) => (item.str || "").trim())
      .filter(Boolean)
      .join(" ");

    if (text.trim()) {
      pageTexts.push(`\n\n--- PAGE ${pageNum} ---\n\n${text}`);
    }
  }

  return pageTexts.join("\n").trim();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") {
    return;
  }

  if (message.type === "EXTRACT_PDF_TEXT") {
    (async () => {
      try {
        const arrayBuffer = toArrayBuffer(message.arrayBuffer);

        if (!arrayBuffer) {
          sendResponse({ ok: false, error: "Invalid PDF data." });
          return;
        }

        const text = await extractPdfText(arrayBuffer);

        sendResponse({
          ok: true,
          text
        });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error?.message || "PDF extraction failed."
        });
      }
    })();

    return true;
  }
});