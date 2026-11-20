/**
 * Pairs Zotero child notes titled "reMarkable Note …" with notebook pages
 * appended to the document on the tablet, and keeps their text in sync
 * both ways (see notes.ts for the conventions).
 */
import { addInsertedPage, pageRefs } from "../remarkable/content";
import {
  isTabletChangedError,
  type ChangedDocument,
  type RemarkableCloud,
} from "../remarkable/cloud";
import { sha256Hex, uuid4 } from "../remarkable/hash";
import {
  isEraser,
  parseRm,
  type RmPage,
  type RmParagraph,
} from "../remarkable/rmscene";
import { writePageText } from "../remarkable/rmwrite";
import {
  forgetReview,
  pageBlocked,
  pageDecision,
  pageReadable,
  pageUnreadable,
  rememberReview,
  refreshMissingReview,
  ReviewNeeded,
  unreadable,
  type SyncReview,
} from "./review";
import { fingerprint, renderSvg } from "./convert";
import { stagedDrawingId } from "./drawingJournal";
import {
  htmlToParagraphs,
  isSyncedNoteTitle,
  applyPairPlan,
  landedPages,
  nextNoteTitle,
  pairState,
  plainText,
  paragraphsToHtml,
  planPair,
  TabletCommits,
} from "./notes";
import type { DocState } from "./state";
import {
  childNotesWithTrashed,
  existsInLibrary,
  localSnapshot,
  writeSyncedNote,
} from "./zotero";

export interface NoteSyncResult {
  notices: string[];
  toTablet: number;
  toZotero: number;
  created: number;
  removed: number;
  /** Set if the tablet copy was changed. */
  changed?: ChangedDocument;
}

/** Bump to make every paired note re-sync once (e.g. after a rules fix). */
const NOTE_SYNC_VERSION = 3;

function paragraphStyles(body: RmParagraph[]) {
  return fingerprint(body.map((p) => p.style || 1));
}

/** Cheap check for Zotero-side changes to notes that take part in sync. */
export function notesFingerprint(att: Zotero.Item, doc: DocState) {
  const mapped = new Set(
    Object.values(doc.notePages ?? {}).map((p) => p.noteKey),
  );
  return fingerprint([
    NOTE_SYNC_VERSION,
    ...childNotesWithTrashed(att)
      // Trashed notes only matter while paired: trashing, restoring or
      // emptying the trash for them must trigger a sync.
      .filter((n) =>
        n.deleted
          ? mapped.has(n.key)
          : mapped.has(n.key) || isSyncedNoteTitle(n.getNoteTitle()),
      )
      .map((n) => [n.key, n.deleted ? "trashed" : n.getNote()]),
  ]);
}

