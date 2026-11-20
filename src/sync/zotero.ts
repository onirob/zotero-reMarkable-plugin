/** Zotero-side helpers: read Zotero data and write imported annotations. */
import { mergeAnnotationFields } from "./annotationMerge";
import type { AnnotationCandidate, NoteCandidate } from "./convert";
import { fingerprint } from "./convert";
import {
  noteSnapshot,
  stagedDrawingId,
  writeDrawing,
  type DrawingWrite,
} from "./drawingJournal";
import {
  drawingImg,
  isSyncedNoteTitle,
  paragraphsToHtml,
  patchDrawing,
  wrapNoteHtml,
} from "./notes";
import type { RmParagraph } from "../remarkable/rmscene";
import { skipKeys } from "./detached";
import type { DocState } from "./state";
import type { ZAnnotation, ZNote } from "./types";

/** Tag on imported annotations and notes. Must differ from the default `syncTag` pref, which users apply to mark items for sync. */
export const IMPORT_TAG = "reMarkable import";
const AUTHOR = "reMarkable";

/** PDF attachments for a mix of regular items and attachments. */
export async function pdfAttachments(
  items: Zotero.Item[],
  eligible: (id: number) => boolean = () => true,
): Promise<Zotero.Item[]> {
  const out = new Map<number, Zotero.Item>();
  for (const item of items) {
    if (!eligible(item.libraryID)) continue;
    if (item.isPDFAttachment?.()) out.set(item.id, item);
    else if (item.isRegularItem()) {
      for (const id of item.getAttachments()) {
        const att = (Zotero.Items.get(id) as Zotero.Item | false) || undefined;
        if (att && eligible(att.libraryID) && att.isPDFAttachment())
          out.set(att.id, att);
      }
    }
  }
  return [...out.values()];
}

