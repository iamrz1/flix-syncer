import { getTmdbId, searchTitles, type SearchResult } from "../lib/match";
import { buildUrl, DEFAULT_PLAYER, loadPlayer, needsTmdb, savePlayer } from "../lib/player";
import type { Detected, Message, Status } from "../lib/types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// A detection older than this means nothing is playing in the tab any more.
const STALE_MS = 60_000;

let tabId: number | undefined;

async function send(msg: Message): Promise<Status> {
  return chrome.runtime.sendMessage(msg);
}

function head(d: Detected | null, debug: boolean): { cls: string; head: string; sub: string } {
  if (!d || Date.now() - d.at > STALE_MS) {
    return { cls: "", head: "Nothing playing", sub: "Play a movie or episode in this tab." };
  }
  const ep = d.season !== undefined ? ` S${d.season}E${d.episode ?? "?"}` : "";
  const pct = `${Math.round(d.ratio * 100)}%`;
  switch (d.state) {
    case "detected":
      return {
        cls: "detected",
        head: `${d.type === "series" ? "TV" : "Movie"}: ${d.name}${ep}`,
        sub: d.synced ? "Synced to Stremio" : `Watching, ${pct}. Syncs at 80%.`,
      };
    case "no-episode":
      return {
        cls: "miss",
        head: `Series: ${d.name}`,
        sub: "No season and episode in the page title, not synced.",
      };
    case "no-match":
      return { cls: debug ? "miss" : "", head: "Not detected", sub: "The page title did not match a movie or series." };
    case "too-short":
      return { cls: debug ? "miss" : "", head: "Not detected", sub: "The video is shorter than 10 minutes." };
  }
}

function render(s: Status): void {
  $("login").hidden = s.loggedIn;
  $("main").hidden = !s.loggedIn && !s.current;
  $("error").textContent = s.error ?? "";
  $("warn").hidden = s.loggedIn;
  $("logoutBtn").hidden = !s.loggedIn;

  const h = head(s.current, s.debug);
  $("card").className = `card ${h.cls}`;
  $("head").textContent = h.head;
  $("sub").textContent = h.sub;

  $<HTMLInputElement>("debug").checked = s.debug;
  const info = $("debugInfo");
  info.hidden = !s.debug || !s.current;
  if (s.debug && s.current) {
    const d = s.current;
    info.textContent = [
      `state: ${d.state}`,
      `title: ${d.title}`,
      `query: ${d.query}`,
      `imdb: ${d.imdbId ?? "-"}`,
      `source: ${d.source ?? "-"}`,
      `progress: ${Math.round(d.ratio * 100)}% of ${Math.round(d.duration / 60)} min`,
      ...(d.tried.length ? ["tried:", ...d.tried.map((t) => `  ${t}`)] : []),
    ].join("\n");
    info.style.whiteSpace = "pre-wrap";
  }
  $("logWrap").hidden = !s.debug;
  $("log").textContent = s.log
    .slice()
    .reverse()
    .map((e) => `${new Date(e.at).toLocaleTimeString()}  ${e.text}`)
    .join("\n");
}

$("loginBtn").addEventListener("click", async () => {
  const email = $<HTMLInputElement>("email").value;
  const password = $<HTMLInputElement>("password").value;
  const s = await send({ kind: "login", email, password });
  $<HTMLInputElement>("password").value = "";
  render(await send({ kind: "status", tabId }).then((r) => ({ ...r, error: s.error ?? r.error })));
});
$("logoutBtn").addEventListener("click", async () => render(await send({ kind: "logout" })));
$("debug").addEventListener("change", async (e) =>
  render(await send({ kind: "setDebug", on: (e.target as HTMLInputElement).checked, tabId })),
);

// Search by title, then open the result in the configured player.

async function openResult(r: SearchResult, season: number, episode: number): Promise<void> {
  $("searchErr").textContent = "";
  const p = await loadPlayer();
  const template = r.type === "movie" ? p.movieUrl : p.tvUrl;
  const tmdb = needsTmdb(template) ? await getTmdbId(r.type, r.imdbId) : undefined;
  const url = buildUrl(template, { imdb: r.imdbId, tmdb, season, episode });
  if (!url) {
    $("searchErr").textContent = "Could not build a player URL. Check the template and that the title has a TMDB id.";
    return;
  }
  await chrome.tabs.create({ url });
}

function resultRow(r: SearchResult): HTMLElement {
  const row = document.createElement("div");
  row.className = "result";

  const name = document.createElement("div");
  name.className = "name";
  const title = document.createElement("div");
  title.textContent = `${r.name}${r.year ? ` (${r.year})` : ""}`;
  const id = document.createElement("div");
  id.className = "id";
  id.textContent = `${r.type === "series" ? "TV" : "Movie"} ${r.imdbId}`;
  name.append(title, id);
  row.append(name);

  const num = (label: string): HTMLInputElement => {
    const i = document.createElement("input");
    i.type = "number";
    i.min = "1";
    i.value = "1";
    i.title = label;
    return i;
  };
  const s = num("Season");
  const e = num("Episode");
  if (r.type === "series") row.append(s, e);

  const open = document.createElement("button");
  open.textContent = "Open";
  open.addEventListener("click", () => void openResult(r, Number(s.value) || 1, Number(e.value) || 1));
  row.append(open);
  return row;
}

async function runSearch(): Promise<void> {
  const results = $("results");
  $("searchErr").textContent = "";
  results.textContent = "Searching...";
  try {
    const found = await searchTitles($<HTMLInputElement>("q").value);
    results.textContent = found.length ? "" : "No results.";
    results.append(...found.map(resultRow));
  } catch (err) {
    results.textContent = "";
    $("searchErr").textContent = `Search failed: ${String(err)}`;
  }
}

$("qBtn").addEventListener("click", () => void runSearch());
$("q").addEventListener("keydown", (e) => {
  if ((e as KeyboardEvent).key === "Enter") void runSearch();
});

$("saveUrls").addEventListener("click", async () => {
  await savePlayer({
    movieUrl: $<HTMLInputElement>("movieUrl").value,
    tvUrl: $<HTMLInputElement>("tvUrl").value,
  });
});
$("resetUrls").addEventListener("click", async () => {
  await savePlayer(DEFAULT_PLAYER);
  $<HTMLInputElement>("movieUrl").value = DEFAULT_PLAYER.movieUrl;
  $<HTMLInputElement>("tvUrl").value = DEFAULT_PLAYER.tvUrl;
});

const player = await loadPlayer();
$<HTMLInputElement>("movieUrl").value = player.movieUrl;
$<HTMLInputElement>("tvUrl").value = player.tvUrl;

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
tabId = tab?.id;
render(await send({ kind: "status", tabId }));
