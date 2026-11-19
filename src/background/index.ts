import {
  isGeneric,
  matchTitle,
  parseTitle,
  parseUrlId,
  resolveId,
  titleAgrees,
  type Match,
  type UrlId,
} from "../lib/match";
import { getLibraryItem, login, newLibraryItem, putLibraryItem } from "../lib/stremio";
import type { Candidate, Detected, LogEntry, Message, ProgressMessage, Status } from "../lib/types";

// Fraction of the runtime at which an item counts as watched.
const WATCHED_RATIO = 0.8;
// Ignore clips, ads and previews.
const MIN_DURATION_S = 10 * 60;
const LOG_MAX = 40;

const KEY_AUTH = "authKey";
const KEY_ERROR = "error";
const KEY_DEBUG = "debug";
const KEY_LOG = "log";

type MatchCache = Record<string, Match | null>;
type TabStates = Record<number, Detected>;

// Renamed from "matches" to drop entries cached before generic titles were rejected.
const KEY_MATCHES = "matches2";

async function cachedMatch(title: string): Promise<Match | null> {
  const { [KEY_MATCHES]: matches = {} } = (await chrome.storage.local.get(KEY_MATCHES)) as {
    [KEY_MATCHES]?: MatchCache;
  };
  if (title in matches) return matches[title] ?? null;
  const m = await matchTitle(title);
  // Only cache hits; a miss may succeed later once the title settles.
  if (m) await chrome.storage.local.set({ [KEY_MATCHES]: { ...matches, [title]: m } });
  return m;
}

/** Resolves an IMDb id from a URL, caching the lookup by id. Season and episode come from the URL. */
// Ids that failed to resolve, so a playing video does not repeat the lookup every 10 seconds.
// Lost when the worker restarts, which only costs one retry.
const unresolved = new Set<string>();

async function cachedById(u: UrlId): Promise<Match | null> {
  const key = `id:${u.type ?? "?"}:${u.imdbId ?? `tmdb:${u.tmdbId}`}`;
  if (unresolved.has(key)) return null;
  const { [KEY_MATCHES]: matches = {} } = (await chrome.storage.local.get(KEY_MATCHES)) as {
    [KEY_MATCHES]?: MatchCache;
  };
  let base = matches[key] ?? null;
  if (!base) {
    base = await resolveId({ imdbId: u.imdbId, tmdbId: u.tmdbId, type: u.type });
    if (base) await chrome.storage.local.set({ [KEY_MATCHES]: { ...matches, [key]: base } });
    else unresolved.add(key);
  }
  if (!base) return null;
  return {
    ...base,
    season: base.type === "series" ? u.season : undefined,
    episode: base.type === "series" ? u.episode : undefined,
  };
}

/** Origin and path only, so the debug view and log never show query strings. */
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

/**
 * Tries IMDb ids found in URLs first, since they are exact, then each title
 * candidate in order. Returns the first match, plus a line per attempt for the
 * debug view.
 */
async function matchFirst(
  urls: string[],
  cands: Candidate[],
): Promise<{ m: Match | null; source: string | null; tried: string[] }> {
  const tried: string[] = [];
  for (const url of urls) {
    const u = parseUrlId(url);
    if (!u) continue;
    const m = await cachedById(u);
    const id = u.imdbId ?? `tmdb ${u.tmdbId}`;
    if (m && u.ambiguous) {
      // A bare number after /movie/ may be the site's own id. If the page names
      // a different title, do not trust it.
      const queries = cands.map((c) => parseTitle(c.text).query).filter((q) => !isGeneric(q));
      if (queries.length && !queries.some((q) => titleAgrees(q, m.name))) {
        tried.push(`url: ${shortUrl(url)} -> ${id} is ${m.imdbId} "${m.name}", disagrees with the page title, skipped`);
        continue;
      }
    }
    tried.push(`url: ${shortUrl(url)} -> ${id} ${m ? `match ${m.imdbId}` : "unknown id"}`);
    if (m) return { m, source: "url", tried };
  }
  for (const c of cands) {
    const q = parseTitle(c.text).query;
    if (isGeneric(q)) {
      tried.push(`${c.source}: "${c.text}" -> "${q}" generic, skipped`);
      continue;
    }
    const m = await cachedMatch(c.text);
    tried.push(`${c.source}: "${c.text}" -> "${q}" ${m ? `match ${m.imdbId}` : "no match"}`);
    if (m) return { m, source: c.source, tried };
  }
  return { m: null, source: null, tried };
}

