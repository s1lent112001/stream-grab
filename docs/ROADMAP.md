# StreamGrab roadmap

Plan agreed on 2026-11-11. Released versions are in [CHANGELOG.md](../CHANGELOG.md); v0.9.0
(public Chrome Web Store listing) is the latest.

StreamGrab is built and tested by one person. There is no beta group: the release candidate is
checked against the checklist below, and then the public Chrome Web Store listing collects real
use. 1.0.0 means "stable and public", not a feature milestone.

| Version | Content |
|---|---|
| v0.6.0 | Range resume for the progressive engine fallback; a failed forced-MP4 task switches to MKV and is merged again from the stored segments; audio size known earlier for estimates |
| v0.7.0 | Subtitles |
| v0.8.0 | Chrome Web Store preparation (below) |
| v0.9.0 | Chrome 116 check, then a **public** Chrome Web Store listing; multi-GB check during the review (below). Released 2026-11-13 |
| v0.9.x | Fixes asked for by the store review, and bugs reported after the listing; no new features |
| v1.0.0 | After 2–3 weeks on the store without serious bugs (checks and e2e pass on the newest Chrome and Chrome 116); new repository, store search (name, summary, description) done in full, uploaded to the store (below); no feature change |
| v1.1.0 | Junk filter, Settings in sections (below) |
| v1.2.0 | Video previews instead of the static icon (below) |
| v1.3.0 | Tab recording for live streams and players that hide their segments (below) |
| v1.4.0 | Translations (`_locales`) and a gentle rating prompt (below) |
| Later | fMP4 `wvtt` subtitles (deferred from 0.7.0, again on 2026-11-23); no version yet |

Not planned: DRM, SAMPLE-AES, live download of segments (v1.3.0 records the tab instead), an "always ask where to save" setting (Chrome's own
setting does it), an Open file button (needs `downloads.open`), an FFmpeg upgrade, Edge and Firefox
versions (decided 2026-11-16: Chrome only).

## Funding: donate-only (decided 2026-11-12)

StreamGrab stays free and fully featured, funded by voluntary donations only (see the Donate link
item under v0.8.0). No paid plan, license check or feature limit is built for 0.x or 1.0.0.

A paid plan is a question for after v1.0.0, and only if there is real demand. If it comes:

- Only **new** features may be paid; nothing users already have for free is removed or limited.
- It needs its own payment provider (Chrome Web Store payments no longer exist), a license server,
  an updated privacy policy (a license check is a network call, so "nothing is sent anywhere" no
  longer holds) and a host permission for that server.
- Selling makes the developer a "trader" under the EU DSA: name and address shown publicly on the
  store listing.
- The code is GPL-3.0-or-later, so anyone can fork it without the check; the limit only stops
  ordinary users. The license stays GPL (the bundled FFmpeg core is GPL).
- The store description must not promise "free forever".

## v0.6.0: phases

1. Analysis and Chrome spikes (done 2026-11-11): a worker's OPFS sync access handle keeps every
   written byte when the offscreen document closes or Chrome is killed, and `Range` + `If-Range`
   from the offscreen document continue the file byte for byte.
