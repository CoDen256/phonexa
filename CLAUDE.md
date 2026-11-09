# CLAUDE.md

## phonexa — part of the Tun ecosystem

This repo is the **phonetics lab** and stays standalone: IPA charts, Formant
Lab, Shadowing, the live mic tracker. It is not coupled to Mjølnir.

Sibling repos (all under `/home/coden/dev/`): `tun` (deployment + ecosystem
docs), `mjolnir` (bundle tool, patches, builder, device hub), `stabbur`
(learning content), `smia` (linguistics), `hover-translate` (capture client).

**Cross-repo design, decisions, pitfalls and the roadmap live in
`/home/coden/dev/tun/docs/` — start at `README.md`, then `07-decisions.md`.**
Do not re-derive settled decisions.

See `README.md` in this repo for phonexa itself (pages, abstractions, docs/).

Note: `/stream` and `js/realtime.js` are deliberately **frozen** — see the
project README.