function videoId(m: Match): string | null {
  if (m.type === "movie") return m.imdbId;
  if (m.season === undefined || m.episode === undefined) return null;
  return `${m.imdbId}:${m.season}:${m.episode}`;
}

async function markWatched(authKey: string, m: Match, vid: string, durationMs: number): Promise<void> {
  const now = new Date().toISOString();
  const item = (await getLibraryItem(authKey, m.imdbId)) ?? newLibraryItem(m.imdbId, m.name, m.type, m.poster);
  item.removed = false;
  item.temp = false;
  item._mtime = now;
  item.state = {
    ...item.state,
    lastWatched: now,
    timeOffset: 0,
    duration: durationMs,
    video_id: vid,
    timesWatched: item.state.timesWatched + 1,
    flaggedWatched: item.state.flaggedWatched + 1,
  };
  // TODO: series also need the `watched` bitfield so each episode shows as watched.
  await putLibraryItem(authKey, item);
}

async function getTabStates(): Promise<TabStates> {
  const { tabs = {} } = (await chrome.storage.session.get("tabs")) as { tabs?: TabStates };
  return tabs;
}

async function setTabState(tabId: number, d: Detected | null): Promise<void> {
  const tabs = await getTabStates();
  if (d) tabs[tabId] = d;
  else delete tabs[tabId];
  await chrome.storage.session.set({ tabs });
}

async function isDebug(): Promise<boolean> {
  const s = await chrome.storage.local.get(KEY_DEBUG);
  return !!s[KEY_DEBUG];
}

async function addLog(text: string): Promise<void> {
  const s = await chrome.storage.local.get(KEY_LOG);
  const log: LogEntry[] = s[KEY_LOG] ?? [];
  log.push({ at: Date.now(), text });
  await chrome.storage.local.set({ [KEY_LOG]: log.slice(-LOG_MAX) });
}

function describe(d: Detected): string {
  const ep = d.season !== undefined ? ` S${d.season}E${d.episode ?? "?"}` : "";
  switch (d.state) {
    case "detected":
      return `detected ${d.name}${ep}${d.synced ? " (synced)" : ""}`;
    case "no-episode":
      return `matched ${d.name} but no season and episode in "${d.title}"`;
    case "no-match":
      return `no match for "${d.query}" (title "${d.title}")`;
    case "too-short":
      return `ignored a ${Math.round(d.duration / 60)} min video on "${d.title}"`;
  }
}

/** Sets the toolbar badge for a tab. Misses only show in debug mode. */
async function setBadge(tabId: number, d: Detected | null, debug: boolean): Promise<void> {
  let text = "";
  let color = "#2e7d32";
  if (d?.state === "detected") {
    text = d.synced ? "✓" : "•";
    color = d.synced ? "#2e7d32" : "#1565c0";
  } else if (debug && d) {
    text = "?";
    color = "#ef6c00";
  }
  await chrome.action.setBadgeText({ tabId, text });
  if (text) await chrome.action.setBadgeBackgroundColor({ tabId, color });
}

/** URLs of frames in a tab that carry an IMDb id, reported by their content scripts. */
async function getFrameUrls(tabId: number): Promise<string[]> {
  const { frames = {} } = (await chrome.storage.session.get("frames")) as { frames?: Record<number, string[]> };
  return frames[tabId] ?? [];
}

async function setFrameUrls(tabId: number, urls: string[] | null): Promise<void> {
  const { frames = {} } = (await chrome.storage.session.get("frames")) as { frames?: Record<number, string[]> };
  if (urls) frames[tabId] = urls;
  else delete frames[tabId];
  await chrome.storage.session.set({ frames });
}

async function addFrameUrl(tabId: number, url: string): Promise<void> {
  const urls = await getFrameUrls(tabId);
  if (!urls.includes(url)) await setFrameUrls(tabId, [...urls, url].slice(-10));
}

