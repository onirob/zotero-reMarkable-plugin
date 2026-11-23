/**
 * Sync orchestration. A sync of one attachment is:
 *   1. pull: if the tablet copy changed, turn its annotations into Zotero
 *      annotations / notes (only objects this plugin created are ever
 *      updated or deleted);
 *   2. push: if the Zotero annotations or notes changed since the last
 *      upload, rebuild the PDF and replace it on the tablet, keeping the
 *      tablet's own annotations in place;
 *   3. notes: two-way sync of "reMarkable Note …" notes with their pages.
 */
import {
  type RemarkableCloud,
  RemarkableError,
  type IndexEntry,
} from "../remarkable/cloud";
import { pageRefs } from "../remarkable/content";
import {
  decisionFor,
  forgetReview,
  pageBlocked,
  pageDecision,
  pageReadable,
  pageUnreadable,
  rememberReview,
  refreshMissingReview,
  reviewEntries,
  reviewId,
  ReviewNeeded,
  tabletReviewFileType,
  unreadable,
  type ReviewChoice,
  type SyncReview,
} from "./review";
import { sha256Hex, uuid4 } from "../remarkable/hash";
import { parseRm } from "../remarkable/rmscene";
import {
  CONVERTER_VERSION,
  type PageIndex,
  buildPageIndex,
  convertPages,
  fingerprint,
  respaceWith,
  splitPageTexts,
} from "./convert";
import { resolveFolderId } from "./folderCache";
import { LARGE_PDF_BYTES, largePdfWarning } from "./largePdf";
import { Mutex } from "./mutex";
import { titleToPush } from "./titlePush";
import {
  migrateImportedPageNotes,
  notesFingerprint,
  syncNotes,
} from "./noteSync";
import {
  noteSnapshot,
  stagedDrawingId,
  unchangedManagedDrawing,
  recoverDrawings,
} from "./drawingJournal";
import { syncEditable, type EditableSnapshot } from "./editableSync";
import { EDITABLE_PDF_LIMIT, pdfWithoutSyncedMarks } from "./embeddedPdf";
import {
  samePaths,
  roundMark,
  validEditableMark,
  type EditableMark,
} from "./editableMarks";
import { buildDetachedList } from "./detached";
import {
  canSaveCandidate,
  type CandidateFailure,
  formatCandidateFailures,
  invalidatedRecord,
  isRecordCurrent,
  keysToErase,
  needsPull,
  newUploadedDoc,
  nextRmDocHash,
  readPages,
} from "./pullPlan";
import type { SyncStateStore, DocState } from "./state";
import {
  localSnapshot,
  describeImport,
  trashByKey,
  existsByKey,
  knownPageLabels,
  remarkableTitle,
  saveAnnotation,
  saveNote,
  zoteroAnnotations,
  zoteroNotes,
} from "./zotero";

export interface SyncSettings {
  folder: string;
  appendNotesPages: boolean;
  importHandwriting: boolean;
}

export interface SyncReport {
  uploaded: number;
  updated: number;
  imported: number;
  removed: number;
  /** Notes pushed to / pulled from / created as tablet note pages. */
  notes: number;
  errors: string[];
  notices: string[];
}

export type Progress = (text: string, fraction?: number) => void;

export class SyncEngine {
  constructor(
    private cloud: RemarkableCloud,
    private state: SyncStateStore,
    private settings: () => SyncSettings,
    /** Stable uuid of this installation (CRDT author on the tablet). */
    private authorId: string,
    /**
     * Serialises sync, remove and removeImported (one at a time). Share one
     * instance between engines that use the same state store, so replacing
     * the engine (connect/disconnect) cannot overlap a running operation.
     */
    private lock: Mutex = new Mutex(),
    private eligible: (id: number) => boolean = () => false,
  ) {}

  private guard(id: number) {
    if (!this.eligible(id)) throw new Error("Library is paused");
  }

  async resolve(
    att: Zotero.Item,
    id: string,
    revision: string,
    choice: ReviewChoice,
    earlierPdfPath?: string,
  ) {
    return this.lock.run(async () => {
      this.guard(att.libraryID);
      await this.state.load();
      this.guard(att.libraryID);
      const doc = this.state.get(att.libraryID, att.key);
      const review = doc?.reviews?.[id];
      if (
        !review ||
        review.revision !== revision ||
        !review.choices.includes(choice) ||
        (earlierPdfPath !== undefined &&
          (!review.verifyEarlierPdf || choice !== "Retry"))
      )
        throw new Error("Review changed. Open it again.");
      review.decision = choice;
      await this.state.save();
      try {
        return await this.doSync([att], () => {}, earlierPdfPath);
      } finally {
        this.cloud.checkScope = undefined;
        this.cloud.clearPageCache();
      }
    });
  }

  async saveTabletReviewFile(
    att: Zotero.Item,
    id: string,
    revision: string,
    destination: string,
  ) {
    return this.lock.run(async () => {
      const guard = () => this.guard(att.libraryID);
      guard();
      await this.state.load();
      guard();
      const doc = this.state.get(att.libraryID, att.key);
      const review = doc?.reviews?.[id];
      const type = review && tabletReviewFileType(review);
      if (!doc?.editable || !review || review.revision !== revision || !type)
        throw new Error("Review changed. Open it again.");
      if (!destination.toLowerCase().endsWith(`.${type}`))
        throw new Error(
          `Choose a new .${type} filename for the comparison copy.`,
        );
      this.cloud.checkScope = guard;
      try {
        const entry = await this.cloud.findDocument(doc.rmDocId);
        const metadata = entry && (await this.cloud.readMetadata(entry));
        if (
          !entry ||
          !metadata ||
          metadata.deleted ||
          metadata.parent === "trash"
        )
          throw new Error("The paired tablet document is unavailable.");
        guard();
        const name =
          type === "pdf"
            ? `${doc.rmDocId}.pdf`
            : `${doc.rmDocId}/${review.pageId}.rm`;
        const file = (await this.cloud.getDocEntries(entry)).find(
          (file) => file.id === name,
        );
        if (!file || (type === "pdf" && file.hash !== doc.tabletPdfHash))
          throw new Error(
            "The tablet file could not be matched to the saved pairing.",
          );
        guard();
        const bytes = await this.cloud.getBlob(
          file.hash,
          name,
          type === "pdf" ? EDITABLE_PDF_LIMIT : undefined,
        );
        guard();
        await IOUtils.write(destination, bytes, {
          mode: "create",
          flush: true,
        });
      } finally {
        this.cloud.checkScope = undefined;
      }
    });
  }