export async function syncNotes(
  cloud: RemarkableCloud,
  att: Zotero.Item,
  doc: DocState,
  authorId: string,
  guard: () => void,
  checkpoint: () => Promise<void>,
  expectedHash?: string,
): Promise<NoteSyncResult> {
  const result: NoteSyncResult = {
    notices: [],
    toTablet: 0,
    toZotero: 0,
    created: 0,
    removed: 0,
  };
  const files = await cloud.getDocumentFiles(doc.rmDocId);
  guard();
  if (!files) throw new Error("Note download incomplete");
  if (expectedHash !== undefined && files.hash !== expectedHash)
    throw new Error("Tablet changed while reading notes. Sync again.");
  const notePages = migrateImportedPageNotes(doc);
  const journal = { doc, guard, checkpoint };
  const pageFiles = files.rm;

  let content = files.content;
  let contentChanged = false;
  const writes = new Map<string, Uint8Array>();
  const validateNotes: (() => void)[] = [];
  let refs: ReturnType<typeof pageRefs>;
  try {
    refs = pageRefs(content);
  } catch (e) {
    unreadable("Page map", String(e));
  }
  const livePages = new Set(refs.map((r) => r.id));
  const inserted = refs.filter((r) => r.pdfIndex === undefined);
  const insertedIds = new Set(inserted.map((ref) => ref.id));
  const parsed = new Map<string, RmPage>();
  const damaged = new Set<string>();
  for (const ref of inserted) {
    const data = files.rm.get(ref.id);
    try {
      if (data) parsed.set(ref.id, parseRm(data));
      pageReadable(doc, ref.id);
    } catch {
      damaged.add(ref.id);
      pageUnreadable(doc, ref.id, "Tablet note page could not be decoded");
    }
  }
  const reservedKey = async (location: string) => {
    doc.pendingKeys ??= {};
    doc.pendingKeys[location] ??= (
      Zotero as any
    ).DataObjectUtilities.generateKey() as string;
    await checkpoint();
    guard();
    return doc.pendingKeys[location];
  };
  // A device-written page to model new pages on (scene info, text geometry).
  const template = inserted.find(
    (r) => parsed.has(r.id) && !pageBlocked(doc, r.id),
  )?.id;

  guard();
  const allNotes = childNotesWithTrashed(att);
  const notes = allNotes.filter((n) => !n.deleted);
  const noteByKey = new Map(allNotes.map((n) => [n.key, n]));
  // Titles of the live notes by key, kept current as notes are trashed,
  // retitled or created below.
  const titleByKey = new Map(notes.map((n) => [n.key, n.getNoteTitle()]));
  const titles = () => [...titleByKey.values()];

  const tabletBody = (page?: RmPage): RmParagraph[] =>
    (page?.rootText?.paragraphs ?? []).filter((p) => p.text.trim());
  const drawingOf = (page?: RmPage) => {
    const lines = (page?.lines ?? []).filter(
      (l) => !isEraser(l.tool) && l.points.length,
    );
    return lines.length ? renderSvg(lines) : undefined;
  };

  // Records only change after the write that makes them true: the base of a
  // pair whose page is rewritten, new pairings for created pages and removed
  // pairings are applied once updateDocument succeeds, so a failure anywhere
  // leaves state matching what both sides really hold (see applyPairPlan).
  const tabletCommits = new TabletCommits();

  // 1. Existing pairs.
  for (const [pageId, rec] of Object.entries(notePages)) {
    guard();
    if (damaged.has(pageId)) continue;
    try {
      const note = noteByKey.get(rec.noteKey);
      // A note dragged to another parent is no longer among this item's
      // notes but still exists: pause the pair rather than delete the page.
      const state = pairState(
        livePages.has(pageId),
        note ? !!note.deleted : undefined,
        !note && existsInLibrary(att.libraryID, rec.noteKey),
      );
      if (state === "pageGone") {
        refreshMissingReview(doc, pageId, pageId);
        if (pageBlocked(doc, pageId)) continue;
        if (!rec.removedOnTablet)
          result.notices.push(pageId + ": Removed on tablet · kept in Zotero");
        rec.removedOnTablet = true;
        continue;
      }
      if (state === "noteGone") {
        refreshMissingReview(doc, pageId, pageId);
        continue;
      }
      // Trashed or reparented note: keep the pair and the page as they are until
      // the note is restored, moved back or erased.
      if (state === "paused" || !note) {
        refreshMissingReview(doc, pageId, pageId);
        continue;
      }
      if (!insertedIds.has(pageId)) {
        pageUnreadable(
          doc,
          pageId,
          "Paired notebook page now points into the PDF",
        );
        continue;
      }
      const page = parsed.get(pageId);
      const tablet = tabletBody(page);
      const parsedNote = htmlToParagraphs(note.getNote());
      let title = parsedNote.title;
      if (!isSyncedNoteTitle(title)) title = nextNoteTitle(titles());
      const zotero = parsedNote.body;
      const tPlain = plainText(tablet);

      const drawing = drawingOf(page);
      const drawingHash = drawing ? fingerprint(drawing.markup) : undefined;
      if (
        !tPlain &&
        !drawing &&
        (rec.base || rec.drawingHash || rec.removedOnTablet)
      ) {
        refreshMissingReview(doc, pageId, pageId);
        if (pageBlocked(doc, pageId)) continue;
        if (!rec.removedOnTablet)
          result.notices.push(pageId + ": Removed on tablet · kept in Zotero");
        rec.removedOnTablet = true;
        continue;
      }
      rec.removedOnTablet = false;

      const html = note.getNote();
      const attachmentKeys = note
        .getAttachments()
        .filter((id) => id !== stagedDrawingId(doc, note));
      const localRevision = fingerprint([html, attachmentKeys]);
      const guardLocal = (newImageId?: number) => {
        guard();
        if (
          note.deleted ||
          note.parentID !== att.parentID ||
          fingerprint([
            note.getNote(),
            note
              .getAttachments()
              .filter(
                (id) => id !== (newImageId ?? stagedDrawingId(doc, note)),
              ),
          ]) !== localRevision
        )
          throw new Error("Zotero note changed during sync");
      };
      let plan = planPair(rec.base, zotero, tablet);
      const localStyles = paragraphStyles(zotero);
      const remoteStyles = paragraphStyles(tablet);
      const localFormatChanged =
        rec.zoteroStyles !== undefined && rec.zoteroStyles !== localStyles;
      const remoteFormatChanged =
        rec.tabletStyles !== undefined && rec.tabletStyles !== remoteStyles;
      if (
        (plan.action === "toZotero" && localFormatChanged) ||
        (plan.action === "toTablet" && remoteFormatChanged) ||
        (localFormatChanged &&
          remoteFormatChanged &&
          localStyles !== remoteStyles)
      ) {
        plan = { action: "conflict", baseAfterTablet: tPlain };
      } else if (plan.action === "none" && localStyles !== remoteStyles) {
        if (remoteFormatChanged) plan.zoteroBody = tablet;
        if (localFormatChanged) plan.tabletBody = zotero;
      }
      // Rewriting can preserve only the structure the note writer can reproduce.
      const rich =
        html !== paragraphsToHtml(parsedNote.title, zotero) ||
        attachmentKeys.length > 0;
      let resolvedReview: SyncReview | undefined;
      if (
        plan.action === "conflict" ||
        ((!!plan.zoteroBody ||
          title !== parsedNote.title ||
          drawingHash !== rec.drawingHash) &&
          (!rec.owned || rich))
      ) {
        const bytes = files.rm.get(pageId);
        const review: SyncReview = {
          pageId,
          location: pageId,
          reason: rich
            ? "Updating this note could discard formatting or attachments"
            : "The paired note has edits requiring review",
          zotero: html,
          tablet: tPlain + (drawing ? "\n[Handwriting]" : ""),
          localKey: note.key,
          localHash: localSnapshot(att, note.key, doc),
          revision: JSON.stringify([
            bytes ? await sha256Hex(bytes) : null,
            "inserted",
            localRevision,
          ]),
          choices:
            rec.owned && !rich
              ? ["Keep both", "Use tablet version", "Use Zotero version"]
              : ["Keep both", "Use Zotero version"],
        };
        const choice = pageDecision(
          doc,
          review,
          [files.hash, pageId, localRevision].join("/"),
        );
        if (!choice) continue;
        if ((await cloud.findDocument(doc.rmDocId))?.hash !== files.hash) {
          pageUnreadable(
            doc,
            pageId,
            "Tablet changed since review. Retry to compare the current versions.",
          );
          continue;
        }
        guardLocal();
        if (choice === "Keep both") {
          const copyKey = await reservedKey("copy/" + pageId);
          guardLocal();
          await writeSyncedNote(
            att,
            copyKey,
            nextNoteTitle(titles()),
            tablet,
            drawing,
            {
              ...journal,
              rewriteBody: true,
              checkVersion: guardLocal,
              target: {
                kind: "page",
                id: pageId,
                retain: rec.noteKey,
                record: {
                  noteKey: copyKey,
                  owned: true,
                  base: tPlain,
                  tabletStyles: remoteStyles,
                  zoteroStyles: remoteStyles,
                  drawingHash,
                },
              },
            },
          );
          continue;
        }
        if (choice === "Use Zotero version") {
          writes.set(pageId, pageText(files.rm.get(pageId), zotero));
          validateNotes.push(() => guardLocal());
          tabletCommits.defer(() => {
            rec.base = plainText(zotero);
            rec.tabletStyles = localStyles;
            rec.zoteroStyles = localStyles;
            rec.drawingHash = drawingHash;
            forgetReview(doc, review);
          });
          result.toTablet++;
          continue;
        }
        resolvedReview = review;
        plan = {
          action: "toZotero",
          zoteroBody: tablet,
          baseAfterZotero: tPlain,
          baseAfterTablet: tPlain,
        };
      }
      if (!resolvedReview) {
        refreshMissingReview(doc, pageId, pageId);
        if (pageBlocked(doc, pageId)) continue;
      }
      if (plan.zoteroBody) result.toZotero++;
      // Regenerate the body only when its text must change (or the title was
      // fixed); a drawing-only change swaps just the plugin's image.
      const rewriteBody = !!plan.zoteroBody || title !== parsedNote.title;
      const needsWrite = rewriteBody || drawingHash !== rec.drawingHash;
      await applyPairPlan(
        rec,
        plan,
        needsWrite
          ? async () => {
              const written = await writeSyncedNote(
                att,
                rec.noteKey,
                title,
                plan.zoteroBody ?? zotero,
                drawing,
                {
                  ...journal,
                  rewriteBody,
                  checkVersion: guardLocal,
                  previous: rec.drawingKey,
                  target: {
                    kind: "page",
                    id: pageId,
                    record: {
                      ...rec,
                      drawingHash,
                      base: plan.baseAfterZotero ?? rec.base,
                      tabletStyles: remoteStyles,
                      zoteroStyles: paragraphStyles(plan.zoteroBody ?? zotero),
                    },
                  },
                },
              );
              titleByKey.set(rec.noteKey, title);
              rec.drawingHash = drawingHash;
              rec.drawingKey = written.drawingKey;
            }
          : undefined,
        tabletCommits,
      );
      if (resolvedReview) forgetReview(doc, resolvedReview);
      rec.zoteroStyles = paragraphStyles(htmlToParagraphs(note.getNote()).body);
      if (plan.tabletBody) {
        writes.set(pageId, pageText(files.rm.get(pageId), plan.tabletBody));
        result.toTablet++;
        const planned = localSnapshot(att, note.key);
        validateNotes.push(() => {
          if (!planned || localSnapshot(att, note.key) !== planned)
            throw new Error("Zotero note changed before tablet save");
        });
        const styles = paragraphStyles(plan.tabletBody);
        tabletCommits.defer(() => {
          rec.tabletStyles = styles;
        });
      } else rec.tabletStyles = remoteStyles;
    } catch (error) {
      if (!(error instanceof ReviewNeeded)) throw error;
      rememberReview(doc, error.review);
    }
  }

  // 2. Pages added on the tablet -> new notes.
  const pagedNotes = new Set([
    ...Object.values(notePages).map((r) => r.noteKey),
    ...(doc.retainedNotes ?? []),
    ...Object.values(doc.pendingKeys ?? {}),
  ]);
  for (const ref of inserted) {
    guard();
    if (notePages[ref.id] || damaged.has(ref.id) || pageBlocked(doc, ref.id))
      continue;
    const pending = Object.entries(doc.pendingPages ?? {}).find(
      ([, intent]) => intent.id === ref.id,
    );
    if (pending) {
      const [key, intent] = pending;
      notePages[ref.id] = { noteKey: key, base: intent.base };
      doc.pullIncomplete = true;
      pagedNotes.add(key);
      delete doc.pendingPages![key];
      await checkpoint();
      continue;
    }
    const page = parsed.get(ref.id);
    const body = tabletBody(page);
    const drawing = drawingOf(page);
    if (!body.length && !drawing) continue; // still blank
    const title = nextNoteTitle(titles());
    const key = await reservedKey("page/" + ref.id);
    try {
      await writeSyncedNote(att, key, title, body, drawing, {
        ...journal,
        rewriteBody: true,
        target: {
          kind: "page",
          id: ref.id,
          record: {
            noteKey: key,
            owned: true,
            tabletStyles: paragraphStyles(body),
            zoteroStyles: paragraphStyles(body),
            base: plainText(body),
            drawingHash: drawing ? fingerprint(drawing.markup) : undefined,
          },
        },
      });
    } catch (error) {
      if (!(error instanceof ReviewNeeded)) throw error;
      rememberReview(doc, error.review);
      continue;
    }
    pagedNotes.add(key);
    titleByKey.set(key, title);
    result.created++;
  }

  // 3. "reMarkable Note …" notes made in Zotero -> new pages.
  const addedPageIds: string[] = [];
  for (const note of notes) {
    if (pagedNotes.has(note.key) || !isSyncedNoteTitle(note.getNoteTitle()))
      continue;
    const source = note.getNote();
    const { body } = htmlToParagraphs(source);
    validateNotes.push(() => {
      if (
        note.deleted ||
        note.parentID !== att.parentID ||
        note.getNote() !== source
      )
        throw new Error("Zotero note changed before tablet save");
    });
    guard();
    doc.pendingPages ??= {};
    const pageId = doc.pendingPages[note.key]?.id ?? uuid4();
    doc.pendingPages[note.key] = { id: pageId, base: plainText(body) };
    await checkpoint();
    content = addInsertedPage(content, pageId, authorId);
    contentChanged = true;
    writes.set(pageId, pageText(undefined, body));
    addedPageIds.push(pageId);
    // Paired only once the page exists on the tablet.
    tabletCommits.defer(() => {
      notePages[pageId] = {
        noteKey: note.key,
        base: plainText(body),
        tabletStyles: paragraphStyles(body),
        zoteroStyles: paragraphStyles(body),
      };
      delete doc.pendingPages![note.key];
    });
    result.created++;
  }

  if (writes.size || contentChanged) {
    try {
      guard();
      result.changed = await cloud.updateDocument(
        doc.rmDocId,
        {
          pages: writes,
          content: contentChanged ? content : undefined,
        },
        {
          expectedHash: files.hash,
          beforeCommit: () => {
            guard();
            for (const validate of validateNotes) validate();
          },
        },
      );
    } catch (e) {
      // The root PUT is never retried: the server may have applied it with
      // only the response lost. Record the pairings if the new pages exist,
      // or the next sync would import them again and create more pages.
      if (addedPageIds.length && !isTabletChangedError(e)) {
        const live = await cloud.getPageIds(doc.rmDocId).catch(() => undefined);
        if (landedPages(addedPageIds, live).length === addedPageIds.length)
          tabletCommits.commit();
      }
      throw e;
    }
  }
  tabletCommits.commit();
  return result;

  function pageText(existing: Uint8Array | undefined, body: RmParagraph[]) {
    return writePageText(existing, body, {
      authorUuid: authorId,
      template: template ? pageFiles.get(template) : undefined,
    });
  }
}

/**
 * Before two-way note sync, tablet notebook pages were imported one-way as
 * notes keyed `<pageId>/page`. Adopt those notes as synced pairs.
 */
export function migrateImportedPageNotes(doc: DocState) {
  doc.notePages ??= {};
  const notePages = doc.notePages;
  for (const [rmKey, rec] of Object.entries(doc.imported)) {
    const m = /^([^/]+)\/page$/.exec(rmKey);
    if (!m || rec.kind !== "note") continue;
    notePages[m[1]] ??= {
      noteKey: rec.zoteroKey,
      owned: true,
      migrated: true,
      drawingKey: rec.drawingKey,
    };
    delete doc.imported[rmKey];
  }
  return notePages;
}