async function onProgress(
  msg: ProgressMessage,
  tab: chrome.tabs.Tab | undefined,
  frameUrl: string | undefined,
): Promise<void> {
  if (tab?.id === undefined) return;
  const tabId = tab.id;
  const title = tab.title ?? "";
  const debug = await isDebug();
  const { [KEY_AUTH]: authKey } = await chrome.storage.local.get(KEY_AUTH);

  const d: Detected = {
    state: "no-match",
    title,
    query: parseTitle(title).query,
    source: null,
    tried: [],
    name: null,
    imdbId: null,
    ratio: msg.currentTime / msg.duration,
    duration: msg.duration,
    synced: false,
    at: Date.now(),
  };

  const session = (await chrome.storage.session.get("synced")) as { synced?: Record<string, boolean> };
  const synced = session.synced ?? {};

  let vid: string | null = null;
  let m: Match | null = null;
  if (msg.duration < MIN_DURATION_S) {
    d.state = "too-short";
  } else {
    // Titles from the player first, since the tab title is often just the site name.
    const cands = [...msg.candidates, ...(title ? [{ source: "tab", text: title }] : [])];
    // The playing frame first, then frames that reported an id, then the tab URL.
    const urls = [...new Set([frameUrl, ...(await getFrameUrls(tabId)), tab?.url].filter((u): u is string => !!u))];
    const r = await matchFirst(urls, cands);
    d.tried = r.tried;
    d.source = r.source;
    m = r.m;
    if (m) {
      vid = videoId(m);
      d.name = m.name;
      d.imdbId = m.imdbId;
      d.type = m.type;
      d.season = m.season;
      d.episode = m.episode;
      d.state = vid ? "detected" : "no-episode";
    }
  }
  const syncKey = `${tabId}:${vid ?? title}`;
  d.synced = !!synced[syncKey];

  if (m && vid && authKey && d.ratio >= WATCHED_RATIO && !d.synced) {
    try {
      await markWatched(authKey, m, vid, Math.round(msg.duration * 1000));
      synced[syncKey] = true;
      d.synced = true;
      await chrome.storage.session.set({ synced });
      await chrome.storage.local.remove(KEY_ERROR);
    } catch (e) {
      await chrome.storage.local.set({ [KEY_ERROR]: String(e) });
      if (debug) await addLog(`sync failed: ${String(e)}`);
    }
  }

  const prev = (await getTabStates())[tabId];
  await setTabState(tabId, d);
  await setBadge(tabId, d, debug);
  // Log changes only, not every 10 second report.
  if (debug && (!prev || prev.state !== d.state || prev.title !== d.title || prev.synced !== d.synced)) {
    await addLog(describe(d));
  }
}

async function status(tabId?: number): Promise<Status> {
  const s = await chrome.storage.local.get([KEY_AUTH, KEY_ERROR, KEY_DEBUG, KEY_LOG]);
  const current = tabId === undefined ? null : ((await getTabStates())[tabId] ?? null);
  return {
    loggedIn: !!s[KEY_AUTH],
    debug: !!s[KEY_DEBUG],
    current,
    log: s[KEY_DEBUG] ? (s[KEY_LOG] ?? []) : [],
    error: s[KEY_ERROR] ?? null,
  };
}

async function refreshBadges(debug: boolean): Promise<void> {
  const tabs = await getTabStates();
  for (const [id, d] of Object.entries(tabs)) await setBadge(Number(id), d, debug);
}

chrome.runtime.onMessage.addListener((msg: Message, sender, sendResponse) => {
  const run = async () => {
    switch (msg.kind) {
      case "progress":
        await onProgress(msg, sender.tab, sender.url);
        return undefined;
      case "frameUrl":
        if (sender.tab?.id !== undefined) await addFrameUrl(sender.tab.id, msg.url);
        return undefined;
      case "login": {
        const authKey = await login(msg.email, msg.password);
        await chrome.storage.local.set({ [KEY_AUTH]: authKey });
        return status();
      }
      case "logout":
        await chrome.storage.local.remove([KEY_AUTH, KEY_ERROR]);
        return status();
      case "setDebug":
        await chrome.storage.local.set({ [KEY_DEBUG]: msg.on });
        if (!msg.on) await chrome.storage.local.remove(KEY_LOG);
        await refreshBadges(msg.on);
        return status(msg.tabId);
      case "status":
        return status(msg.tabId);
    }
  };
  run()
    .then(sendResponse)
    .catch((e) => sendResponse({ error: String(e) }));
  return true;
});

// A new page load means the old detection no longer applies.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") {
    void setTabState(tabId, null);
    void setFrameUrls(tabId, null);
    void chrome.action.setBadgeText({ tabId, text: "" });
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  void setTabState(tabId, null);
  void setFrameUrls(tabId, null);
});
