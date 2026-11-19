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
      `progress: ${Math.round(d.ratio * 100)}% of ${Math.round(d.duration / 60)} min`,
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

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
tabId = tab?.id;
render(await send({ kind: "status", tabId }));