  async editableMode(att: Zotero.Item, restore = false) {
    await this.lock.run(async () => {
      this.guard(att.libraryID);
      await this.state.load();
      const doc = this.state.get(att.libraryID, att.key);
      if (!doc)
        throw new Error(
          "Sync the attachment with reMarkable once to establish its pairing",
        );
      if (restore) {
        if (!doc.editable)
          throw new Error("Enable editable PDF annotation sync first");
        if (doc.editable.pending || doc.editable.restore)
          throw new Error(
            "Finish the pending PDF sync before restoring another mark",
          );
        const mark = doc.editable.erased.at(-1);
        if (!mark) throw new Error("This PDF has no erased marks to restore");
        doc.editable.restore = mark;
      } else {
        if (doc.editable) return;
        if (reviewEntries(doc).length || doc.pullIncomplete)
          throw new Error(
            "Resolve the existing sync reviews before enabling editable PDF annotation sync",
          );
        doc.editable = { links: [], erased: [] };
      }
      this.guard(att.libraryID);
      await this.state.save();
    });
  }

  editablePreview(att: Zotero.Item) {
    this.guard(att.libraryID);
    const doc = this.state.get(att.libraryID, att.key);
    return doc ? this.editableSeed(att, doc) : [];
  }

  get busy() {
    return this.lock.locked;
  }

  /** Runs one sync at a time; overlapping calls wait for the current one. */
  sync(
    attachments: Zotero.Item[],
    progress: Progress = () => {},
  ): Promise<SyncReport> {
    return this.lock.run(async () => {
      try {
        return await this.doSync(attachments, progress);
      } finally {
        // Page blobs only help within one sync; don't keep them resident.
        this.cloud.checkScope = undefined;
        this.cloud.clearPageCache();
      }
    });
  }

  /** Attachments that are tracked in the sync state. */
  async trackedAttachments(): Promise<Zotero.Item[]> {
    await this.state.load();
    const out: Zotero.Item[] = [];
    for (const doc of [
      ...this.state.all(),
      ...this.state.pendingAttachments(),
    ]) {
      if (!this.eligible(doc.libraryID)) continue;
      const item = Zotero.Items.getByLibraryAndKey(
        doc.libraryID,
        doc.attachmentKey,
      );
      if (item && !item.deleted) out.push(item as Zotero.Item);
    }
    return out;
  }

