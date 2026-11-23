# reMarkable Sync for Zotero

A Zotero 8 / 9 / **10** plugin that keeps your PDFs, highlights and notes in sync
with a reMarkable tablet (reMarkable 1, 2, Paper Pro, Paper Pro Move) through the
reMarkable cloud. No external binaries or helper apps.

```
Zotero ──── PDF + Zotero highlights/notes ────▶ reMarkable
       ◀─── highlights, handwriting, typed text ──
```

## What it does

**Zotero → reMarkable**

- Uploads the PDF to a folder on the tablet (default `Zotero`).
- Burns your Zotero annotations into the pages: highlights, underlines, ink, area
  boxes and text boxes, with a small numbered tag next to every annotation that has
  a comment.
- Appends a **"Zotero notes"** page with each comment (numbered to match the tags)
  plus the item's child notes, so you can read them on the tablet.
- When you change annotations or notes in Zotero, the next sync swaps in the new PDF
  while retaining the tablet annotation layers. Changes to the source PDF or an uncertain page map require review.

**reMarkable → Zotero**

| On the tablet                                                                           | In Zotero                                                                                                   |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Text highlight (select text with the highlighter)                                       | `highlight` annotation with the highlighted text, colour mapped to the nearest Zotero colour                |
| Freehand highlighter / shader stroke                                                    | `highlight` annotation covering the stroke                                                                  |
| Pen, pencil, marker, etc. strokes on a PDF page                                         | `ink` annotations, grouped into word/drawing-sized clusters so each can be deleted or recoloured on its own |
| Typed text on a PDF page                                                                | `note` (sticky note) annotation                                                                             |
| Pen strokes in the margin, outside the PDF page, or on the appended "Zotero notes" page | Child **note** with an SVG drawing of the handwriting                                                       |

Imported annotations and notes get the tag `reMarkable import` and author name "reMarkable". This is separate from the `reMarkable` tag used to mark items for sync.

### Editable ink and highlights in the original PDF

Pair the attachment first using **Sync with reMarkable**, then right-click the
attachment and choose **reMarkable → Enable editable annotations in this PDF…**.
The confirmation previews any Zotero-only marks eligible for conversion.
This opt-in mode uses the same original attachment and tablet document.

- Ink and highlights appear as standard editable annotations in the PDF
  and native marks on the tablet. In a PDF editor, save to the same file.
  On the tablet, select the **PDF annotations** layer to erase or move marks
  sent from the PDF.
  The first sync uses a verified copy of the original page layout to adopt
  the pairing. Freehand tablet highlights are represented by PDF highlight
  rectangles. Tablet brush effects are represented as portable ink geometry.
- A verified erasure syncs to the other side. **Restore last erased PDF
  annotation…** recovers the last synced geometry in the original PDF and on
  the tablet. Open **Tools → Review sync conflicts** for changes made on both
  sides or when the plugin cannot verify a page. **Keep both** can retain
  both marks in one PDF.
  For a pending **Unsupported scene deletion** review from an older build,
  choose **Retry** after updating.
  A later sync moves an unchanged legacy Zotero overlay to Trash when the
  sync history accounts for all its strokes.
- A locked file pauses the write. Close the editor and choose **Retry**.
  When an older pairing needs a previous page baseline, **Verify against
  earlier PDF…** reads a saved copy for comparison while keeping the edited
  file at its current path.
  A page-layout review can save the paired tablet PDF for comparison.
  A tablet decoding review can save the affected `.rm` page.
  When a genuine layout conflict can be verified, choose **Use reMarkable
  PDF** to replace the original Zotero file, or **Use Zotero PDF** to replace
  the PDF in the existing tablet document. The review asks for confirmation.
  Zotero shows the recovery folder after the operation. It contains the prior
  Zotero PDF, the tablet source PDF, the tablet page data, and an annotated
  tablet PDF when the tablet marks could be decoded.
  Files with a changed page layout, a digital signature, or unsupported
  page geometry require review. Start with one expendable paper to verify
  your PDF editor and tablet firmware.

### Notes ↔ note pages (two-way)

A child note whose title starts with **`reMarkable Note`** (e.g. `reMarkable Note 1`,
`reMarkable Note 2 – Methods`) is paired with its own blank notebook page at the end of
the document on the tablet:

- The note's body (everything after the title line) is written on the page as
  reMarkable **typed text**, so you can keep editing it on the tablet. Headings and
  bullet lists carry over in both directions; other formatting is kept as plain text.
- Text you type on that page comes back into the Zotero note. Handwriting on the page
  is added to the note as a drawing.
- A notebook page you add on the tablet becomes a new note, `reMarkable Note <n>`.
- When both versions change, open **Tools → Review sync conflicts**. **Keep both** preserves the Zotero note and its attachments and pairs a separate note with the tablet page. **Decide later** keeps the review across restarts.
- Erasing a tablet page keeps its paired Zotero note. Moving or deleting the Zotero note leaves the tablet page in place.

Other child notes are read-only on the tablet: they are listed on the appended
"Zotero notes" page.

### Safety rules

- Sync is opt-in for each writable library. Unchecking a library pauses its pairings and reviews.
- In the default mode, erasing a tablet annotation retains its Zotero import
  and the original PDF file stays intact. A failed import stays pending.
  Re-import refreshes existing records in place.
- Imported annotations are never burned back into the uploaded PDF, so nothing
  appears twice.

## Install

