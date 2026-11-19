import type { ProgressMessage } from "../lib/types";

const REPORT_EVERY_MS = 10_000;

function playingVideo(): HTMLVideoElement | null {
  const videos = Array.from(document.querySelectorAll("video"));
  // Prefer the longest playing video so a short ad or preview does not hide the feature.
  return (
    videos
      .filter((v) => !v.paused && Number.isFinite(v.duration) && v.duration > 0)
      .sort((a, b) => b.duration - a.duration)[0] ?? null
  );
}

setInterval(() => {
  const v = playingVideo();
  if (!v) return;
  const msg: ProgressMessage = {
    kind: "progress",
    currentTime: v.currentTime,
    duration: v.duration,
  };
  // The background reads the tab title and URL from the sender, so this also
  // works from iframes that cannot see the top document. The length filter
  // lives there too, so the popup can say why a short video was ignored.
  chrome.runtime.sendMessage(msg).catch(() => {});
}, REPORT_EVERY_MS);
