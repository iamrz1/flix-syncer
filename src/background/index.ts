import { matchTitle, parseTitle, type Match } from "../lib/match";
import { getLibraryItem, login, newLibraryItem, putLibraryItem } from "../lib/stremio";
import type { Detected, LogEntry, Message, ProgressMessage, Status } from "../lib/types";

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

async function cachedMatch(title: string): Promise<Match | null> {
  const { matches = {} } = (await chrome.storage.local.get("matches")) as { matches?: MatchCache };
  if (title in matches) return matches[title] ?? null;
  const m = await matchTitle(title);
  // Only cache hits; a miss may succeed later once the title settles.
  if (m) await chrome.storage.local.set({ matches: { ...matches, [title]: m } });
  return m;
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

async function onProgress(msg: ProgressMessage, tab: chrome.tabs.Tab | undefined): Promise<void> {
  if (tab?.id === undefined) return;
  const tabId = tab.id;
  const title = tab.title ?? "";
  const debug = await isDebug();
  const { [KEY_AUTH]: authKey } = await chrome.storage.local.get(KEY_AUTH);

  const d: Detected = {
    state: "no-match",
    title,
    query: parseTitle(title).query,
    name: null,
    imdbId: null,
    ratio: msg.currentTime / msg.duration,
    duration: msg.duration,
    synced: false,
    at: Date.now(),
  };

  const session = (await chrome.storage.session.get("synced")) as { synced?: Record<string, boolean> };
  const synced = session.synced ?? {};
  const syncKey = `${tabId}:${title}`;

  let vid: string | null = null;
  let m: Match | null = null;
  if (msg.duration < MIN_DURATION_S) {
    d.state = "too-short";
  } else if (title) {
    m = await cachedMatch(title);
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
        await onProgress(msg, sender.tab);
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
    void chrome.action.setBadgeText({ tabId, text: "" });
  }
});
chrome.tabs.onRemoved.addListener((tabId) => void setTabState(tabId, null));
