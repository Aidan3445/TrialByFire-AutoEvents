// Caption Tap: grab caption text from live CBS broadcasts

const ENDPOINT = "http://127.0.0.1:8000/cue";

const SCROLLER = "#static-scroller";
const CUE = ".tt-container";

const ROOT_HINTS = [
  ".timed-text-css-box-container-mask",
  "#static-scroller",
];

const seen = new Set();
const queue = [];
let flushing = false;

function removeIndicators(el) {
  // Broadcast captions mark a speaker change with ">>" and a topic change with ">>>"
  const raw = (el.textContent || "").replace(/\s+/g, " ").trim();
  const m = raw.match(/^(>{2,3})\s*/);
  return {
    text: raw.replace(/^>{2,3}\s*/, ""),
    boundary: m ? (m[1].length >= 3 ? "topic" : "speaker") : null,
  };
}

function harvest() {
  const scroller = document.querySelector(SCROLLER);
  if (!scroller) return;
  for (const el of scroller.querySelectorAll(CUE)) {
    const key = el.getAttribute("key");
    if (!key || seen.has(key)) continue;
    const { text, boundary } = removeIndicators(el);
    if (!text) continue;
    seen.add(key);
    queue.push({
      key,
      text,
      boundary,
      start: parseFloat(el.getAttribute("starttime")),
      end: parseFloat(el.getAttribute("endtime")),
      media_time: currentMediaTime(),
      wall_time: Date.now() / 1000,
      href: location.href,
    });
  }
}

function currentMediaTime() {
  // This protects against swapping video players or refreshing the page breaking the tap
  const v = document.querySelector("video");
  return v && Number.isFinite(v.currentTime) ? v.currentTime : null;
}

async function flush() {
  if (flushing || queue.length === 0) return;
  flushing = true;
  const batch = queue.splice(0, queue.length);
  try {
    await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cues: batch }),
    });
  } catch (err) {
    // Use the queue to retry rather than losing the data
    queue.unshift(...batch);
    console.warn("[caption-tap] post failed, requeued", batch.length, err);
  } finally {
    flushing = false;
  }
}

let observer = null;

function attach() {
  const root =
    ROOT_HINTS.map((s) => document.querySelector(s)).find(Boolean) ||
    document.body;
  if (observer) observer.disconnect();
  observer = new MutationObserver(harvest);
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  harvest();
  console.log("[caption-tap] attached to", root);
}

// Reattach if the scroller is removed, happens during ad breaks sometimes
setInterval(() => {
  if (!document.querySelector(SCROLLER)) attach();
}, 4000);

setInterval(flush, 1000);
attach();
