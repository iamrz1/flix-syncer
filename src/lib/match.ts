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

interface Parsed {
  query: string;
  year?: number;
  season?: number;
  episode?: number;
}

const NOISE =
  /\b(watch|online|free|full|movie|hd|1080p|720p|4k|streaming|stream|episode|season|ep|s\d{1,2}e\d{1,3})\b/gi;

/** Strips site names and noise from a tab title and pulls out year, season and episode. */
export function parseTitle(raw: string): Parsed {
  let t = raw.split(/\s[|\-–—•·]\s/)[0] ?? raw;
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
  t = t.replace(/\(?\b(19|20)\d{2}\b\)?/g, " ").replace(NOISE, " ");
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
 * Resolves a page title to an IMDb id. Returns null when no result matches the
 * cleaned title exactly, so a wrong guess never reaches the library.
 */
export async function matchTitle(rawTitle: string): Promise<Match | null> {
  const p = parseTitle(rawTitle);
  if (p.query.length < 2) return null;

  const types: ("movie" | "series")[] = p.season !== undefined ? ["series"] : ["movie", "series"];
  for (const type of types) {
    const metas = await search(type, p.query);
    const hit = metas.find((m) => {
      if (norm(m.name) !== norm(p.query)) return false;
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
  return null;
}
