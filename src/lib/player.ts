export interface PlayerSettings {
  /** URL template for movies. Placeholders: {imdb}, {tmdb}. */
  movieUrl: string;
  /** URL template for series. Placeholders: {imdb}, {tmdb}, {season}, {episode}. */
  tvUrl: string;
}

export const DEFAULT_PLAYER: PlayerSettings = {
  movieUrl: "https://vidsrc.mov/embed/movie/{imdb}",
  tvUrl: "https://vidsrc.mov/embed/tv/{imdb}/{season}/{episode}",
};

const KEY_PLAYER = "player";

export async function loadPlayer(): Promise<PlayerSettings> {
  const s = await chrome.storage.local.get(KEY_PLAYER);
  return { ...DEFAULT_PLAYER, ...(s[KEY_PLAYER] as Partial<PlayerSettings> | undefined) };
}

export async function savePlayer(p: PlayerSettings): Promise<void> {
  await chrome.storage.local.set({ [KEY_PLAYER]: p });
}

export interface PlayerVars {
  imdb: string;
  tmdb?: number | null;
  season?: number;
  episode?: number;
}

/** Whether a template needs the TMDB id, which costs an extra lookup. */
export function needsTmdb(template: string): boolean {
  return template.includes("{tmdb}");
}

/**
 * Fills a URL template. Returns null when a placeholder has no value or the
 * result is not an http(s) URL, so a bad template never opens anything odd.
 */
export function buildUrl(template: string, v: PlayerVars): string | null {
  const values: Record<string, string | number | null | undefined> = {
    imdb: v.imdb,
    tmdb: v.tmdb,
    season: v.season,
    episode: v.episode,
  };
  let missing = false;
  const url = template.trim().replace(/\{(\w+)\}/g, (_, key: string) => {
    const val = values[key];
    if (val === null || val === undefined) {
      missing = true;
      return "";
    }
    return encodeURIComponent(String(val));
  });
  if (missing) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}