1. Build the XPI from this checkout or use a verified [fork release](https://github.com/onirob/zotero-reMarkable-plugin/releases). Updates go to this fork.
2. In Zotero: **Tools → Plugins → ⚙ → Install Plugin From File…**
3. **Zotero Settings → reMarkable**: click **Get one-time code…**, sign in, copy
   the 8-letter code from <https://my.remarkable.com/device/browser/connect> and
   click **Connect**. Under **Libraries to sync**, select the libraries you want to use.

A reMarkable account needs a paired tablet for the cloud API to work.

## Use

- Right-click items (or PDFs) → **reMarkable → Sync with reMarkable**. This uploads
  them on the first run and syncs both ways afterwards.
- **Tools → Sync with reMarkable** syncs tracked attachments in selected libraries, plus eligible
  items tagged `reMarkable` (the tag can be changed in settings).
- Set **Sync automatically every N minutes** for background sync.
- **reMarkable → Remove from reMarkable** moves the document to the tablet's trash.
  Annotations already imported stay in Zotero.
- **Delete annotations imported from reMarkable** previews unchanged, verified imports before moving them to Zotero Trash.

## How it works

- `src/remarkable/cloud.ts` is a small client for the reMarkable sync protocol
  (schema v4 root index, content-addressed blobs with `rm-filename` and CRC32C
  headers, compare-and-swap root updates with retry on generation conflicts).
- `src/remarkable/rmscene.ts` is a reader for v6 `.rm` files: tagged blocks, the
  CRDT scene tree, Line v1/v2 points, GlyphRange highlights, ARGB colours (Paper
  Pro) and typed text. Unrecognized scene blocks and incomplete pages require review.
- `src/sync/convert.ts` maps tablet coordinates to PDF points:
  `x_pt = cropX + w/2 + x·72/226`, `y_pt = cropTop − y·72/226`.
- `src/sync/pdfExport.ts` burns Zotero annotations into the PDF with `pdf-lib`.
- `src/sync/engine.ts` runs a pull, then a push, per attachment. State lives in
  account-specific files under `<Zotero data dir>/remarkable-sync/`.

The device token is stored in the application’s credential manager. Upgrading verifies the saved credential before clearing the old preference.

## Develop

```bash
npm install
cp .env.example .env   # point it at Zotero and a dev profile
npm start              # Zotero with hot reload
npm run build          # .scaffold/build/*.xpi + type-check
npm run test:unit      # parser / protocol / conversion tests (Node)
npm run lint:fix
```

### Releasing

```bash
npm run release        # pick the version; commits, tags vX.Y.Z and pushes
```

The pushed tag runs `.github/workflows/release.yml`, which tests and builds the
plugin, creates the GitHub release `vX.Y.Z` with `zotero-remarkable-sync.xpi`
attached, and updates `update.json` on the `release` release (the plugin's
`update_url`, used by Zotero for automatic updates). Versions with a `-` suffix
use a separate beta update manifest.

`scripts/pull-preview.mts` downloads a document, runs the import conversion and
writes a PDF with the result drawn on top, which is handy for checking coordinates.

The test fixtures in `test/fixtures` come from the rmscene / zotero-remarkable-sync
projects.

## Limitations

- **One machine.** Sync state lives in the Zotero data directory
  under `remarkable-sync/`. Syncing the same library from two computers
  duplicates documents and annotations.
- **Unofficial protocol.** The reMarkable cloud sync protocol and the `.rm` format are
  reverse-engineered and can break with a firmware or cloud change. The `.rm` text
  writer is only tested against its own reader. A paired tablet and the cloud are
  required; there is no USB or local sync.
- **Zotero annotations go one way.** They are burned into the uploaded PDF and cannot be
  edited on the tablet. Annotations imported from the tablet are never pushed back.
- **Standalone PDFs** (attachments without a parent item) are synced, but margin notes
  and notebook pages on them are skipped, because Zotero only allows child notes
  under a regular item.
- **Note formatting** is limited to headings, bullet lists and plain text. Images and
  other rich formatting in Zotero notes are not shown on the tablet.
- **Coordinates** are mapped at a fixed 226 dpi. Rotated (`/Rotate`), landscape and
  non-Letter/A4 pages are untested.
- **Large PDFs** are rebuilt on Zotero's main thread, so Zotero can freeze for a while
  (the plugin warns for files of 50 MB or more).
- Freehand highlighter strokes become area highlights without text.
- Pages containing unsupported scene blocks require review.
- EPUBs are not supported, only PDFs.
- A missing or trashed tablet document requires review.
- Group libraries are untested.

## Credits

Built with [zotero-plugin-scaffold](https://github.com/zotero-plugin-dev/zotero-plugin-scaffold)
and [zotero-types](https://github.com/windingwind/zotero-types); PDFs are written with
[pdf-lib](https://github.com/Hopding/pdf-lib).
The protocol and format knowledge comes from
[rmapi](https://github.com/ddvk/rmapi), [rmapi-js](https://github.com/erikbrinkman/rmapi-js),
[rmscene](https://github.com/ricklupton/rmscene), [rmc](https://github.com/ricklupton/rmc),
[remarks](https://github.com/lucasrla/remarks),
[zotero-remarkable-sync](https://github.com/bpiwowar/zotero-remarkable-sync) and
[obsidian-remarkable-tagged-sync](https://github.com/thomas-hochbichler/obsidian-remarkable-tagged-sync).

## License

[MIT](LICENSE). Test fixtures from rmscene are MIT-licensed by their author; see
[test/fixtures/README.md](test/fixtures/README.md).
