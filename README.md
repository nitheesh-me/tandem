# Tandem landing page

Live at <https://nitheesh-me.github.io/tandem/>. Everything on it comes from `config.json`.

- `ticket`: the show, date, time, seat and the rest of the VIP pass.
- `trailer`: the main stage. While `sources` is empty the stage is a premiere card for the music video.
  List the video as `{ "src": "media/….mp4", "type": "video/mp4" }` in `sources` and the stage becomes a
  player again, with `title`, `note`, `poster` and `shape` (for example `"16 / 9"`).
- `anthem`: the song behind "Sound on": its sources, art and the timed lyrics in `media/anthem-lyrics.json`.
- `showcase`: the setlist, each song with a `title`, one line of `text` and a `glyph`
  (`sync`, `clock`, `heart`, `bars`, `down`, `subs`, `live` or `screens`).
- `facts`: the crowd's call and Tandem's answer. `download`: the encore's note and download links; the
  "Opening soon" tag shows until `links` has an entry. The join page shows the same note and links.
- `screening`: the public screening room. `invite` is its ticket, `label` the button's words, `name` the
  room's name on a pass, and `note` one line about it. The join page and the browser version offer it
  when a link has no invite or a broken one, and name the room when someone opens its invite.

The pass maker is for hosts, so it sits behind the footer link "Hosting a show? Make a pass" and at `#make`.

A link can change a ticket without editing anything, after the `#`:
`#show=Friday%20Film&date=Friday&time=21:00&seat=Sofa&invite=tandem://join/tandem1...`

The part after `#` is not sent to a server. An invite works like a password, so share those links with care.
The code printed on the pass carries the show, date, time and seat, never the invite.

## Files

- `index.html`, `stage.css`: the landing page, staged as a live show.
- `app.js`: fills the landing page from `config.json`.
- `invite.js`: reads an invite on the device (no network) for `join/` and `watch/`: the ticket from any
  link form, whether it is complete, and how many Stations it lists. The ticket carries no room name.
- `join/`: the box office. Opens the app (an `intent://` link on Android, which comes back to
  `join/#<ticket>&noapp` when the app is missing; elsewhere it waits 1.6 s and says plainly if the app did
  not open), or the browser version. Without a usable invite it explains why and offers the screening.
- `watch/`: the browser version, a Station in a Worker (`station.worker.js`, `pkg/` from
  `crates/tandem-web` in the app repository, built with its `build.sh`). The page shows each stage with
  real figures: the wasm download, the relay, the room, the picture and the sync. Address options after
  the `#`: `invite=` (required to join), `window=` (chunks kept ahead), `windowkb=` (QUIC receive window
  for tests), `forget=` (chunk numbers to drop, for tests), `nobuckets` (plain OPFS), `small` (ask a
  native Station for its converted smaller picture). Keys: F fullscreen, M sound.
- `show.js`: the intro count-in, the pass's tilt and code, the anthem and its karaoke line.
- `arena.js`: the WebGL arena behind the hero, one fragment shader with no library. It loads after the page,
  draws at a reduced resolution capped at 1.5x the pixel ratio, and stops off-screen or in a hidden tab.
- `style.css`: used by `join/` and `watch/`, with the landing page's tokens, header and buttons.
- `vendor/`: pinned third-party code, see `vendor/LICENSES.txt`. Fonts are under `fonts/LICENSES.txt`.

With reduced motion the show is still: no count-in, sweeps, rolls or tilt, and the arena is one still frame.
The anthem never plays by itself; "Sound on" starts it and the same button, or Escape, stops it.

The anthem and the key art were made with Google Gemini by the project owner. The art is cropped so the
generator's mark is out of frame.