  private async doSync(
    attachments: Zotero.Item[],
    progress: Progress,
    earlierPdfPath?: string,
  ) {
    await this.state.load();
    const report: SyncReport = {
      uploaded: 0,
      updated: 0,
      imported: 0,
      removed: 0,
      notes: 0,
      errors: [],
      notices: [],
    };
    attachments = attachments.filter((att) => this.eligible(att.libraryID));
    this.cloud.checkScope = () => {
      if (!attachments.some((att) => this.eligible(att.libraryID)))
        throw new Error("Libraries paused");
    };
    if (!attachments.length) return report;
    for (const att of attachments) {
      if (!this.state.get(att.libraryID, att.key))
        this.state.queue(att.libraryID, att.key);
    }
    await this.state.save();
    this.cloud.checkScope();
    progress("Reading reMarkable library…", 0);
    const root = await this.cloud.getRoot();
    const rootEntries = new Map(
      (await this.cloud.getRootEntries(root)).map((e) => [e.id, e] as const),
    );
    let folderId: string | undefined;
    for (const [i, att] of attachments.entries()) {
      if (!this.eligible(att.libraryID)) continue;
      const guard = () => this.guard(att.libraryID);
      this.cloud.checkScope = guard;
      const label = remarkableTitle(att);
      progress(label, i / attachments.length);
      try {
        let doc = this.state.get(att.libraryID, att.key);
        let entry = doc ? rootEntries.get(doc.rmDocId) : undefined;
        const documentReview = doc?.reviews?.document;
        if (documentReview && !documentReview.decision) {
          const review = documentReview;
          if (
            (review.tabletHash && entry?.hash !== review.tabletHash) ||
            (review.localKey &&
              localSnapshot(att, review.localKey) !== review.localHash)
          )
            unreadable(
              review.location,
              "A version changed since review. Retry to read both versions again.",
            );
          report.errors.push(`${label}: Review needed · ${review.reason}`);
          continue;
        }
        const path = await att.getFilePathAsync();
        guard();
        if (!path) throw new Error("PDF file is missing");
        let pdf = new Uint8Array(await IOUtils.read(path));
        let sourceHash = await sha256Hex(pdf);
        guard();
        const reviewed = documentReview;
        if (
          reviewed?.decision &&
          reviewed.decision !== "Retry" &&
          ((reviewed.tabletHash && reviewed.tabletHash !== entry?.hash) ||
            (reviewed.localKey &&
              reviewed.localHash !== localSnapshot(att, reviewed.localKey)))
        ) {
          unreadable(
            reviewed.location,
            "A version changed since review. Retry to read both versions again.",
          );
        }
        if (doc?.editable) {
          if (!entry)
            unreadable("Editable PDF", "The paired tablet document is missing");
          const metadata = await this.cloud.readMetadata(entry);
          guard();
          if (!metadata || metadata.deleted || metadata.parent === "trash")
            unreadable(
              "Editable PDF",
              "The paired tablet document is unavailable or in Trash",
            );
          const paired = doc;
          const context = {
            att,
            doc: paired,
            store: this.state,
            cloud: this.cloud,
            authorUuid: this.authorId,
            guard,
            earlierPdfPath,
            seed: () => this.editableSeed(att, paired),
            cleanTabletPdf: (files: EditableSnapshot) =>
              this.adoptTabletPdf(att, paired, pdf, files),
            wholeUploadFingerprint: (base: string) =>
              this.uploadFingerprint(att, paired, {}, base),
          };
          const first = !doc.editable.base;
          let result = await syncEditable(
            context,
            { path, bytes: pdf, hash: sourceHash },
            entry,
          );
          if (result.resumed && result.retry) {
            pdf = new Uint8Array(await IOUtils.read(path));
            sourceHash = await sha256Hex(pdf);
            result = await syncEditable(context, {
              path,
              bytes: pdf,
              hash: sourceHash,
            });
          }
          if (result.changed) report.updated++;
          if (!doc.editable.base) {
            for (const [, review] of reviewEntries(doc))
              report.errors.push(
                `${label}: ${new ReviewNeeded(review).message}`,
              );
            continue;
          }
          guard();
          pdf = new Uint8Array(await IOUtils.read(path));
          sourceHash = await sha256Hex(pdf);
          if (sourceHash !== doc.sourcePdfHash)
            unreadable(
              "Editable PDF",
              "The PDF changed after its pages were verified. Retry to compare the latest version.",
            );
          if (first) {
            doc.uploadedFingerprint = this.uploadFingerprint(
              att,
              doc,
              await IOUtils.stat(path),
            );
            await this.state.save();
          }
          if (result.changed || result.resumed) {
            entry = await this.cloud.findDocument(doc.rmDocId);
            if (!entry)
              unreadable(
                "Editable PDF",
                "The paired tablet document disappeared",
              );
          }
          report.removed += await this.refreshEditablePreview(
            att,
            doc,
            path,
            result.changed || first || !!doc.editable.refreshAnnotations,
          );
          if ("recovery" in result && result.recovery) {
            report.notices.push(
              `PDF replacement recovery folder\n${result.recovery}`,
            );
            continue;
          }
        }
        let replacePair = false;
        if (
          doc &&
          !doc.editable &&
          entry &&
          (doc.sourcePdfHash !== sourceHash ||
            (documentReview?.location === "PDF" &&
              documentReview.decision === "Keep both"))
        ) {
          const choice = decisionFor(documentReview, {
            location: "PDF",
            reason:
              "The source PDF changed or its prior page order is unknown. Keep both to pair a new copy and retain the annotated tablet document.",
            tablet: "Previously paired annotated document",
            zotero: "Current source PDF",
            tabletHash: entry.hash,
            revision: entry.hash + "/" + sourceHash,
            choices: ["Keep both"],
          });
          if (choice === "Keep both") {
            if (
              (await this.cloud.findDocument(doc.rmDocId))?.hash !== entry.hash
            )
              unreadable("PDF", "Tablet document changed since review");
            guard();
            replacePair = true;
          }
        }
        if (doc && !entry && doc.uploadedFingerprint)
          unreadable(
            "Document",
            "Previously paired tablet document is missing",
          );
        if (doc && !entry) {
          // An upload recorded in push() whose
          // commit never happened: forget it; it is re-uploaded below. The
          // imported objects stay in Zotero: forget() moves their keys into
          // the persistent registry right here, so they stay out of the
          // re-uploaded PDF even if push() fails before recording the new
          // document, and push() reads them back from the registry.
          this.state.forget(att.libraryID, att.key);
          this.state.queue(att.libraryID, att.key);
          doc = undefined;
        }
        // Must run before pull(), which would otherwise erase notes that
        // older versions imported one-way from notebook pages.
        if (doc && att.parentID) migrateImportedPageNotes(doc);
        if (doc && entry && !replacePair) {
          await recoverDrawings(att, {
            doc,
            guard,
            checkpoint: () => this.state.save(),
          });
        }
        const tabletChanged =
          !replacePair &&
          !!doc &&
          !!entry &&
          (reviewEntries(doc).length > 0 ||
            needsPull(doc, entry.hash, CONVERTER_VERSION));
        if (doc && entry && tabletChanged) {
          await this.pull(att, doc, entry, report);
        }
        if (
          doc?.reviews &&
          (replacePair || documentReview?.decision === "Retry")
        )
          delete doc.reviews.document;
        const existing = doc && !replacePair;
        if (existing && doc && att.parentID)
          await this.syncDocumentNotes(
            att,
            doc,
            tabletChanged,
            report,
            entry?.hash,
          );
        guard();
        const pending = doc ? reviewEntries(doc) : [];
        if (pending.length && !replacePair) {
          for (const [, review] of pending)
            report.errors.push(`${label}: ${new ReviewNeeded(review).message}`);
        }
        if (!replacePair && (pending.length || doc?.pullIncomplete)) continue;
        folderId ??= await resolveFolderId(
          this.state,
          this.settings().folder,
          rootEntries,
          (name) => this.cloud.ensureFolder(name),
          (id) => {
            const entry = rootEntries.get(id);
            return entry
              ? this.cloud.readMetadata(entry)
              : Promise.resolve(undefined);
          },
        );
        await this.push(
          att,
          doc,
          folderId,
          report,
          progress,
          i / attachments.length,
          pdf,
          sourceHash,
          replacePair,
        );
        doc = this.state.get(att.libraryID, att.key);
        guard();
        if (!existing && doc && att.parentID)
          await this.syncDocumentNotes(att, doc, true, report);
        if (doc && !reviewEntries(doc).length) doc.lastError = undefined;
      } catch (e) {
        const err = e as Error;
        Zotero.logError(err);
        Zotero.debug(
          `[reMarkable] sync failed for ${label}: ${err}\n${err?.stack}`,
        );
        report.errors.push(
          `${e instanceof ReviewNeeded ? "Review needed" : "Sync incomplete"} · ${label}: ${err?.message ?? String(e)}`,
        );
        const failed = this.state.get(att.libraryID, att.key);
        if (failed) {
          if (e instanceof ReviewNeeded) rememberReview(failed, e.review);
          failed.pullIncomplete = true;
          failed.lastError = `${new Date().toISOString()} ${err?.message ?? e}\n${err?.stack ?? ""}`;
          this.state.set(failed);
        }
        if (e instanceof RemarkableError && e.status === 401) break;
      } finally {
        await this.state.save();
        // Page blobs only help within one attachment; release them now.
        this.cloud.clearPageCache();
      }
    }
    progress("Done", 1);
    return report;
  }

  private async syncDocumentNotes(
    att: Zotero.Item,
    doc: DocState,
    tabletChanged: boolean,
    report: SyncReport,
    expectedHash?: string,
  ) {
    this.guard(att.libraryID);
    if (
      !reviewEntries(doc).length &&
      !tabletChanged &&
      notesFingerprint(att, doc) === doc.notesFingerprint
    )
      return;
    const result = await syncNotes(
      this.cloud,
      att,
      doc,
      this.authorId,
      () => this.guard(att.libraryID),
      () => this.state.save(),
      expectedHash,
    );
    report.notices.push(...result.notices);
    report.notes +=
      result.toTablet + result.toZotero + result.created + result.removed;
    if (result.changed)
      doc.rmDocHash = nextRmDocHash(doc.rmDocHash, result.changed);
    this.guard(att.libraryID);
    doc.notesFingerprint = notesFingerprint(att, doc);
    this.state.set(doc);
    await this.state.save();
  }

