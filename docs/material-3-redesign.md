# Material You / Material Design 3 redesign

## Scope

Replace the previous midnight-post-office presentation across the local hub, viewer panel, broadcaster configuration, operator console, setup, archive, OBS overlay and extension overlay. Preserve the existing static HTML/JavaScript architecture and all application contracts. The right-side Claude owns the frontend implementation; Codex owns integration and verification.

## Design acceptance

- Semantic Material 3 color roles, tonal surfaces and containers, with coherent light and dark themes.
- Sans-serif typography with explicit display, headline, title, body and label roles.
- Filled, tonal, outlined and text actions with appropriate hierarchy, shape, focus, hover, pressed and disabled states.
- Responsive controls at a 318/320 px Twitch panel, 390 px mobile and desktop sizes.
- Transparent overlay canvas and readable reveal content at 1920 x 1080.
- Keyboard access, visible focus, readable contrast and reduced-motion support.
- Locally served assets; no new remote runtime dependencies.

## Functional acceptance

Preserve note composition, moderation, sealing and hidden-body behavior; simulated payment labels; configuration; setup authorization; event CRUD and preset replacement confirmation; source-labelled event candidates; human confirmation/dismissal; polling draft and keyboard-focus preservation; cooldown and retry semantics; reveal, archive and wrap-up.

Tests use only isolated local servers, synthetic identities and mocked providers. Do not enable real Decisions, OBS or Twitch connections. Do not read or change real `.env` values. No commits, public deployment or Hosted Test upload belongs to this redesign checkpoint.

## References

- [Material 3 color roles](https://m3.material.io/styles/color/the-color-system)
- [Material 3 typography](https://m3.material.io/styles/typography/applying-type)

## Verification

The right-side Claude completed the rewrite. Codex reviewed the changed source and the light hub, narrow dark panel, dark event list and broadcast reveal screenshots. Actual user Chrome loaded the updated operator console and the local demo panel. Clicking the theme control changed the computed surface to `rgb(20, 18, 24)` in dark mode; the preview was returned to automatic mode.

| Command | Result | Scope |
| --- | --- | --- |
| `npm test` | 271/271 pass | Local unit/integration tests; independently rerun by Codex |
| `npm run test:browser` | 72 checks pass | Viewer, configuration, review, reveal, private notification and transparent overlays |
| `npm run test:ksp-browser` | 19 checks pass | KSP candidate workflow |
| `npm run test:events-browser` | 42 checks pass | Event CRUD/import/candidates and polling preservation |
| `npm run test:auth-browser` | 19 checks pass | Isolated private authorization lifecycle |
| `npm run test:material3-browser` | 161 checks pass | Eight pages, light/dark, 318 px panel and 390/1440 px layouts |
| `node test/extension-bootstrap.mjs` | 13 checks pass | Final staged ZIP cold start and dynamic-helper negative control |

The independent Material 3 check found and fixed two contrast defects: selected-category secondary text and reveal-header metadata. The redesign checkpoint sampled 1,268 core text instances with no contrast failures or uncomputed samples. Eight overlay PNGs had zero alpha at all four corners. No external requests, page errors or horizontal overflow were observed. These are targeted checks, not full WCAG certification. See [the machine-readable report](material3-evidence.json) for sampling and exclusions.

The original setup unit fixture rejected an added module import. The final implementation loads `common.js` separately from `setup.html` and leaves `setup.js` independent. Existing functional assertions remain unchanged. One intermediate unit run reportedly failed once without a captured cause; subsequent repeated runs, including the independent final run, passed 271/271.

Screenshots from the isolated local app:

- [Light homepage](../shots/m3-review-light-hub-1440.png)
- [Dark narrow panel](../shots/m3-review-dark-panel-318.png)
- [Dark event definitions](../shots/m3-review-dark-events-1440.png)
- [Light transparent OBS overlay](../shots/m3-review-light-overlay-1440-alpha.png)

## Changed files

Frontend: `public/styles.css`, `public/common.js`, `public/index.html`, `public/panel.html`, `public/config.html`, `public/archive.html`, `public/console.html`, `public/setup.html`. The unchanged overlay HTML/JS and event editor inherit the shared design. Only the local Instrument Sans font is now used; older font binaries are retained.

Verification/integration: `test/material3-browser.mjs`, `package.json`, `docs/material3-evidence.json`, regenerated `docs/browser-evidence.md` and `docs/private-auth-evidence.md`, plus this report, README, provenance, Hosted Test note and progress record. Backend contracts, presets and real `.env` values were not changed.

## Artifacts and remaining boundary

`dist/extension.zip` is staged locally with 13 files, including the synchronous Twitch helper in all three packaged HTML pages:

```text
MD5     272a7fea5d4a1f1af2c7015402bd65a4
SHA-256 e3daf120bd1ba4aced0a5088e06b0f41dbdbfafa03938c45511a5103054103e2
```

This Material 3 ZIP has not been uploaded to Twitch. The current Hosted Test upload remains the previous design; its archive is preserved as `dist/extension-hosted-20261101.zip`. The persistent local console serves the new design. The in-memory preview is running at `http://127.0.0.1:8790/` without reading `.env`.

Live Twitch iframe acceptance of this redesign, real OBS composition and live provider behavior remain unverified. No broadcast, real charge, commit or remote deployment was performed for this redesign.

The staged ZIP was rebuilt after the operator preset UI added shared styles. The digests above describe that current local archive; it remains unuploaded. See `game-presets.md` for the later operator checkpoint.

## Viewer composer superseded

The later viewer-panel redesign uses Claude's independent airmail stationery direction, as requested by the user. `public/panel.css` is isolated from the console/overlay styles. The Material Design 3 evidence above is historical; the composer redesign has its own verification in `docs/panel-redesign.md`. The new local design and staged extension archive do not establish that Twitch Hosted Test was updated or that the blank iframe problem is fixed.
