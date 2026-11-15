# Bridges.directory

- `index.html`, `campus-*.webp`, `logos/`: Aman's original demo, kept unchanged as the design baseline. When a new version arrives, replace these files and commit; `git diff` shows exactly what changed.
- `docs/`: the small public site served by GitHub Pages (home, About, Contribute, Contact, legal pages). Built by `node tools/build-site.js .` from the original.
- Edit the three bracketed legal details in `tools/build-site.js` (`FILL`) and rebuild.
