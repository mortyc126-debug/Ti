# Repository Structure Review

_Branch: `claude/review-repo-structure-JDU5d` — review performed 2026-04-12._

## TL;DR

The repository contains **29 HTML files** that are all progressive revisions of a
single Russian-language bond-analytics single-page app (`БондАналитик`). There
is no build system, no source/asset split, no README, no licence, and no
meaningful commit history. `index.html` is **not** the newest revision.

Before further development this repo should be collapsed to a single canonical
source file, given the usual project metadata, and version-tracked through real
commits rather than snapshot uploads.

## Inventory

| Category | Count | Notes |
| --- | ---: | --- |
| Numbered snapshots `bond-platform-N[.M].html` | 27 | sizes grow 104 KB → 325 KB |
| `index.html` / `index-1.html` | 2 | both identical to the v10/v16 snapshot |
| Duplicate byte-identical files | 4 | see below |
| README / LICENSE / docs | 0 | none |
| `.gitignore` | 0 | none |
| Build / lint / test config | 0 | none |

Total tracked: **29 files, ~6.1 MB**.

### Duplicate files (same MD5 `39bdd24a4683…`)

- `bond-platform-10.html`
- `bond-platform-16.html`
- `index.html`
- `index-1.html`

All four are identical — they are the v10 snapshot re-uploaded under different
names. `index.html` is therefore **~176 KB behind** the latest revision
(`bond-platform-30-1-1.html`, 325 KB / 5 322 lines).

### Version lineage (chronological by size)

```
v3    → v4  → v5  → v6  → v7  → v8  → v9
v10 (≡ v16 ≡ index ≡ index-1)
v17 → v19 → v20 → v21 → v22
v23 → v23-1
v24
v25 → v25-1 → v25-3
v26 → v27
v29 → v29-1
v30 → v30-1 → v30-1-1   ← latest
```

Gaps (`v11–v15`, `v18`, `v28`) are missing, and the `-1`/`-3` suffixes are
undocumented — a reader cannot tell whether they are hot-fixes, experiments, or
alternative branches.

## Problems

1. **No single source of truth.** A developer or auditor cannot tell which file
   is authoritative without `diff`-ing every pair. `index.html` (the only file
   GitHub Pages would serve by default) is materially out of date.
2. **Snapshot-as-version-control.** Every commit message is
   `"Add files via upload"`; the real history (what changed between v29 and
   v30-1-1, and why) is lost. Git already provides this — snapshot files make
   git history pure noise.
3. **Duplicates waste ~600 KB** and create ambiguity about which copy is
   canonical.
4. **Monolithic HTML.** The latest file is a 5 322-line document with inlined
   CSS and JS. It will keep growing; splitting it into `index.html` +
   `styles.css` + `app.js` (or a small bundler setup) would make review,
   diffing, and refactoring dramatically cheaper.
5. **No project metadata.** Missing `README.md` (what is БондАналитик? how do I
   run it?), `LICENSE` (legal status unclear), `.gitignore` (risks committing
   editor/OS cruft later), and any description on the GitHub repo itself (which
   is also literally named `-`).
6. **Russian-only UI with no language note.** Fine as a product decision, but
   should be stated in the README so non-Russian contributors know what they
   are looking at.

## Recommended restructure

A minimal, low-risk layout:

```
/
├── index.html            # canonical = current bond-platform-30-1-1.html
├── README.md             # what it is, how to open, screenshot
├── LICENSE               # pick one (MIT / Apache-2.0 / proprietary)
├── .gitignore            # OS + editor + common web tooling
└── archive/              # optional: keep historical snapshots here,
    └── bond-platform-*.html   # or delete them — git already has history
```

Follow-up, once the above is in place:

- Extract the `<style>` block into `assets/styles.css`.
- Extract the `<script>` block into `assets/app.js`.
- Add a short `CHANGELOG.md` or use real commit messages going forward
  (`feat: add yield-curve panel`, `fix: rounding on coupon calc`, …) instead
  of re-uploading numbered files.
- Consider a GitHub Pages deployment from `main` so the live app always
  reflects the canonical `index.html`.

## Suggested immediate next steps (safe & reversible)

1. Promote `bond-platform-30-1-1.html` to `index.html` (overwrite the stale
   copy). Commit as `chore: promote v30-1-1 to index.html`.
2. Move the 27 numbered snapshots plus `index-1.html` into `archive/`
   (or delete — git retains them). Commit as
   `chore: archive historical bond-platform snapshots`.
3. Add `README.md`, `LICENSE`, `.gitignore`. Commit as `chore: add project metadata`.

These three commits can be made on this branch and reviewed before merging to
`main`. No existing content is lost — every snapshot remains recoverable from
git history.
