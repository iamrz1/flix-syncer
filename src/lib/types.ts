/** A possible title found in the page or player, and where it came from. */
export interface Candidate {
  source: string;
  text: string;
}

export interface ProgressMessage {
  kind: "progress";
  currentTime: number;
  duration: number;
  /** Titles found near the video, most specific first. The tab title is added by the background. */
  candidates: Candidate[];
}

/**
 * Sent by any frame whose URL contains an IMDb id, playing or not. The frame
 * holding the <video> is often nested inside the frame that has the id.
 */
export interface FrameUrlMessage {
  kind: "frameUrl";
  url: string;
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

export type Message = ProgressMessage | FrameUrlMessage | LoginMessage | LogoutMessage | StatusRequest | SetDebugMessage;

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
  /** Which candidate matched, e.g. "tab" or "player .vjs-title-bar". */
  source: string | null;
  /** One line per candidate tried, for the debug view. */
  tried: string[];
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
