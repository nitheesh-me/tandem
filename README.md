# media-4k: the screening film, in chunks

This branch holds the film the public screening room plays, cut into the
Tandem swarm's 4 MiB chunks, so the browser version can fetch it over plain
HTTPS from raw.githubusercontent.com instead of through a relay.

- `manifest.json`: the film's `root`, `size`, `chunk_size` and each chunk's
  blake3 hash. The root is blake3("tandem-root-v1" followed by every chunk
  hash), exactly as `tandem-engine` computes it, so it equals the root the
  room announces.
- `c00000.bin` ... : chunk `i` covers bytes `i * 4 MiB` up to the next chunk.

Nothing here is trusted: the browser checks the manifest against the room's
root and every chunk against its hash, and fetches a bad chunk from the room
instead. A new film means new chunks: replace this branch (force-push a fresh
orphan commit) and update `screening.mirror` in `config.json` on `main`.
