const providerSelect = document.getElementById("provider");
const apiKeyInput = document.getElementById("api-key");
const modelInput = document.getElementById("model");
const saveButton = document.getElementById("save-btn");
const status = document.getElementById("status");

const DEFAULT_MODELS = {
  openrouter: "google/gemma-4-26b-a4b-it:free",
  gemini: "gemini-2.5-flash"
};

const PROVIDER_DETAILS = {
  openrouter: {
    keyPlaceholder: "sk-or-v1-...",
    hint: "Paste your OpenRouter API key. You can use any OpenRouter-supported model ID."
  },
  gemini: {
    keyPlaceholder: "AIza...",
    hint: "Paste your Google Gemini API key from Google AI Studio."
  }
};

function updateProviderUI() {
  const provider = providerSelect.value;
  const details = PROVIDER_DETAILS[provider];

  apiKeyInput.placeholder = details.keyPlaceholder;

  const note = document.getElementById("provider-note");

  if (note) {
    note.textContent = details.hint;
  }
}

async function loadSettings() {
  const settings = await chrome.storage.local.get([
    "apiProvider",
    "apiKey",
    "apiModel"
  ]);

  providerSelect.value = settings.apiProvider || "openrouter";

  apiKeyInput.value = settings.apiKey || "";

  modelInput.value =
    settings.apiModel ||
    DEFAULT_MODELS[providerSelect.value];

  updateProviderUI();
}

providerSelect.addEventListener("change", () => {
  const provider = providerSelect.value;

  updateProviderUI();

  modelInput.value = DEFAULT_MODELS[provider];
});

saveButton.addEventListener("click", async () => {
  const apiProvider = providerSelect.value;
  const apiKey = apiKeyInput.value.trim();

  const apiModel =
    modelInput.value.trim() ||
    DEFAULT_MODELS[apiProvider];

  if (!apiKey) {
    status.style.display = "block";
    status.style.color = "#c92a2a";
    status.textContent = "Please enter an API key.";
    return;
  }

  await chrome.storage.local.set({
    apiProvider,
    apiKey,
    apiModel
  });

  status.style.display = "block";
  status.style.color = "#2b8a3e";
  status.textContent = `Saved ${apiProvider} settings successfully.`;

  setTimeout(() => {
    status.style.display = "none";
  }, 2500);
});

loadSettings();