/** Title shown on the tablet, e.g. "Liang et al. 2023 - Code as policies". */
export function remarkableTitle(attachment: Zotero.Item): string {
  const parent = attachment.parentItem;
  if (!parent) return attachment.getDisplayTitle().replace(/\.pdf$/i, "");
  const creator = parent.getField("firstCreator") as string;
  const year = (parent.getField("date", true, true) as string).slice(0, 4);
  const title =
    (parent.getField("shortTitle") as string) ||
    (parent.getField("title") as string);
  const head = [creator, year && year !== "0000" ? year : ""]
    .filter(Boolean)
    .join(" ");
  const name = head ? `${head} - ${title}` : title;
  return name.replace(/[\\/:*?"<>|]/g, "-").slice(0, 120);
}

/** Zotero-made annotations (excludes those imported from the tablet). */
export function zoteroAnnotations(
  attachment: Zotero.Item,
  doc?: DocState,
  /** Keys detached from forgotten documents (SyncStateStore.getDetached). */
  detached: Iterable<string> = [],
): ZAnnotation[] {
  const skip = skipKeys(doc, detached);
  return attachment
    .getAnnotations()
    .filter((a) => !skip.has(a.key))
    .map((a) => {
      let position: ZAnnotation["position"];
      try {
        position = JSON.parse(a.annotationPosition);
      } catch {
        return undefined;
      }
      return {
        key: a.key,
        type: a.annotationType as ZAnnotation["type"],
        text: a.annotationText ?? "",
        comment: a.annotationComment ?? "",
        color: a.annotationColor || "#ffd400",
        pageLabel: a.annotationPageLabel,
        sortIndex: a.annotationSortIndex,
        position,
        tags: a.getTags().map((t) => t.tag),
      } as ZAnnotation;
    })
    .filter(
      (a): a is ZAnnotation => !!a && typeof a.position?.pageIndex === "number",
    );
}

/** Child notes of the parent item (excluding notes this plugin created). */
export function zoteroNotes(
  attachment: Zotero.Item,
  doc?: DocState,
  /** Keys detached from forgotten documents (SyncStateStore.getDetached). */
  detached: Iterable<string> = [],
): ZNote[] {
  const parent = attachment.parentItem;
  if (!parent) return [];
  const skip = skipKeys(doc, detached);
  for (const rec of Object.values(doc?.notePages ?? {})) skip.add(rec.noteKey);
  for (const key of doc?.retainedNotes ?? []) skip.add(key);
  return (
    Zotero.Items.get(parent.getNotes())
      // Notes with their own page on the tablet are not repeated in the PDF.
      .filter((n) => !skip.has(n.key) && !isSyncedNoteTitle(n.getNoteTitle()))
      .map((n) => ({
        key: n.key,
        title: n.getNoteTitle(),
        text: htmlToText(n.getNote()),
      }))
      .filter((n) => n.text.trim())
  );
}

export function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|blockquote|pre|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Page labels already known from existing annotations (pageIndex -> label). */
export function knownPageLabels(attachment: Zotero.Item): string[] {
  const labels: string[] = [];
  for (const a of attachment.getAnnotations()) {
    try {
      const idx = JSON.parse(a.annotationPosition).pageIndex;
      if (a.annotationPageLabel && labels[idx] === undefined)
        labels[idx] = a.annotationPageLabel;
    } catch {
      // ignore
    }
  }
  return labels;
}

export function describeImport(att: Zotero.Item, key: string) {
  const item = Zotero.Items.getByLibraryAndKey(att.libraryID, key);
  if (!item || item.deleted) return "Item missing or in Trash";
  return item.isNote()
    ? item.getNote()
    : JSON.stringify({
        type: item.annotationType,
        text: item.annotationText,
        comment: item.annotationComment,
        color: item.annotationColor,
        position: item.annotationPosition,
      });
}

export function localSnapshot(att: Zotero.Item, key: string, doc?: DocState) {
  const item = Zotero.Items.getByLibraryAndKey(att.libraryID, key);
  if (!item || item.deleted) return undefined;
  if (item.isAnnotation() && item.parentID === att.id)
    return fingerprint([
      item.parentID,
      item.annotationType,
      item.annotationPosition,
      item.annotationText,
      item.annotationComment,
      item.annotationColor,
      item.annotationPageLabel,
      item.annotationSortIndex,
      item.getTags(),
    ]);
  if (item.isNote() && att.parentID && item.parentID === att.parentID)
    return noteSnapshot(item, doc ? stagedDrawingId(doc, item) : undefined);
  return undefined;
}

export async function saveAnnotation(
  attachment: Zotero.Item,
  c: AnnotationCandidate,
  key?: string,
): Promise<string> {
  const position = c.json.position;
  // An update keeps what the user edited in Zotero (comment, tags).
  const found = key
    ? (Zotero.Items.getByLibraryAndKey(attachment.libraryID, key) as
        | Zotero.Item
        | false)
    : false;
  const existing =
    found && found.isAnnotation()
      ? {
          comment: found.annotationComment ?? "",
          tags: found.getTags() as { tag: string; type?: number }[],
        }
      : undefined;
  const merged = mergeAnnotationFields(c.json, IMPORT_TAG, existing);
  const json: any = {
    key: key ?? (Zotero as any).DataObjectUtilities.generateKey(),
    type: c.json.type,
    color: c.json.color,
    pageLabel: c.json.pageLabel,
    sortIndex: c.json.sortIndex,
    position,
    comment: merged.comment,
    authorName: AUTHOR,
    tags: merged.tags,
  };
  if (c.json.type === "highlight") json.text = c.json.text ?? "";
  const item = await Zotero.Annotations.saveFromJSON(attachment, json);
  return item.key;
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function getOrCreateNote(
  attachment: Zotero.Item,
  key: string,
  initialHtml: string,
  write: DrawingWrite,
) {
  write.guard();
  const parentID = attachment.parentID;
  if (!parentID) throw new Error("Notes need a parent item");
  const existing = Zotero.Items.getByLibraryAndKey(attachment.libraryID, key);
  if (existing) {
    if (
      !existing.isNote() ||
      existing.deleted ||
      existing.parentID !== parentID
    )
      throw new Error("The Zotero note moved or was removed");
    return existing;
  }
  write.checkVersion?.();
  const note = new Zotero.Item("note");
  note.libraryID = attachment.libraryID;
  note.key = key;
  note.parentID = parentID;
  note.setNote(initialHtml);
  note.addTag(IMPORT_TAG);
  write.guard();
  await note.saveTx();
  return note;
}

/** Create or update a child note holding handwriting (SVG) and typed text. */
export async function saveNote(
  attachment: Zotero.Item,
  candidate: NoteCandidate,
  key: string,
  write: DrawingWrite,
) {
  const title = `<h1>${escapeHtml(candidate.title)}</h1>`;
  const note = await getOrCreateNote(
    attachment,
    key,
    wrapNoteHtml(title),
    write,
  );
  return writeDrawing(
    attachment,
    note,
    candidate.svg,
    (image) => {
      let body = title;
      if (image) body += `<p>${drawingImg(image)}</p>`;
      if (candidate.text)
        body += candidate.text
          .split(/\n{2,}/)
          .map((text) => `<p>${escapeHtml(text).replace(/\n/g, "<br/>")}</p>`)
          .join("");
      return wrapNoteHtml(body);
    },
    write,
  );
}

export function existsByKey(libraryID: number, key: string) {
  const item = Zotero.Items.getByLibraryAndKey(libraryID, key) as
    | Zotero.Item
    | false;
  return !!item && !item.deleted;
}

/** Child notes of the attachment's parent item, including trashed ones. */
export function childNotesWithTrashed(attachment: Zotero.Item): Zotero.Item[] {
  const parent = attachment.parentItem;
  if (!parent) return [];
  return Zotero.Items.get(parent.getNotes(true));
}

/** Whether an item with this key still exists in the library (any parent). */
export function existsInLibrary(libraryID: number, key: string): boolean {
  return !!Zotero.Items.getByLibraryAndKey(libraryID, key);
}

/** Move an item to Zotero's trash (recoverable). */
export async function trashByKey(libraryID: number, key: string) {
  const item = Zotero.Items.getByLibraryAndKey(libraryID, key) as
    | Zotero.Item
    | false;
  if (item && !item.deleted) {
    item.deleted = true;
    try {
      await item.saveTx();
    } catch (error) {
      item.deleted = false;
      throw error;
    }
  }
}

export interface SyncedNoteOptions extends DrawingWrite {
  /** Regenerate the body only when there is a text change. */
  rewriteBody: boolean;
}

export async function writeSyncedNote(
  attachment: Zotero.Item,
  key: string,
  title: string,
  body: RmParagraph[],
  drawing: { markup: string; width: number; height: number } | undefined,
  opts: SyncedNoteOptions,
) {
  const note = await getOrCreateNote(
    attachment,
    key,
    paragraphsToHtml(title, body),
    opts,
  );
  return writeDrawing(
    attachment,
    note,
    drawing,
    (image) =>
      opts.rewriteBody
        ? paragraphsToHtml(title, body, image)
        : patchDrawing(note.getNote(), opts.previous, image),
    opts,
  );
}
