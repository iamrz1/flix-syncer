export interface ProgressMessage {
  kind: "progress";
  currentTime: number;
  duration: number;
}

export interface LoginMessage {
  kind: "login";
  email: string;
  password: string;
}

export interface LogoutMessage {
  kind: "logout";
}

export interface StatusRequest {
  kind: "status";
  tabId?: number;
}

export interface SetDebugMessage {
  kind: "setDebug";
  on: boolean;
  tabId?: number;
}

export type Message = ProgressMessage | LoginMessage | LogoutMessage | StatusRequest | SetDebugMessage;

/**
 * detected: matched to an IMDb id (and an episode, for series).
 * no-episode: matched a series but the title has no season and episode.
 * no-match: a long video is playing but the title matched nothing.
 * too-short: a playing video under the minimum length, ignored.
 */
export type DetectState = "detected" | "no-episode" | "no-match" | "too-short";

export interface Detected {
  state: DetectState;
  /** Raw tab title. */
  title: string;
  /** Title after cleanup, as sent to Cinemeta. */
  query: string;
  name: string | null;
  imdbId: string | null;
  type?: "movie" | "series";
  season?: number;
  episode?: number;
  ratio: number;
  duration: number;
  synced: boolean;
  at: number;
}

export interface LogEntry {
  at: number;
  text: string;
}

export interface Status {
  loggedIn: boolean;
  debug: boolean;
  current: Detected | null;
  log: LogEntry[];
  error: string | null;
}
