# flix-syncer

Chrome extension that detects a movie or episode playing on any site and marks it as watched in your Stremio library.

## Install

Download `flix-syncer-<version>.zip` from the latest release and unzip it. Open `chrome://extensions`, enable Developer mode, click "Load unpacked" and select the unzipped folder.

To build from source:

```shell
npm install
npm run build
```

Load `dist/` the same way. Use `npm run watch` while developing.

## Detection

The toolbar badge shows `•` when a movie or episode is detected and `✓` once it is synced. The popup shows the title, season and episode, and progress.

Turn on "Debug view" in the popup to see why a page was not detected. It adds a `?` badge for misses, the raw and cleaned title, and a log of recent events (matched, no match, ignored short video, sync errors).

## Release

Commits follow Conventional Commits. On every push to `main`, release-please updates a release PR with the version bump and `CHANGELOG.md`. Merging it creates the tag and GitHub Release, and the `Release` workflow attaches `flix-syncer-<version>.zip`. To rebuild the zip for an existing tag, run the workflow manually with `tag_name`.

## How it works

1. The content script runs in every frame and looks for a playing `<video>` longer than 10 minutes.
2. It reports `currentTime` and `duration` every 10 seconds. The background worker reads the title from the tab.
3. The title is cleaned (site name, year, season and episode removed) and looked up in Cinemeta. Only an exact name match is accepted, so a wrong guess never reaches your library.
4. At 80% of the runtime, the item is written to your Stremio `libraryItem` collection through `api.strem.io`.

Only the IMDb id, name and progress are sent. Page URLs are never sent. Your password is used once to get an `authKey` and is not stored.

## Limitations

- Series episodes update `video_id` and the play counters, but not the `watched` bitfield, so Stremio may not show each episode as watched yet.
- Titles that don't contain the name (e.g. a bare player page) are not matched.
- The Stremio API is unofficial and may change.
