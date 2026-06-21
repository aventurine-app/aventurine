# Oliv Design System (component library)

A curated, **previewable** catalogue of Oliv's shared UI — buttons, controls,
modals, navigation, tokens — authored as standalone HTML cards. This is a
*separate artifact* from the app: it documents and showcases the styling, it
does not ship in the Electron build.

## Why it exists

1. **A visual canvas** to point at when requesting changes ("make the primary
   button rounder", "tighten the settings rows") instead of describing them.
2. **The bundle synced to Claude Design** (claude.ai/design) via the
   `/design-sync` skill, so the same gallery is browsable there.

## How it stays true to the app

Every card **links the real stylesheets** (`../../static/css/style.css`,
`themes.css`, and the relevant component CSS) — it does **not** copy them. Edit
the app's CSS and the cards update on refresh. `static/css/` remains the single
source of truth for tokens and component styles; these files only arrange
real markup to show each piece in isolation, in both light and dark.

## Layout

```
design-system/
  index.html              ← open this to browse every card locally
  _canvas.css             ← preview-only chrome (frame, light/dark split) — NOT app styling
  components/
    foundations-color.html    Foundations · semantic color tokens
    foundations-type.html     Foundations · type scale, families, weights
    buttons.html              Components  · .db-btn family
    form-controls.html        Components  · text input, select, slider
    segmented-toggle.html     Components  · radio-backed pill group
    feedback-states.html      Components  · empty state + skeletons
    settings-card.html        Patterns    · label/control rows
    modal.html                Patterns    · shared dialog frame
    sidebar-nav.html          Patterns    · navbar sections + active state
```

Each card's first line is a `<!-- @dsCard group="…" name="…" -->` marker. The
Claude Design pane builds its card index from those markers, so grouping/naming
in the gallery comes straight from the files — no separate registration.

> **Note on fonts:** opened as a plain file, `@font-face` URLs (`/static/fonts/…`)
> don't resolve, so cards fall back to system fonts. Colours, spacing, weights,
> and layout are all faithful. Inside the app the real fonts load normally.

## Local preview

Open `design-system/index.html` in a browser, or any single card directly.

## Syncing to Claude Design

Synced to the **Oliv Design System** project on claude.ai/design.

The cards reference app CSS by relative path (`../../static/css/…`), which points
at the live app for the local canvas but resolves outside the project on the
remote. `build-bundle.sh` bridges that: it copies the referenced stylesheets
into `.sync/static/css/` and rewrites the link to `../static/css/…` so each card
renders standalone on claude.ai.

To re-sync after editing components or tokens:

1. `./build-bundle.sh` — regenerates `.sync/` (gitignored).
2. Drive the `DesignSync` tool: `finalize_plan` with `localDir` = the printed
   `.sync` path and the same `writes` globs, then `write_files`. Read →
   finalize_plan → write is the required order.

## Adding a component

1. Copy an existing card in `components/`.
2. Set the first-line `@dsCard` marker (`group`, `name`, optional `subtitle`).
3. Link the component's CSS file and drop in **real markup** (copy from the app,
   don't re-style).
4. Add a tile to `index.html`.
