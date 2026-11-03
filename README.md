# Tandem landing page

Live at <https://nitheesh-me.github.io/tandem/>. Everything on it comes from `config.json`.

- `ticket`: the show, date, time, seat and the rest of the VIP pass.
- `trailer`: the main stage video, its poster and its shape. To swap in a new cut, change `src`, or list
  `sources` as `{ "src", "type" }` pairs (they win over `src`).
- `anthem`: the song behind "Sound on": its sources, art and the timed lyrics in `media/anthem-lyrics.json`.
- `showcase`: the setlist, each with an image, a title and text. `bsides` is the short list under it.
- `facts` and `download`: the crowd chants and the encore's download links.

A link can change a ticket without editing anything, after the `#`:
`#show=Friday%20Film&date=Friday&time=21:00&seat=Sofa&invite=tandem://join/tandem1...`

The part after `#` is not sent to a server. An invite works like a password, so share those links with care.
The code printed on the pass carries the show, date, time and seat, never the invite.

## Files

- `index.html`, `stage.css`: the landing page, staged as a live show.
- `app.js`: fills the page from `config.json`, and runs the join page. Shared with `join/`.
- `show.js`: the intro count-in, the pass's tilt and code, the anthem and its karaoke line.
- `arena.js`: the WebGL arena behind the hero, one fragment shader with no library. It loads after the page,
  draws at a reduced resolution capped at 1.5x the pixel ratio, and stops off-screen or in a hidden tab.
- `style.css`, `contour.js`: used by `join/` and `watch/` only.
- `vendor/`: pinned third-party code, see `vendor/LICENSES.txt`. Fonts are under `fonts/LICENSES.txt`.

With reduced motion the show is still: no count-in, sweeps, rolls or tilt, and the arena is one still frame.
The anthem never plays by itself; "Sound on" starts it and the same button, or Escape, stops it.

The anthem and the key art were made with Google Gemini by the project owner. The art is cropped so the
generator's mark is out of frame.
