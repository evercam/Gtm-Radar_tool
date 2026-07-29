# GEM tracker files

Drop Global Energy Monitor JSON exports here (e.g. `solar.json`, `nuclear.json`,
`wind.json`, `coal_plant.json`, …). The **GEM Upload** page's *Load from server
folder* button reads this folder by default.

- Keep GEM's original filenames — the tracker type is detected from the filename.
- To read from a folder outside the repo instead, set `GEM_DATA_DIR` in
  `.env.local` to an absolute path.
- These data files are git-ignored; only this README is tracked.