  private otherAnnotations(att: Zotero.Item, doc?: DocState) {
    const detached = this.state.getDetached(att.libraryID, att.key);
    const marks = zoteroAnnotations(att, doc, detached);
    return doc?.editable
      ? marks.filter((mark) => mark.type !== "ink" && mark.type !== "highlight")
      : marks;
  }

  private uploadFingerprint(
    att: Zotero.Item,
    doc: DocState | undefined,
    stat: { size?: number; lastModified?: number },
    replacementBase?: string,
  ) {
    const detached = this.state.getDetached(att.libraryID, att.key);
    return fingerprint({
      annotations: this.otherAnnotations(att, doc),
      notes: this.settings().appendNotesPages
        ? zoteroNotes(att, doc, detached)
        : [],
      ...(replacementBase || doc?.editable?.base
        ? {
            base:
              replacementBase ??
              doc?.editable?.uploadBase ??
              doc?.editable?.base,
          }
        : { size: stat.size, mtime: stat.lastModified }),
      appendNotesPages: this.settings().appendNotesPages,
    });
  }

  private editableSeed(att: Zotero.Item, doc: DocState) {
    if (doc.editable?.base) return [];
    const external = new Set(
      att
        .getAnnotations()
        .filter((mark) => mark.annotationIsExternal)
        .map((mark) => mark.key),
    );
    return zoteroAnnotations(
      att,
      doc,
      this.state.getDetached(att.libraryID, att.key),
    )
      .filter((mark) => !external.has(mark.key))
      .flatMap((mark) => {
        const embedded = editableFromZotero(
          mark.type,
          mark.color,
          mark.position,
        );
        return embedded ? [embedded] : [];
      });
  }

  private async adoptTabletPdf(
    att: Zotero.Item,
    doc: DocState,
    pdf: Uint8Array,
    files: EditableSnapshot,
  ) {
    this.guard(att.libraryID);
    const { buildRemarkablePdf } = await import("./pdfExport");
    const clean = await pdfWithoutSyncedMarks(pdf);
    const settings = this.settings();
    const notes = settings.appendNotesPages
      ? zoteroNotes(att, doc, this.state.getDetached(att.libraryID, att.key))
      : [];
    const built = await buildRemarkablePdf(
      clean,
      this.otherAnnotations(att, doc),
      notes,
      {
        appendNotesPages: settings.appendNotesPages,
        title: remarkableTitle(att),
      },
    );
    if (built.appendedPageCount === doc.appendedPageCount) return built.bytes;
    // Keep the pairing's original page IDs and any previously appended note
    // pages. The first conversion only changes the portable marks.
    const { PDFDocument } = await import("pdf-lib");
    const merged = await PDFDocument.load(built.bytes, {
      updateMetadata: false,
    });
    while (merged.getPageCount() > doc.originalPageCount)
      merged.removePage(merged.getPageCount() - 1);
    if (doc.appendedPageCount) {
      const previous = files.files.find(
        (file) => file.id === doc.rmDocId + ".pdf",
      );
      if (!previous)
        throw new Error("The tablet's notes pages could not be verified");
      const original = await PDFDocument.load(
        await this.cloud.getBlob(previous.hash, previous.id, 128 * 1024 * 1024),
      );
      if (
        original.getPageCount() !==
        doc.originalPageCount + doc.appendedPageCount
      )
        throw new Error("The tablet notes page count changed");
      const appended = await merged.copyPages(
        original,
        Array.from(
          { length: doc.appendedPageCount },
          (_, i) => i + doc.originalPageCount,
        ),
      );
      for (const page of appended) merged.addPage(page);
    }
    return merged.save({ useObjectStreams: false });
  }

  private async refreshEditablePreview(
    att: Zotero.Item,
    doc: DocState,
    path: string,
    refresh: boolean,
  ) {
    this.guard(att.libraryID);
    const edit = doc.editable!;
    if (!refresh && !edit.erased.length) return 0;
    const worker = Zotero.PDFWorker;
    let refreshed = false;
    if (refresh && typeof worker?.import === "function") {
      try {
        await worker.import(att.id, undefined, false, true);
        refreshed = true;
      } catch (error) {
        Zotero.logError(error as Error);
      }
    }
    this.guard(att.libraryID);
    const external = att
      .getAnnotations()
      .filter((item) => item.annotationIsExternal && !item.deleted);
    const externalMarks = external.flatMap((item) => {
      try {
        const mark = editableFromZotero(
          item.annotationType,
          item.annotationColor,
          JSON.parse(item.annotationPosition),
        );
        return mark ? [mark] : [];
      } catch {
        return [];
      }
    });
    const displayed = edit.links
      .map((link) => link.pdf)
      .filter((mark) => embeddedCoverage(mark, externalMarks));
    const proof = [...displayed, ...edit.erased];
    const reviewedPages = new Set(
      reviewEntries(doc).map(([, review]) => review.pageId),
    );
    const eligible: DocState["imported"][string][] = [];
    for (const [id, record] of Object.entries(doc.imported)) {
      if (
        record.kind !== "annotation" ||
        record.removedOnTablet ||
        !record.localHash ||
        localSnapshot(att, record.zoteroKey) !== record.localHash
      )
        continue;
      const [pageId, kind] = id.split("/");
      const page = edit.pageIds?.indexOf(pageId) ?? -1;
      if (page < 0 || !["i", "g", "h"].includes(kind)) continue;
      const item = Zotero.Items.getByLibraryAndKey(
        att.libraryID,
        record.zoteroKey,
      );
      if (!item || !item.isAnnotation() || item.annotationIsExternal) continue;
      let mark: EditableMark | undefined;
      try {
        mark = editableFromZotero(
          item.annotationType,
          item.annotationColor,
          JSON.parse(item.annotationPosition),
        );
      } catch {
        continue;
      }
      // Every stroke must still be embedded and displayed, or recoverable
      // from a committed erasure of this pairing. Never retire a partial match.
      const verified = reviewedPages.has(pageId) ? edit.erased : proof;
      if (!mark || mark.page !== page || !embeddedCoverage(mark, verified))
        continue;
      eligible.push(record);
    }
    if (eligible.length) {
      this.guard(att.libraryID);
      if (
        (await att.getFilePathAsync()) !== path ||
        (await sha256Hex(
          new Uint8Array(
            await IOUtils.read(path, { maxBytes: EDITABLE_PDF_LIMIT + 1 }),
          ),
        )) !== doc.sourcePdfHash
      )
        unreadable(
          "Editable PDF",
          "The PDF changed before the Zotero preview could be updated.",
        );
    }
    let retired = 0;
    for (const record of eligible) {
      this.guard(att.libraryID);
      if (localSnapshot(att, record.zoteroKey) === record.localHash) {
        await trashByKey(att.libraryID, record.zoteroKey);
        retired++;
      }
    }
    if (refreshed && displayed.length === edit.links.length)
      edit.refreshAnnotations = undefined;
    return retired;
  }

