import { parseUrlId } from "../lib/match";
import type { Candidate, FrameUrlMessage, ProgressMessage } from "../lib/types";

const REPORT_EVERY_MS = 10_000;
const MAX_TEXT = 200;

// Common player title bars and title elements. Sites that show the name only
// in the player UI (not in the tab title) usually use one of these.
const PLAYER_TITLE_SELECTORS = [
  ".vjs-title-bar",
  ".jw-title-primary",
  '[class*="video-title"]',
  '[class*="player-title"]',
  '[class*="movie-title"]',
  '[class*="media-title"]',
];

function playingVideo(): HTMLVideoElement | null {
  const videos = Array.from(document.querySelectorAll("video"));
  // Prefer the longest playing video so a short ad or preview does not hide the feature.
  return (
    videos
      .filter((v) => !v.paused && Number.isFinite(v.duration) && v.duration > 0)
      .sort((a, b) => b.duration - a.duration)[0] ?? null
  );
}

function jsonLdNames(): string[] {
  const names: string[] = [];
  for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      const data = JSON.parse(s.textContent ?? "") as unknown;
      for (const node of Array.isArray(data) ? data : [data]) {
        const n = node as { "@type"?: string | string[]; name?: string };
        const types = ([] as string[]).concat(n["@type"] ?? []);
        if (n.name && types.some((t) => ["Movie", "TVSeries", "TVEpisode", "VideoObject"].includes(t))) {
          names.push(n.name);
        }
      }
    } catch {
      // not valid JSON, ignore
    }
  }
  return names;
}

/** Titles near the video, most specific first. */
function candidates(v: HTMLVideoElement): Candidate[] {
  const out: Candidate[] = [];
  const add = (source: string, text?: string | null) => {
    const t = text?.replace(/\s+/g, " ").trim();
    if (t && t.length <= MAX_TEXT && !out.some((o) => o.text === t)) out.push({ source, text: t });
  };

  add("video", v.title || v.getAttribute("aria-label") || v.dataset.title);
  for (const sel of PLAYER_TITLE_SELECTORS) add(`player ${sel}`, document.querySelector(sel)?.textContent);
  add("og:title", document.querySelector('meta[property="og:title"]')?.getAttribute("content"));
  add("twitter:title", document.querySelector('meta[name="twitter:title"]')?.getAttribute("content"));
  for (const n of jsonLdNames()) add("json-ld", n);
  // In the top frame this is the tab title, which the background adds itself.
  if (window !== window.top) add("frame title", document.title);
  return out;
}

// Player URLs often carry an IMDb or TMDB id (e.g. /embed/movie/tt4154796) while the
// page has no usable title. Report it even from frames without a video, since
// the video may sit in a frame nested below this one.
if (parseUrlId(location.href)) {
  chrome.runtime.sendMessage({ kind: "frameUrl", url: location.href } satisfies FrameUrlMessage).catch(() => {});
}

setInterval(() => {
  const v = playingVideo();
  if (!v) return;
  const msg: ProgressMessage = {
    kind: "progress",
    currentTime: v.currentTime,
    duration: v.duration,
    candidates: candidates(v),
  };
  // The background reads the tab title from the sender and applies the length
  // filter, so the popup can say why a short video was ignored.
  chrome.runtime.sendMessage(msg).catch(() => {});
}, REPORT_EVERY_MS);
