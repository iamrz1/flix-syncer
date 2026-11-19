const CINEMETA = "https://v3-cinemeta.strem.io";

export interface Match {
  imdbId: string;
  name: string;
  type: "movie" | "series";
  poster: string | null;
  /** Set for series when season and episode were parsed from the title. */
  season?: number;
  episode?: number;
}

export interface Parsed {
  query: string;
  year?: number;
  season?: number;
  episode?: number;
}

const NOISE =
  /\b(watch|online|free|full|movie|hd|1080p|720p|480p|4k|streaming|stream|episode|season|ep|s\d{1,2}e\d{1,3}|cam|camrip|hdcam|hdts|hdtc|ts|hdrip|webrip|web-dl|webdl|bluray|brrip|dvdrip|dvdscr|x264|x265|hevc)\b/gi;

// Words that only describe a site or a page. A title made of these alone
// (e.g. "Free Movies") must never be looked up, or it matches a film that
// happens to be named "Movies".
const GENERIC = new Set([
  "movies", "movie", "films", "film", "tv", "shows", "show", "series", "home", "homepage",
  "video", "videos", "player", "watch", "free", "online", "stream", "streaming", "hd", "new",
  "latest", "popular", "trending", "anime", "cartoons", "download", "page", "index", "untitled",
]);

/** Reports whether a cleaned query is empty or made only of generic page words. */
export function isGeneric(query: string): boolean {
  const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.length === 0 || words.every((w) => GENERIC.has(w));
}