  private async push(
    att: Zotero.Item,
    doc: DocState | undefined,
    folderId: string,
    report: SyncReport,
    progress: Progress,
    fraction: number,
    pdf: Uint8Array,
    sourceHash: string,
    replacePair: boolean,
  ) {
    const path = await att.getFilePathAsync();
    if (!path) throw new Error("PDF file is missing");
    this.guard(att.libraryID);
    const detached = this.state.getDetached(att.libraryID, att.key);
    const annotations = this.otherAnnotations(att, doc);
    const notes = this.settings().appendNotesPages
      ? zoteroNotes(att, doc, detached)
      : [];
    const stat = await IOUtils.stat(path);
    const print = this.uploadFingerprint(att, doc, stat);
    const title = remarkableTitle(att);
    if (doc && !replacePair && doc.uploadedFingerprint === print) {
      // Nothing to rebuild, but a renamed item must still reach the tablet.
      // Without a recorded title (synced before it was tracked) only record
      // it; the tablet name is not overwritten.
      const rename = titleToPush(doc.pushedTitle, title);
      if (rename !== undefined) {
        const renamed = await this.cloud.renameDocument(doc.rmDocId, rename);
        doc.rmDocHash = nextRmDocHash(doc.rmDocHash, renamed);
      }
      if (doc.pushedTitle !== title) {
        doc.pushedTitle = title;
        this.state.set(doc);
      }
      return;
    }

    if (stat.size !== undefined && stat.size >= LARGE_PDF_BYTES) {
      const warning = largePdfWarning(title, stat.size);
      // Keep the caller's fraction so the progress bar does not reset.
      progress(warning, fraction);
      Zotero.debug(`[reMarkable] ${warning}`);
    }

    // Copy into this realm: typed arrays from privileged APIs fail
    // `instanceof Uint8Array` checks inside the plugin sandbox (pdf-lib).
    // This realm copy is needed, so it is kept; nothing else here copies the
    // bytes before pdf-lib loads them.
    const { buildRemarkablePdf } = await import("./pdfExport");
    const input = doc?.editable ? await pdfWithoutSyncedMarks(pdf) : pdf;
    const built = await buildRemarkablePdf(input, annotations, notes, {
      appendNotesPages: this.settings().appendNotesPages,
      title,
    });
    const pageCount = built.originalPageCount + built.appendedPageCount;
    const builtHash = await sha256Hex(built.bytes);
    if (
      doc &&
      !replacePair &&
      doc.originalPageCount === built.originalPageCount
    ) {
      this.guard(att.libraryID);
      if (doc.editable && built.appendedPageCount < doc.appendedPageCount)
        unreadable(
          "Editable PDF",
          "Changing the notes appendix would remove existing tablet pages",
        );
      if (built.appendedPageCount < doc.appendedPageCount)
        throw new ReviewNeeded({
          location: "PDF",
          reason:
            "Replacing the PDF would remove notes pages. Keep both to pair a new document.",
          tablet: "Annotated tablet document",
          zotero: "Regenerated PDF",
          tabletHash: doc.rmDocHash,
          revision: doc.rmDocHash + "/" + sourceHash,
          choices: ["Keep both"],
        });
      doc.pendingTabletPdfHash = builtHash;
      await this.state.save();
      this.guard(att.libraryID);
      const replaced = await this.cloud.replacePdf(
        doc.rmDocId,
        built.bytes,
        pageCount,
        titleToPush(doc.pushedTitle, title),
        doc.tabletPdfHash,
      );
      // Only advance the recorded hash when the tablet did not change the
      // document since we last pulled it; otherwise the next sync pulls first.
      doc.rmDocHash = nextRmDocHash(doc.rmDocHash, replaced);
      report.updated++;
    } else {
      // A different page count means a new tablet document. What was imported
      // from the old one stays in Zotero but is detached from tracking, so it
      // is neither erased by a pull nor burned into the new PDF.
      const detachedImported = buildDetachedList(doc, detached);
      if (doc && !replacePair)
        unreadable("PDF", "The generated page mapping changed");
      // Record the id before the commit. The root PUT is never retried, so if
      // the server applies it but the response is lost, the next sync either
      // finds no entry (forgets it and uploads again) or adopts the entry; its
      // missing fingerprint then makes push replace the PDF.
      const rmDocId = uuid4();
      doc = newUploadedDoc(
        {
          attachmentKey: att.key,
          sourcePdfHash: sourceHash,
          tabletPdfHash: builtHash,
          retainedNotes: [
            ...(doc?.retainedNotes ?? []),
            ...Object.values(doc?.notePages ?? {}).map((r) => r.noteKey),
          ],
          libraryID: att.libraryID,
          rmDocId,
          originalPageCount: built.originalPageCount,
          appendedPageCount: built.appendedPageCount,
          pageBoxes: built.pageBoxes,
          detachedImported: detachedImported.length
            ? detachedImported
            : undefined,
        },
        CONVERTER_VERSION,
      );
      this.state.set(doc);
      await this.state.save();
      this.guard(att.libraryID);
      const uploaded = await this.cloud.uploadPdf(
        title,
        built.bytes,
        pageCount,
        folderId,
        rmDocId,
      );
      report.uploaded++;
      doc.rmDocHash = uploaded.hash;
    }
    doc.pendingTabletPdfHash = undefined;
    doc.tabletPdfHash = builtHash;
    doc.appendedPageCount = built.appendedPageCount;
    doc.pageBoxes = built.pageBoxes;
    doc.uploadedFingerprint = print;
    doc.pushedTitle = title;
    doc.lastError = undefined;
    doc.lastSync = new Date().toISOString();
    this.state.set(doc);
  }

