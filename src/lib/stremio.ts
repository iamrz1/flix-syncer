const API = "https://api.strem.io/api";
const COLLECTION = "libraryItem";

export interface LibraryItemState {
  lastWatched: string | null;
  timeWatched: number;
  timeOffset: number;
  overallTimeWatched: number;
  timesWatched: number;
  flaggedWatched: number;
  duration: number;
  video_id: string | null;
  watched: string | null;
  noNotif: boolean;
}

export interface LibraryItem {
  _id: string;
  name: string;
  type: string;
  poster: string | null;
  posterShape: string;
  removed: boolean;
  temp: boolean;
  _ctime: string | null;
  _mtime: string;
  state: LibraryItemState;
  behaviorHints?: Record<string, unknown>;
}

async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`stremio ${method}: HTTP ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: { message?: string } };
  if (json.error || json.result === undefined) {
    throw new Error(`stremio ${method}: ${json.error?.message ?? "empty result"}`);
  }
  return json.result;
}

/** Exchanges credentials for an authKey. The password is never stored. */
export async function login(email: string, password: string): Promise<string> {
  const r = await call<{ authKey: string }>("login", { type: "Auth", email, password });
  return r.authKey;
}

export async function getLibraryItem(authKey: string, id: string): Promise<LibraryItem | null> {
  const items = await call<LibraryItem[]>("datastoreGet", {
    authKey,
    collection: COLLECTION,
    ids: [id],
    all: false,
  });
  return items[0] ?? null;
}

export async function putLibraryItem(authKey: string, item: LibraryItem): Promise<void> {
  await call("datastorePut", { authKey, collection: COLLECTION, changes: [item] });
}

export function newLibraryItem(id: string, name: string, type: string, poster: string | null): LibraryItem {
  const now = new Date().toISOString();
  return {
    _id: id,
    name,
    type,
    poster,
    posterShape: "poster",
    removed: false,
    temp: false,
    _ctime: now,
    _mtime: now,
    state: {
      lastWatched: null,
      timeWatched: 0,
      timeOffset: 0,
      overallTimeWatched: 0,
      timesWatched: 0,
      flaggedWatched: 0,
      duration: 0,
      video_id: null,
      watched: null,
      noNotif: false,
    },
    behaviorHints: { defaultVideoId: null, featuredVideoId: null, hasScheduledVideos: false },
  };
}