/** Strips site names, tags and noise from a title and pulls out year, season and episode. */
export function parseTitle(raw: string): Parsed {
  // Bracketed tags such as "[Punjabi][CAM]" are never part of the name.
  let t = raw.replace(/\[[^\]]*\]|\{[^}]*\}/g, " ");
  t = t.split(/\s[|\-–—•·]\s/)[0] ?? t;
  let season: number | undefined;
  let episode: number | undefined;

  const se = t.match(/\bS(\d{1,2})\s?E(\d{1,3})\b/i) ?? t.match(/\b(\d{1,2})x(\d{1,3})\b/);
  if (se) {
    season = Number(se[1]);
    episode = Number(se[2]);
  } else {
    const long = t.match(/season\s*(\d{1,2}).*?episode\s*(\d{1,3})/i);
    if (long) {
      season = Number(long[1]);
      episode = Number(long[2]);
    }
  }

  const y = t.match(/\(?\b(19|20)\d{2}\b\)?/);
  const year = y ? Number(y[0].replace(/[()]/g, "")) : undefined;

  t = t.replace(/\b(season|episode)\b.*$/i, " ");
  t = t.replace(/\(?\b(19|20)\d{2}\b\)?/g, " ").replace(/\([^)]*\)/g, " ").replace(NOISE, " ");
  t = t.replace(/[^\p{L}\p{N}' :&]/gu, " ");
  return { query: t.replace(/\s+/g, " ").trim(), year, season, episode };
}

interface CinemetaMeta {
  imdb_id?: string;
  id: string;
  name: string;
  poster?: string;
  releaseInfo?: string;
}

async function search(type: "movie" | "series", query: string): Promise<CinemetaMeta[]> {
  const url = `${CINEMETA}/catalog/${type}/top/search=${encodeURIComponent(query)}.json`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const json = (await res.json()) as { metas?: CinemetaMeta[] };
  return json.metas ?? [];
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * Resolves a page title to an IMDb id. Returns null for generic titles and when
 * no result matches the cleaned title exactly, so a wrong guess never reaches
 * the library.
 */
export async function matchTitle(rawTitle: string): Promise<Match | null> {
  const p = parseTitle(rawTitle);
  if (p.query.length < 2 || isGeneric(p.query)) return null;

  const types: ("movie" | "series")[] = p.season !== undefined ? ["series"] : ["movie", "series"];
  // "movie" is stripped as noise, but some names contain it (e.g. "The Lego Movie").
  const queries = /\bmovie\b/i.test(rawTitle) ? [p.query, `${p.query} Movie`] : [p.query];
  for (const query of queries) {
    for (const type of types) {
      const metas = await search(type, query);
      const hit = metas.find((m) => {
        if (norm(m.name) !== norm(query)) return false;
        if (p.year && m.releaseInfo && !m.releaseInfo.startsWith(String(p.year))) return false;
        return true;
      });
      const id = hit?.imdb_id ?? hit?.id;
      if (hit && id?.startsWith("tt")) {
        return {
          imdbId: id,
          name: hit.name,
          type,
          poster: hit.poster ?? null,
          season: type === "series" ? p.season : undefined,
          episode: type === "series" ? p.episode : undefined,
        };
      }
    }
  }
  return null;
}

export interface UrlId {
  /** Set when the URL carries an IMDb id. */
  imdbId?: string;
  /** Set when the URL carries a TMDB id and no IMDb id. */
  tmdbId?: number;
  type?: "movie" | "series";
  season?: number;
  episode?: number;
  /**
   * True when a bare number after /movie/ or /tv/ was taken as a TMDB id. Other
   * sites use their own numeric ids in the same place, so this needs a sanity check.
   */
  ambiguous?: boolean;
}

/**
 * Pulls an IMDb or TMDB id out of a player URL such as
 * https://host/embed/movie/tt4154796, https://host/embed/tv/1399/1/2 or
 * https://host/player?tmdb=299534. Series also get season and episode from the
 * path (/<id>/1/2, /<id>/1-2) or from ?season=1&episode=2 (s and e work too).
 */
export function parseUrlId(url: string): UrlId | null {
  let u: URL | null = null;
  try {
    u = new URL(url);
  } catch {
    // keep matching on the raw string
  }
  const path = u?.pathname ?? url;

  let type: UrlId["type"] = /\/(tv|series|shows?)\b/i.test(path)
    ? "series"
    : /\/movies?\b/i.test(path)
      ? "movie"
      : undefined;
  const typeParam = (u?.searchParams.get("type") ?? u?.searchParams.get("media_type") ?? "").toLowerCase();
  if (!type && (typeParam === "tv" || typeParam === "series")) type = "series";
  if (!type && typeParam === "movie") type = "movie";

  const imdbId = url.match(/\btt\d{6,10}\b/)?.[0];
  let tmdbId: number | undefined;
  let ambiguous = false;
  let idPattern = "tt\\d+";
  if (!imdbId) {
    const q = u?.searchParams;
    const param = q?.get("tmdb") ?? q?.get("tmdb_id") ?? q?.get("tmdbid") ?? q?.get("tmdbId");
    const explicit = param?.match(/^\d{1,8}$/)?.[0] ?? path.match(/\/tmdb[-_:/=](\d{1,8})\b/i)?.[1];
    if (explicit) {
      tmdbId = Number(explicit);
    } else {
      // /movie/299534, /tv/1399/1/2, themoviedb.org/movie/299534-slug
      const bare = path.match(/\/(?:movies?|tv|series|shows?)\/(\d{2,8})(?=[-/]|$)/i)?.[1];
      if (bare) {
        tmdbId = Number(bare);
        ambiguous = true;
      }
    }
    if (tmdbId === undefined) return null;
    idPattern = String(tmdbId);
  }

  let season: number | undefined;
  let episode: number | undefined;
  const seg = path.match(new RegExp(`${idPattern}(?:-[^/]*)?/(\\d{1,2})[/-](\\d{1,3})\\b`));
  if (seg) {
    season = Number(seg[1]);
    episode = Number(seg[2]);
  } else if (u) {
    const s = u.searchParams.get("season") ?? u.searchParams.get("s");
    const e = u.searchParams.get("episode") ?? u.searchParams.get("e");
    if (s && e && /^\d+$/.test(s) && /^\d+$/.test(e)) {
      season = Number(s);
      episode = Number(e);
    }
  }
  if (season !== undefined) type = "series";
  return { imdbId, tmdbId, type, season, episode, ambiguous };
}

/** Maps a TMDB id to an IMDb id through Wikidata, which needs no API key. Null when it has no entry. */
async function tmdbToImdb(type: "movie" | "series", tmdbId: number): Promise<string | null> {
  const prop = type === "movie" ? "P4947" : "P4983";
  const sparql = `SELECT ?imdb WHERE { ?i wdt:${prop} "${tmdbId}"; wdt:P345 ?imdb } LIMIT 1`;
  const res = await fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`, {
    // Wikimedia asks API clients to identify themselves. Browsers cannot set
    // User-Agent, so they use Api-User-Agent.
    headers: {
      Accept: "application/sparql-results+json",
      "Api-User-Agent": "flix-syncer (https://github.com/iamrz1/flix-syncer)",
    },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { results?: { bindings?: { imdb?: { value?: string } }[] } };
  const id = json.results?.bindings?.[0]?.imdb?.value;
  return id?.startsWith("tt") ? id : null;
}

/** Looks an IMDb or TMDB id up in Cinemeta. Returns null when the id is unknown. */
export async function resolveId(u: UrlId): Promise<Match | null> {
  const types: ("movie" | "series")[] = u.type ? [u.type] : ["movie", "series"];
  for (const type of types) {
    const imdbId = u.imdbId ?? (u.tmdbId !== undefined ? await tmdbToImdb(type, u.tmdbId) : null);
    if (!imdbId) continue;
    const res = await fetch(`${CINEMETA}/meta/${type}/${imdbId}.json`);
    if (!res.ok) continue;
    const json = (await res.json()) as { meta?: { name?: string; poster?: string } };
    if (!json.meta?.name) continue;
    return {
      imdbId,
      name: json.meta.name,
      type,
      poster: json.meta.poster ?? null,
      season: type === "series" ? u.season : undefined,
      episode: type === "series" ? u.episode : undefined,
    };
  }
  return null;
}

/** Whether a cleaned title query and a resolved name refer to the same title. */
export function titleAgrees(query: string, name: string): boolean {
  const a = norm(query);
  const b = norm(name);
  return a.length > 0 && b.length > 0 && (a.includes(b) || b.includes(a));
}

export interface SearchResult {
  imdbId: string;
  name: string;
  type: "movie" | "series";
  year: string | null;
}

/** Searches Cinemeta for movies and series by title. Movies come first. */
export async function searchTitles(query: string, perType = 6): Promise<SearchResult[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const types: ("movie" | "series")[] = ["movie", "series"];
  const lists = await Promise.all(types.map((t) => search(t, q)));
  return lists.flatMap((metas, i) =>
    metas
      .map((m) => ({ m, id: m.imdb_id ?? m.id }))
      .filter(({ id }) => id.startsWith("tt"))
      .slice(0, perType)
      .map(({ m, id }) => ({
        imdbId: id,
        name: m.name,
        type: types[i] as "movie" | "series",
        year: m.releaseInfo ?? null,
      })),
  );
}

/** Looks up the TMDB id for an IMDb id through Cinemeta. Returns null when it has none. */
export async function getTmdbId(type: "movie" | "series", imdbId: string): Promise<number | null> {
  const res = await fetch(`${CINEMETA}/meta/${type}/${imdbId}.json`);
  if (!res.ok) return null;
  const json = (await res.json()) as { meta?: { moviedb_id?: number } };
  return json.meta?.moviedb_id ?? null;
}