2. Range resume of a video file the engine downloads (when the site needs the page's Referer):
   written to OPFS, continued after an error, a Retry or a browser restart. Without an `ETag` or
   `Last-Modified` from the server it starts again from the beginning, as Chrome does.
3. A failed forced-MP4 task gets a "Save as MKV" button that merges the stored segments again;
   the first segments of every track are fetched early so the size estimate includes audio sooner.
4. Regression tests, docs, release (done 2026-11-11).

## v0.7.0: subtitles

Scope agreed on 2026-11-12. Today every subtitle is dropped: HLS `TYPE=SUBTITLES` renditions and
DASH text adaptation sets are ignored, and the merge maps only video and audio.

- **Sources:** WebVTT text subtitles from HLS `TYPE=SUBTITLES` renditions (segmented `.vtt`),
  DASH text adaptation sets with `mimeType="text/vtt"` (one file or segments), and
  `<track src>` elements on a page's `<video>` for progressive MP4/WebM.
- **Joining:** segmented WebVTT is joined into one file (repeated headers removed) and its cue
  times are aligned with the video through `X-TIMESTAMP-MAP`.
- **Output:** by default each chosen subtitle is saved as a **separate file** next to the video
  (`.srt` by default; `.vtt` is a setting). A setting switches to embedding it in the merged file instead (MKV keeps
  WebVTT; MP4 needs `mov_text`) or doing both. Progressive files are never merged, so they always
  get separate files. Each track keeps its language and name, as audio tracks do.
- **UI:** subtitles are picked by language in the Detected tab, like audio tracks; Settings has
  default subtitle languages and the output mode.
- **Not planned:** subtitles inside fMP4 (`wvtt`, `stpp`/TTML; FFmpeg 5.1 handles them poorly),
  CEA-608/708 captions inside the video stream, image subtitles, burned-in subtitles.

Phases:

1. Analysis and Chrome spikes (done 2026-11-12): the bundled FFmpeg 5.1.4 core has the WebVTT
   demuxer, muxer and codec, the SRT muxer and the `mov_text` encoder; Matroska keeps WebVTT and
   both files still play in Chrome. A `STYLE` block makes its WebVTT demuxer drop every cue, so
   joined files leave it out. FFmpeg does not move a subtitle input to 0, so cues are written on
   the merged file's timeline and get no `-itsoffset`: `cue − LOCAL + MPEGTS/90000 − first PTS of
   the run + start of the run` (the concat demuxer starts a run at the sum of the earlier runs'
   durations), as hls.js does. A cue after the video's end lengthens the file, so cues are cut
   there. Chrome keeps `.vtt` for `text/vtt` and `.srt` for `application/x-subrip` (an untyped or
   `text/plain` Blob becomes `.txt`), from a blob: or a data: URL; `uniquify` renames a subtitle on
   its own, so its name is taken from the saved video's final name.
2. Parse HLS/DASH subtitle renditions and `<track>`, download and join WebVTT, save separate
   `.vtt`/`.srt` files; unit tests. Split in two:
   - 2a (done 2026-11-12): WebVTT parser, joiner (dedupe, split cues, cut to the video) and SRT
     writer; HLS `TYPE=SUBTITLES` and DASH `text/vtt` tracks (fMP4 text skipped); `<track>` of
     progressive files; subtitle lists in the Detected data, requests, tasks and the engine spec;
     Settings `subtitleFormat` (SRT by default).
   - 2b (done 2026-11-12): the engine downloads subtitle segments with the others (a subtitle
     playlist or segment that fails never fails the video), joins them on the merged file's
     timeline (joined runs probed one by one; a segment after a timestamp reset goes to the part it
     fits), and the files are saved after the video as `<video name>.<lang>.srt|vtt`; the task
     completes once they are saved. Progressive `<track>` files are fetched by the service worker
     and saved as data: URLs (at most 1.5 MB each). Cancel, Retry and a restart cover them.
     Not yet shown in the popup (Phase 3).
3. Embed in MKV/MP4 (when the setting asks for it), subtitle picker in the popup, Settings; e2e.
   Split in two:
   - 3a (done 2026-11-12): Settings `subtitleMode` (file by default, embed, both) and
     `subtitleLanguages`; the cues are timed before the merge and embedded after the audio
     (MKV keeps WebVTT, MP4 gets `mov_text`; language, name, none default, though FFmpeg's MP4
     muxer always enables the first one), cut at the video's expected end and counted when the
     result is checked. A merge that fails with subtitles is run again without them, and they are
     saved as files instead.
   - 3b (done 2026-11-12): subtitle picker in the Detected tab's Options (one track per
     Settings language ticked, in that order, never a forced one; a note says where they go),
     Settings rows for the languages, where subtitles go (Files / In video / Both) and the file
     format (SRT / WebVTT), and a Subtitles line in the Completed tab; e2e on a subtitled HLS
     demo stream through the real popup.
4. Regression tests, docs, release (docs and checks done 2026-11-12). fMP4 subtitles (`wvtt`) stay
   out: a real DASH stream with only `wvtt` text (Shaka's Angel One demo) shows none. A parser of
   its own (about 600 lines) is a candidate for a later version.

## v0.8.0: Chrome Web Store preparation

Done (2026-11-13). YouTube is blocked; no permission could be dropped; the About screen and the
Ko-fi line are in the popup; the privacy policy is [PRIVACY.md](PRIVACY.md) (no GitHub Pages site
needed). i18n was skipped. The plan as written:

- **Block YouTube** (`youtube.com`, `googlevideo.com`): the Chrome Web Store policy does not allow
  extensions that download YouTube videos, and this is the most common rejection for video
  downloaders. The code has no such block today.
- **Privacy policy page** (for example on GitHub Pages): everything runs in the browser, nothing
  is sent anywhere. Its URL goes into the store's Privacy practices tab.
- **Permission justifications** for the Privacy practices tab: `webRequest`,
  `declarativeNetRequestWithHostAccess`, `downloads`, `offscreen`, `unlimitedStorage`,
  `notifications`, the `http://*/*` and `https://*/*` host permissions, and the content script on
  every page. Drop any permission that turns out not to be needed. The broad host access means a
  longer, more careful review.
- **About section** in the popup: version, source link (GPL-3.0 and FFmpeg's GPL), a "Report a
  problem" link to GitHub Issues, and the donate link.
- **Donate link**: in the About section, the store description and the README
  (`.github/FUNDING.yml` adds GitHub's Sponsor button). It must stay voluntary: no feature behind
  it, no nagging popups, no misleading wording ("donate for faster downloads").
- Optional: i18n (English and Vietnamese).

## v0.9.0: self-test checklist

Automated tests (`npm run check`, `npm run test:e2e`) cover most behaviour. Changed on 2026-11-13:
the store listing comes first, and the 1–2 weeks of daily use on many sites is dropped (public store
users take that role, through the Report a problem link). Order:

1. **Chrome 116** (`minimum_chrome_version`): run the e2e suite in Chrome for Testing 116 before the
   first upload, because the store shows the minimum version. If it fails, raise the minimum version
   instead of changing code.
   Done 2026-11-13: Chrome for Testing 116.0.5845.96 passes (10 tests; the 2 that open the popup
   window need Chrome 127 for the test harness). Two failures were real bugs on every version, fixed
   in code: a stale job list made the engine download a finished task again and delete its segments
   (also seen on Chrome 157, about one run in three), and Chrome 116 lists earlier downloads a moment
   after startup.
2. **Release v0.9.0** (CHANGELOG, version, ZIP, GitHub Release; done 2026-11-13) and submit it to the store as a
   public listing.
3. While the review runs (usually a few days): **nearly full disk** (the Downloads folder, then the
   profile, on a small VHD of a few GB; check the disk-space messages) and **multi-GB video**
   (measure Chrome's RAM during a merge with OPFS output, v0.4.0). Fixes ship as 0.9.x.
   Done 2026-11-16 for the multi-GB video: 2.9 GiB merged, peak +540 MiB over rest, browser process
   flat (see ARCHITECTURE, Merged files on disk). The nearly-full-disk test with a VHD is dropped:
   it needs changes to the test machine's disks; the error paths stay covered by unit tests.

A first review often asks for changes (permission wording, policy); fixing them during 0.9.x keeps
1.0.0 free of that.

## v1.1.0–v1.4.0: features after 1.0.0 (agreed 2026-11-20)

One version at a time, each in user-approved phases (one session per phase, checks and e2e at the
end of each phase). v1.1.0 to v1.3.0 are released on GitHub only (tag, CHANGELOG, ZIP); after
v1.0.0 the store gets its next update with v1.4.0 (decided 2026-11-23), which carries every feature
of v1.1.0 to v1.4.0 in one review. Fixes for serious bugs that store users report still go
to the store as patch releases in between. Only v1.3.0 adds a permission (`tabCapture`), so the
v1.4.0 review is the first one to see it.

**Store listing.** The store search reads only the name, summary and description. Each version's
release step updates the local listing draft for what it adds, in everyday words first and
technical terms after (never a list of repeated keywords: the store rejects that as spam).
v1.0.0 does the full search work; from then on every version adds the search words for its own
features as part of its release step. The store sees the listing with v1.0.0 and then with v1.4.0,
so the listing never promises a feature the store version lacks.

| Version | Name | Summary | Description |
|---|---|---|---|
| v1.0.0 (store) | **StreamGrab - Video Downloader** | New, everyday words (below) | Rewritten: everyday words first, technical terms after |
| v1.1.0 | Same | Same | Draft: "Show hidden" junk filter line |
| v1.2.0 | Same | Same | Draft: a line on video previews (not a search term) |
| v1.3.0 | Draft: **StreamGrab - Video Downloader & Recorder** | Draft: add "record" and "live streams" | Draft: a section on tab recording (what it saves, WebM, tab must stay open); remove "Live streams are not listed"; justification for `tabCapture` |
| v1.4.0 (store) | The part after "StreamGrab" translated | Translated | Whole listing translated, with every feature up to v1.4.0 |

**v1.0.0: new repository and store search.** No feature change. In this order:

1. **New repository.** The project moves to a new GitHub repository (new account, fresh history).
   Every project link points to it: README, CHANGELOG, PRIVACY, the About page links and their test.
2. **Store search (SEO), done in full.** Name **StreamGrab - Video Downloader** (the brand stays
   "StreamGrab": toolbar title and `short_name` too). "& Recorder" is added with v1.3.0, when tab
   recording exists, so the name never promises a missing feature. Summary in everyday words, because most users
   do not know what HLS, DASH or m3u8 are: "Video downloader for websites: pick the quality and
   save one MP4 file with sound and subtitles. Supports HLS (m3u8) and DASH." Description rewritten
   with everyday words first and the technical terms after. Screenshot captions and the promo
   tiles use the same words (they do not change search, but they turn a search hit into an install).
3. **Release**: version, CHANGELOG, GitHub Release in the new repository, ZIP, store upload. In the
   store console: the new description, and the homepage, support and privacy policy URLs of the new
   repository.
4. Only after v1.0.0 is live on the store: the old repository is closed.

Done 2026-11-23: steps 1 to 3 (new repository, name and summary in the manifest, listing draft,
release 1.0.0). Next: the store upload, then step 4.

**v1.1.0: cleaner list and settings**

- **Junk filter.** Do not list ads, thumbnails, sprite sheets and hover previews: too short or too
  small media, known ad hosts, paths such as `thumb`, `preview`, `sprite`. The popup gets a "Show
  hidden" switch, because a heuristic will sometimes hide a real video.
- **Settings in sections** (for example Downloads, Subtitles, Detection, Appearance), before v1.3.0
  adds recording settings. Uses the existing design system.

Decided 2026-11-23:

- **Cautious filter**: a missed ad is better than a hidden video. A video is hidden when it comes
  from a known ad host, or when it is short (about 10–15 s) **and** has one more weak signal (a
  path word such as `thumb`, `preview`, `sprite`, `hover`, `ad`; a file under about 1 MB; under
  about 240p). A path word alone never hides a video. Never hidden: live streams, the page's only
  video, a video of a minute or more (its own length, else its `<video>` element's). Refined in
  Phase 1: an ad host hides even a long video (an ad can play in the page's own `<video>` element
  and report that video's length); the `<video>` element's length counts only when the stream does
  not know its own; `ad` / `ads` count only as a separate path word, not inside an id.
- **Marked, not dropped**: the stream keeps a `hidden` reason; the badge and "Select all" count
  only visible videos. Videos still being inspected that already match a host or path rule are
  hidden from the start, so they do not appear and then vanish.
- **Two switches**: a setting "Hide ads and previews" (Settings → Detection, on by default), and a
  "N hidden · Show" line in the popup that shows them until the popup closes.
- **Duration of MP4 / WebM files** read from the first bytes the file inspector already fetches
  (`mvhd` of a faststart MP4, `Info/Duration` of WebM); no extra request. Without it the
  "short" rule could not catch hover previews, which are mostly MP4.
- **Settings sections**: Downloads (segment requests, simultaneous downloads, resolution, output
  format, subfolder, remove finished tasks), Subtitles (languages, where they go, file format),
  Detection (detect automatically, hide ads and previews), Appearance (theme). Headings on one
  scrolling page, no tabs or accordions; element ids unchanged; Reset stays at the bottom.

Phases (one session each, checks and e2e at the end of each):

1. `core/detection/junk-filter.ts` (pure rules), the `hidden` field, MP4 / WebM duration in the
   file inspector; unit tests with sample URLs and file heads. **Done 2026-11-23**
   (`core/detection/media-head.ts` also reads the picture size).
2. Wiring: detection manager, badge, the setting, the popup "Show hidden" line, selection;
   e2e fixtures for an ad and a hover preview. **Done 2026-11-23**: the manager marks streams
   before every save; setting `hideJunk`; the popup line reads "2 ads or previews hidden · Show"
   and shown ones carry a "Likely an ad" / "Likely a preview" tag; an MP4 / WebM file's own
   length is shown in the popup; the e2e Chrome resolves a real ad host to the fixture site.
   "The page's only video" became: a page never lists nothing because of the filter; when every
   video would be hidden, the best guess (longest, else biggest; not from an ad host first) stays.
   The "Show" choice lasts until the popup closes, across its tabs.
3. Settings in sections, checked in the real popup in Chrome.
4. Regression, docs (CHANGELOG, README, SPEC), version 1.1.0, ZIP, GitHub Release, listing draft
   line for "Show hidden".

**v1.2.0: video previews.** A picture for each detected video instead of the static icon, in this
order: (C) the `poster` of the page's `<video>`; (A) a frame of an MP4 / WebM file, read by a hidden
video element in the offscreen document (with the page's Referer); (B) a frame of the first HLS / DASH
video segment (with its init segment for fMP4), decoded by the bundled FFmpeg; (C) the page's
`og:image`; then the static icon. Previews are made lazily (popup open, item visible) and cached;
none for DRM.

**v1.3.0: tab recording.** "Record this tab" saves what the tab plays, for live streams and for
players that hide their segment addresses. `chrome.tabCapture` + `MediaRecorder` in the offscreen
document, WebM, written to OPFS in chunks so an interruption keeps what was recorded; the tab's
sound is played back through an `AudioContext` while it is captured. The user starts it from the
popup. Re-encoded at the quality the tab shows; the tab must stay open; DRM records black.
Chosen over hooking the page's player (needs `scripting`, a main-world script and tricks that keep a
hidden page playing: a store-review risk). Phase 1 is a spike in Chrome 116 and the newest Chrome:
does a captured tab keep playing when its window is covered by other windows for 10+ minutes; can
`tabCapture` be an optional permission asked on the first recording, and does it show an install
warning (a new warning disables the extension for current users until they accept it). The store
description and permission justifications change with it.

**v1.4.0: translations and rating prompt.**

- **Translations** of the UI and the store listing with `_locales`, Vietnamese first. The store
  searches each language's listing, so this is also search reach for people who search in their
  own language.
- **Rating prompt.** After about five successful downloads, one line in the popup links to the
  store's review page; it can be dismissed for good and never comes back by itself.

Dropped (2026-11-20): download a time range, audio only, file name templates, copy the stream URL
or an ffmpeg command.
