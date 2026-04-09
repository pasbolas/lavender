const STORAGE_KEY = "guardEnabled";

const toggle = document.getElementById("guard-toggle");
const statusText = document.getElementById("toggle-status");

function updateUi(enabled) {
  toggle.checked = enabled;
  statusText.textContent = enabled ? "On" : "Off";
}

chrome.storage.local.get([STORAGE_KEY], (result) => {
  const enabled = result[STORAGE_KEY] !== false;
  updateUi(enabled);
});

toggle.addEventListener("change", () => {
  const enabled = toggle.checked;
  updateUi(enabled);
  chrome.storage.local.set({ [STORAGE_KEY]: enabled });
});