  private async pull(
    att: Zotero.Item,
    doc: DocState,
    entry: IndexEntry,
    report: SyncReport,
  ) {
    const files = await this.cloud.getDocumentFiles(doc.rmDocId, entry);
    this.guard(att.libraryID);
    if (!files) throw new Error("Document download incomplete");
    const tabletPdf = files.files?.find((f) => f.id === doc.rmDocId + ".pdf");
    if (tabletPdf && tabletPdf.hash === doc.pendingTabletPdfHash) {
      doc.tabletPdfHash = tabletPdf.hash;
      doc.pendingTabletPdfHash = undefined;
    }
    if (
      doc.tabletPdfHash &&
      files.files &&
      tabletPdf?.hash !== doc.tabletPdfHash
    )
      throw new ReviewNeeded({
        location: "PDF",
        reason:
          "The tablet PDF changed. Keep both to preserve its annotations and pair a new document.",
        tablet: "Different tablet PDF",
        zotero: "Current source PDF",
        tabletHash: entry.hash,
        revision: entry.hash + "/" + doc.sourcePdfHash,
        choices: ["Keep both"],
      });
    if (files.files) {
      const metadata = await this.cloud.readMetadata(entry);
      this.guard(att.libraryID);
      if (!metadata || metadata.deleted || metadata.parent === "trash")
        unreadable(
          "Document",
          "The tablet document is unavailable or in Trash",
        );
    }
    let refs: ReturnType<typeof pageRefs>;
    try {
      refs = pageRefs(files.content);
    } catch (e) {
      unreadable("Page map", String(e));
    }
    const mapped = new Set(
      (files.content.cPages?.pages ?? files.content.pages).map(
        (p: string | { id: string }) => (typeof p === "string" ? p : p.id),
      ),
    );
    if ([...files.rm.keys()].some((id) => !mapped.has(id)))
      unreadable("Page map", "The tablet index contains unmapped handwriting");
    if (doc.pageBoxes.length < doc.originalPageCount)
      unreadable("Page map", "PDF page dimensions are missing");
    if (
      refs.some(
        (r) =>
          r.pdfIndex !== undefined &&
          r.pdfIndex >= doc.originalPageCount + doc.appendedPageCount,
      )
    )
      unreadable("Page map", "Page refers to an unknown PDF page");
    // Only completely decoded pages establish that imported marks are gone.
    const { pages, unreadable: unreadablePages } = readPages(
      refs,
      files.rm,
      parseRm,
      (ref, e) =>
        Zotero.debug(
          `[reMarkable] skipping page ${ref.id}: ${(e as Error).message}`,
        ),
    );

    let candidates = convertPages({
      pages,
      originalPageCount: doc.originalPageCount,
      pageBoxes: doc.pageBoxes,
      pageLabels: knownPageLabels(att),
      // Notebook pages pair with notes (noteSync) when the item can hold notes.
      skipInsertedPages: !!att.parentID,
    });
    if (doc.editable)
      candidates = candidates.filter(
        (candidate) =>
          !(
            candidate.kind === "annotation" &&
            (candidate.json.type === "ink" ||
              candidate.json.type === "highlight") &&
            candidate.json.position.pageIndex < doc.originalPageCount
          ),
      );
    // Restore word spacing in highlighted text from Zotero's text extraction.
    if (candidates.some((c) => c.kind === "annotation" && c.json.text)) {
      const pageTexts = await pageTextsOf(att);
      // Built lazily and shared by all highlights on the same page.
      const indexes = new Map<number, PageIndex>();
      for (const c of candidates) {
        if (c.kind === "annotation" && c.json.text) {
          const pageIndex = c.json.position.pageIndex;
          const pageText = pageTexts[pageIndex];
          let index = indexes.get(pageIndex);
          if (!index && pageText) {
            index = buildPageIndex(pageText);
            indexes.set(pageIndex, index);
          }
          c.json.text = respaceWith(c.json.text, pageText, index);
        }
      }
    }
    const importHandwriting = this.settings().importHandwriting;
    if (!importHandwriting) {
      candidates = candidates.filter(
        (c) => c.kind === "annotation" && c.json.type !== "ink",
      );
    }

    const refById = new Map(refs.map((ref) => [ref.id, ref]));
    for (const ref of refs) {
      if (!unreadablePages.has(ref.id)) {
        pageReadable(doc, ref.id);
      } else if (
        reviewEntries(doc).some(
          ([, review]) =>
            review.pageId === ref.id && tabletReviewFileType(review) === "rm",
        )
      ) {
        forgetReview(doc, { pageId: ref.id, location: `Page ${ref.id}` });
      } else {
        pageUnreadable(doc, ref.id, "Tablet page could not be fully decoded");
      }
    }

    // Collect conflicts before saving any candidates on their pages.
    const conflicts = new Map<
      string,
      { review: SyncReview; choice: ReviewChoice | undefined }
    >();
    const pageDigests = new Map<string, string>();
    for (const candidate of candidates) {
      const rec = doc.imported[candidate.rmKey];
      if (
        !rec ||
        isRecordCurrent(
          rec,
          candidate.hash,
          doc.converterVersion,
          CONVERTER_VERSION,
        )
      )
        continue;
      const local = localSnapshot(att, rec.zoteroKey, doc);
      if (local === undefined || rec.localHash === local) continue;
      const pageId = candidate.rmKey.split("/")[0];
      const ref = refById.get(pageId)!;
      let digest = pageDigests.get(pageId);
      if (!digest) {
        digest = await sha256Hex(files.rm.get(pageId)!);
        pageDigests.set(pageId, digest);
      }
      const review: SyncReview = {
        pageId,
        location: candidate.rmKey,
        reason: "The imported Zotero item changed or has no verified baseline",
        zotero: describeImport(att, rec.zoteroKey),
        tablet:
          candidate.kind === "note"
            ? (candidate.text ?? "[Handwriting]")
            : JSON.stringify(candidate.json),
        localKey: rec.zoteroKey,
        localHash: local,
        revision: JSON.stringify([
          digest,
          ref.pdfIndex,
          doc.pageBoxes[ref.pdfIndex ?? -1],
          candidate.hash,
          local,
        ]),
        choices: ["Keep both", "Use tablet version"],
      };
      conflicts.set(candidate.rmKey, {
        review,
        choice: pageDecision(
          doc,
          review,
          [entry.hash, candidate.rmKey, local].join("/"),
        ),
      });
    }

    for (const [, review] of reviewEntries(doc)) {
      const pageId = review.pageId;
      if (
        pageId === undefined ||
        !review.location.startsWith(`${pageId}/`) ||
        unreadablePages.has(pageId) ||
        conflicts.has(review.location)
      )
        continue;
      refreshMissingReview(doc, pageId, review.location);
    }
    const seen = new Set<string>();
    let savedImages = false;
    // Each candidate is saved in isolation: one that cannot be saved is
    // recorded and retried on the next sync without blocking the others.
    const failures: CandidateFailure[] = [];
    for (const c of candidates) {
      // Always "seen", so a skipped or failed one never erases an old import.
      this.guard(att.libraryID);
      seen.add(c.rmKey);
      const pageId = c.rmKey.split("/")[0];
      const conflict = conflicts.get(c.rmKey);
      if (
        unreadablePages.has(pageId) ||
        (conflict && !conflict.choice) ||
        (!conflict?.choice && pageBlocked(doc, pageId))
      )
        continue;
      if (!canSaveCandidate(c.kind, !!att.parentID)) {
        failures.push({
          rmKey: c.rmKey,
          message: "A Zotero parent item is needed to save this note",
        });
        Zotero.debug(
          `[reMarkable] skipping note ${c.rmKey}: standalone attachment has no parent item`,
        );
        continue;
      }
      const rec = doc.imported[c.rmKey];
      if (rec) rec.removedOnTablet = false;
      if (rec) {
        // Unchanged since the current converter imported it, or deleted by
        // the user in Zotero: leave it alone.
        if (
          isRecordCurrent(
            rec,
            c.hash,
            doc.converterVersion,
            CONVERTER_VERSION,
          ) ||
          !existsByKey(att.libraryID, rec.zoteroKey)
        )
          continue;
      }
      try {
        let key: string | undefined = rec?.zoteroKey;
        const local = key ? localSnapshot(att, key, doc) : undefined;
        if (rec && !local) continue; // moved or trashed
        if (rec && conflict?.choice) {
          if (
            (await this.cloud.findDocument(doc.rmDocId))?.hash !== entry.hash ||
            localSnapshot(att, rec.zoteroKey, doc) !== conflict.review.localHash
          ) {
            pageUnreadable(
              doc,
              pageId,
              "A version changed while applying the review",
            );
            const queued = doc.reviews?.[reviewId(conflict.review)];
            if (queued) delete queued.decision;
            continue;
          }
          this.guard(att.libraryID);
          if (conflict.choice === "Keep both") key = undefined;
        }
        if (!key) {
          doc.pendingKeys ??= {};
          key = doc.pendingKeys[c.rmKey] ??= (
            Zotero as any
          ).DataObjectUtilities.generateKey() as string;
          await this.state.save();
        }
        this.guard(att.libraryID);
        const saved =
          c.kind === "annotation"
            ? { key: await saveAnnotation(att, c, key), drawingKey: undefined }
            : await saveNote(att, c, key, {
                doc,
                guard: () => this.guard(att.libraryID),
                checkpoint: () => this.state.save(),
                previous: key === rec?.zoteroKey ? rec?.drawingKey : undefined,
                checkVersion: rec
                  ? (newImageId) => {
                      const item = Zotero.Items.getByLibraryAndKey(
                        att.libraryID,
                        rec.zoteroKey,
                      );
                      if (
                        item &&
                        item.isNote() &&
                        noteSnapshot(
                          item,
                          newImageId ?? stagedDrawingId(doc, item),
                        ) === local
                      )
                        return;
                      throw new Error("The Zotero note changed before import");
                    }
                  : undefined,
                target: {
                  kind: "import",
                  id: c.rmKey,
                  hash: c.hash,
                  detach: rec?.zoteroKey !== key ? rec?.zoteroKey : undefined,
                },
              });
        if (rec && rec.zoteroKey !== key)
          this.state.addDetached(att.libraryID, att.key, [rec.zoteroKey]);
        if (
          c.kind === "annotation" &&
          c.json.type === "ink" &&
          /\/part-\d+$/.test(c.rmKey)
        ) {
          const anchor = doc.imported[c.rmKey.replace(/\/part-\d+$/, "")];
          if (!anchor) throw new Error("First part of handwriting is pending");
          const part = Zotero.Items.getByLibraryAndKey(
            att.libraryID,
            saved.key,
          );
          const first = Zotero.Items.getByLibraryAndKey(
            att.libraryID,
            anchor.zoteroKey,
          );
          if (!part || !first || first.deleted)
            throw new Error("Linked handwriting is incomplete");
          this.guard(att.libraryID);
          part.addRelatedItem(first);
          await part.saveTx();
        }
        doc.imported[c.rmKey] = {
          zoteroKey: saved.key,
          hash: c.hash,
          kind: c.kind,
          localHash: localSnapshot(att, saved.key),
          drawingKey: saved.drawingKey,
        };
        if (doc.pendingKeys) delete doc.pendingKeys[c.rmKey];
        if (conflict) forgetReview(doc, conflict.review);
        await this.state.save();
        if (c.kind === "annotation" && c.json.type === "ink")
          savedImages = true;
        report.imported++;
      } catch (e) {
        if (e instanceof ReviewNeeded) {
          rememberReview(doc, e.review);
          continue;
        }
        const message = (e as Error)?.message ?? String(e);
        Zotero.debug(
          `[reMarkable] could not import ${c.rmKey}: ${e}\n${(e as Error)?.stack}`,
        );
        failures.push({ rmKey: c.rmKey, message });
        // The document moves to the current converter version below, so keep
        // a failed re-import of an old record from looking current.
        if (rec && doc.imported[c.rmKey] === rec)
          doc.imported[c.rmKey] = invalidatedRecord(rec);
      }
    }
    if (failures.length) {
      report.errors.push(
        `Sync incomplete · ${remarkableTitle(att)}: ${formatCandidateFailures(failures, candidates.length)}`,
      );
    }
    // Keep verified erasures as tombstones. Their Zotero keys remain excluded from PDF export.
    for (const rmKey of keysToErase(
      doc.imported,
      seen,
      unreadablePages,
      importHandwriting,
    )) {
      if (pageBlocked(doc, rmKey.split("/")[0])) continue;
      if (doc.editable && /\/(i|g|h)\//.test(rmKey)) continue;
      const rec = doc.imported[rmKey];
      if (!rec.removedOnTablet)
        report.notices.push(
          `${remarkableTitle(att)} · ${rmKey}: Removed on tablet · kept in Zotero`,
        );
      rec.removedOnTablet = true;
    }
    // Render preview images for new/changed ink now. Zotero's annotation list
    // renders missing previews itself, and the "modified" notification that
    // fires mid-render makes it show the annotation twice.
    if (savedImages && this.eligible(att.libraryID)) {
      try {
        await Zotero.PDFWorker.renderAttachmentAnnotations(att.id);
      } catch (e) {
        Zotero.debug(`[reMarkable] preview render failed: ${e}`);
      }
    }
    // Unsaved candidates are retried on the next sync (see needsPull); the
    // saved ones are skipped by hash, so only the failed ones are redone.
    doc.pullIncomplete = failures.length > 0 || undefined;
    if (!doc.pullIncomplete) doc.rmDocHash = entry.hash;
    doc.converterVersion = CONVERTER_VERSION;
    doc.lastSync = new Date().toISOString();
    this.state.set(doc);
  }

  /** Delete the document from the tablet (to trash) and forget it. */
  remove(att: Zotero.Item): Promise<boolean> {
    return this.lock.run(() => this.doRemove(att));
  }

  private async doRemove(att: Zotero.Item) {
    if (!this.eligible(att.libraryID)) return false;
    await this.state.load();
    if (!this.eligible(att.libraryID)) return false;
    const doc = this.state.get(att.libraryID, att.key);
    if (!doc) return false;
    this.guard(att.libraryID);
    if (doc.editable?.pending)
      throw new Error("Finish the pending editable PDF sync first");
    if (
      reviewEntries(doc).length ||
      Object.keys(doc.drawingJournal ?? {}).length ||
      doc.pullIncomplete
    )
      throw new Error("Resolve pending sync before tablet removal");
    if (!doc.rmDocHash)
      throw new Error("Sync this paper before removing the tablet copy");
    this.cloud.checkScope = () => this.guard(att.libraryID);
    try {
      await this.cloud.trashDocument(doc.rmDocId, doc.rmDocHash);
    } finally {
      this.cloud.checkScope = undefined;
    }
    // What was imported stays in Zotero and must not be taken for the user's
    // own work if the item is synced again.
    this.state.forget(att.libraryID, att.key);
    await this.state.save();
    return true;
  }

  /** Reconvert in place, or preview verified imports for recoverable cleanup. */
  removeImported(atts: Zotero.Item[], reimport = false): Promise<number> {
    return this.lock.run(() => this.doRemoveImported(atts, reimport));
  }

  private async doRemoveImported(atts: Zotero.Item[], reimport: boolean) {
    await this.state.load();
    let n = 0;
    for (const att of atts) {
      if (!this.eligible(att.libraryID)) continue;
      const doc = this.state.get(att.libraryID, att.key);
      if (
        !doc ||
        doc.editable?.pending ||
        reviewEntries(doc).length ||
        Object.keys(doc.drawingJournal ?? {}).length
      )
        continue;
      if (reimport) {
        doc.converterVersion = undefined;
        doc.pullIncomplete = true;
        continue;
      }
      const eligible = [];
      const canTrash = async (rec: DocState["imported"][string]) => {
        if (
          !rec.localHash ||
          localSnapshot(att, rec.zoteroKey) !== rec.localHash
        )
          return false;
        const item = Zotero.Items.getByLibraryAndKey(
          att.libraryID,
          rec.zoteroKey,
        );
        if (!item) return false;
        if (item.isNote()) {
          for (const id of item.getAttachments()) {
            const image = Zotero.Items.get(id);
            if (
              !image ||
              image.key !== rec.drawingKey ||
              !(await unchangedManagedDrawing(doc, image))
            )
              return false;
          }
        }
        return true;
      };
      for (const rec of Object.values(doc.imported)) {
        this.guard(att.libraryID);
        if (await canTrash(rec)) eligible.push(rec);
      }
      if (
        !eligible.length ||
        !Zotero.getMainWindow().confirm(
          "Move these unchanged plugin imports to Zotero Trash? Restore them from Trash to recover them.\n" +
            eligible
              .map(
                (rec) =>
                  rec.kind +
                  " " +
                  rec.zoteroKey +
                  " · " +
                  describeImport(att, rec.zoteroKey).slice(0, 120),
              )
              .join("\n"),
        )
      )
        continue;
      for (const rec of eligible) {
        this.guard(att.libraryID);
        if (!(await canTrash(rec))) continue;
        this.guard(att.libraryID);
        if (localSnapshot(att, rec.zoteroKey) !== rec.localHash) continue;
        await trashByKey(att.libraryID, rec.zoteroKey);
        n++;
      }
    }
    await this.state.save();
    return n;
  }
}

function embeddedCoverage(target: EditableMark, annotations: EditableMark[]) {
  const available = annotations
    .filter((mark) => mark.page === target.page && mark.kind === target.kind)
    .flatMap((mark) => mark.paths);
  return target.paths.every((path) => {
    const index = available.findIndex((candidate) =>
      samePaths(
        { ...target, paths: [path] },
        { ...target, paths: [candidate] },
      ),
    );
    if (index < 0) return false;
    available.splice(index, 1);
    return true;
  });
}

function editableFromZotero(
  type: string,
  color: string,
  position: import("./types").ZPosition,
): EditableMark | undefined {
  if (type !== "ink" && type !== "highlight") return;
  const paths = (type === "ink" ? position.paths : position.rects)?.map(
    (path) => path.map(roundMark),
  );
  if (!paths) return;
  const mark: EditableMark = {
    kind: type,
    page: position.pageIndex,
    color: color.toLowerCase(),
    width: type === "ink" ? roundMark(position.width ?? 1) : 0,
    paths,
  };
  if (validEditableMark(mark)) return mark;
}

async function pageTextsOf(att: Zotero.Item): Promise<string[]> {
  try {
    const res = await Zotero.PDFWorker.getFullText(att.id, null, true);
    return splitPageTexts(res?.text, res?.totalPages);
  } catch (e) {
    Zotero.debug(`[reMarkable] full text unavailable: ${(e as Error).message}`);
    return [];
  }
}
