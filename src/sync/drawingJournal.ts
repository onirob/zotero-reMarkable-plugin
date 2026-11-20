import { sha256Hex } from "../remarkable/hash";
import { fingerprint } from "./convert";
import type { NoteDrawing } from "./notes";
import { forgetReview, rememberReview, ReviewNeeded } from "./review";
import type { DocState, NotePageRecord } from "./state";

type Target =
  | { kind: "import"; id: string; hash: string; detach?: string }
  | { kind: "page"; id: string; record: NotePageRecord; retain?: string };

export interface DrawingIntent {
  target: Target;
  noteKey: string;
  pageId: string;
  before: string;
  attachments: number[];
  wanted?: string;
  previous?: string;
  replacement?: { key: string; digest: string; owned: boolean };
  after?: string;
  recorded?: boolean;
}

export interface DrawingContext {
  doc: DocState;
  guard: () => void;
  checkpoint: () => Promise<void>;
}

export type DrawingWrite = DrawingContext & {
  target: Target;
  previous?: string;
  checkVersion?: (newImageId?: number) => void;
};

type Drawing = { markup: string; width: number; height: number };

function itemByKey(att: Zotero.Item, key: string) {
  return Zotero.Items.getByLibraryAndKey(att.libraryID, key);
}

export function stagedDrawingId(doc: DocState, note: Zotero.Item) {
  const intent = doc.drawingJournal?.[note.key];
  if (!intent || intent.recorded || !intent.replacement) return undefined;
  const image = itemByKey(note, intent.replacement.key);
  if (image && image.parentID === note.id && !image.deleted) return image.id;
}

export function noteSnapshot(note: Zotero.Item, stagingId?: number) {
  return fingerprint([
    note.parentID,
    note.getNote(),
    note.getAttachments().filter((id) => id !== stagingId),
    note.getTags(),
  ]);
}

function reviewFor(intent: DrawingIntent) {
  return { pageId: intent.pageId, location: "Drawing for " + intent.target.id };
}

function ambiguous(intent: DrawingIntent): never {
  throw new ReviewNeeded({
    ...reviewFor(intent),
    reason:
      "A staged drawing or its note changed during recovery. Both copies have been preserved.",
    revision: intent.before,
    choices: ["Retry"],
  });
}

async function digestOf(image: Zotero.Item) {
  const path = await image.getFilePathAsync();
  if (!path) return undefined;
  try {
    return await sha256Hex(new Uint8Array(await IOUtils.read(path)));
  } catch {
    return undefined;
  }
}

export async function unchangedManagedDrawing(
  doc: DocState,
  image: Zotero.Item,
) {
  const expected = doc.drawingDigests?.[image.key];
  return !!expected && (await digestOf(image)) === expected;
}

function validNote(
  att: Zotero.Item,
  note: Zotero.Item | false,
): note is Zotero.Item {
  return (
    !!note && note.isNote() && !note.deleted && note.parentID === att.parentID
  );
}

async function recordSaved(
  att: Zotero.Item,
  note: Zotero.Item,
  intent: DrawingIntent,
  ctx: DrawingContext,
) {
  const { doc, guard, checkpoint } = ctx;
  guard();
  if (!validNote(att, note) || intent.after !== noteSnapshot(note))
    ambiguous(intent);
  const replacement = intent.replacement;
  if (replacement) {
    const image = itemByKey(att, replacement.key);
    if (
      !image ||
      image.deleted ||
      image.parentID !== note.id ||
      (await digestOf(image)) !== replacement.digest
    )
      ambiguous(intent);
  }
  guard();
  if (!validNote(att, note) || intent.after !== noteSnapshot(note))
    ambiguous(intent);
  const drawingKey = replacement?.key;
  const target = intent.target;
  if (target.kind === "import") {
    doc.imported[target.id] = {
      kind: "note",
      hash: target.hash,
      zoteroKey: note.key,
      drawingKey,
      localHash: noteSnapshot(note),
    };
    if (target.detach)
      doc.detachedImported = [
        ...new Set([...(doc.detachedImported ?? []), target.detach]),
      ];
    if (doc.pendingKeys) delete doc.pendingKeys[target.id];
  } else {
    doc.notePages ??= {};
    const current = doc.notePages[target.id];
    const record = { ...target.record, noteKey: note.key, drawingKey };
    if (current?.noteKey === note.key) Object.assign(current, record);
    else doc.notePages[target.id] = record;
    if (target.retain)
      doc.retainedNotes = [
        ...new Set([...(doc.retainedNotes ?? []), target.retain]),
      ];
    if (doc.pendingKeys) {
      delete doc.pendingKeys["copy/" + target.id];
      delete doc.pendingKeys["page/" + target.id];
    }
  }
  if (replacement?.owned) {
    doc.drawingDigests ??= {};
    doc.drawingDigests[replacement.key] = replacement.digest;
  }
  intent.recorded = true;
  forgetReview(doc, reviewFor(intent));
  forgetReview(doc, { pageId: intent.pageId, location: target.id });
  await checkpoint();
}

/** Run only after both the note and its drawing ownership were saved. */
async function finish(
  att: Zotero.Item,
  intent: DrawingIntent,
  ctx: DrawingContext,
) {
  const { doc, guard, checkpoint } = ctx;
  guard();
  const old = intent.previous;
  const expected = old && doc.drawingDigests?.[old];
  const note = itemByKey(att, intent.noteKey);
  if (
    old &&
    expected &&
    old !== intent.replacement?.key &&
    validNote(att, note)
  ) {
    const image = itemByKey(att, old);
    if (
      image &&
      !image.deleted &&
      image.parentID === note.id &&
      !note.getNote().includes(old) &&
      (await digestOf(image)) === expected
    ) {
      guard();
      if (
        validNote(att, note) &&
        image.parentID === note.id &&
        !note.getNote().includes(old)
      ) {
        image.deleted = true;
        try {
          await image.saveTx();
        } catch (error) {
          image.deleted = false;
          throw error;
        }
      }
    }
    delete doc.drawingDigests?.[old];
  }
  delete doc.drawingJournal?.[intent.noteKey];
  await checkpoint();
}

async function stagedImage(
  att: Zotero.Item,
  note: Zotero.Item,
  intent: DrawingIntent,
) {
  let image = intent.replacement
    ? itemByKey(att, intent.replacement.key)
    : false;
  if (
    intent.replacement &&
    (!image ||
      image.deleted ||
      image.parentID !== note.id ||
      (await digestOf(image)) !== intent.replacement.digest)
  )
    ambiguous(intent);
  if (!image) {
    const added = note
      .getAttachments()
      .filter((id) => !intent.attachments.includes(id));
    if (added.length) {
      const candidate = added.length === 1 && Zotero.Items.get(added[0]);
      if (
        !intent.wanted ||
        !candidate ||
        candidate.parentID !== note.id ||
        candidate.attachmentContentType !== "image/svg+xml" ||
        (await digestOf(candidate)) !== intent.wanted
      )
        ambiguous(intent);
      image = candidate;
      // The import may have finished immediately before interruption.
      // Reuse identical content, but never remove an attachment of uncertain ownership.
      intent.replacement = {
        key: image.key,
        digest: intent.wanted,
        owned: false,
      };
    }
  }
  return image;
}

export async function recoverDrawings(att: Zotero.Item, ctx: DrawingContext) {
  for (const intent of Object.values(ctx.doc.drawingJournal ?? {})) {
    ctx.guard();
    if (intent.recorded) {
      // Re-save in-memory records after a failed checkpoint before cleanup.
      await ctx.checkpoint();
      await finish(att, intent, ctx);
      continue;
    }
    try {
      const note = itemByKey(att, intent.noteKey);
      if (!validNote(att, note)) ambiguous(intent);
      if (intent.after === noteSnapshot(note)) {
        await recordSaved(att, note, intent, ctx);
        await finish(att, intent, ctx);
        continue;
      }
      const image = await stagedImage(att, note, intent);
      if (intent.before !== noteSnapshot(note, image ? image.id : undefined))
        ambiguous(intent);
      ctx.guard();
      await ctx.checkpoint();
    } catch (error) {
      if (!(error instanceof ReviewNeeded)) throw error;
      rememberReview(ctx.doc, error.review);
    }
  }
}

export async function writeDrawing(
  att: Zotero.Item,
  note: Zotero.Item,
  drawing: Drawing | undefined,
  html: (image?: NoteDrawing) => string,
  options: DrawingWrite,
) {
  const { doc, target, previous, guard, checkpoint, checkVersion } = options;
  const pageId = target.kind === "page" ? target.id : target.id.split("/")[0];
  const wanted = drawing
    ? await sha256Hex(new TextEncoder().encode(drawing.markup))
    : undefined;
  guard();
  doc.drawingJournal ??= {};
  let intent = doc.drawingJournal[note.key];
  if (!intent) {
    intent = {
      target,
      pageId,
      noteKey: note.key,
      before: noteSnapshot(note),
      attachments: note.getAttachments(),
      previous,
      wanted,
    };
    doc.drawingJournal[note.key] = intent;
    await checkpoint();
  }
  guard();
  if (
    !validNote(att, note) ||
    intent.target.kind !== target.kind ||
    intent.target.id !== target.id
  )
    ambiguous(intent);
  let image = await stagedImage(att, note, intent);
  if (intent.before !== noteSnapshot(note, image ? image.id : undefined))
    ambiguous(intent);
  if (intent.wanted !== wanted) {
    // The tablet moved on before the staged content was saved. Retain the
    // unused attachment and prepare again from the verified current note.
    intent.before = noteSnapshot(note);
    intent.attachments = note.getAttachments();
    intent.wanted = wanted;
    delete intent.replacement;
    image = false;
    await checkpoint();
  }
  guard();
  if (!image && drawing) {
    checkVersion?.();
    image = await Zotero.Attachments.importEmbeddedImage({
      blob: new Blob([drawing.markup], { type: "image/svg+xml" }),
      parentItemID: note.id,
    });
    intent.replacement = { key: image.key, digest: wanted!, owned: true };
  }
  guard();
  checkVersion?.(image ? image.id : undefined);
  if (intent.before !== noteSnapshot(note, image ? image.id : undefined))
    ambiguous(intent);
  const next = html(
    image && drawing
      ? { key: image.key, width: drawing.width, height: drawing.height }
      : undefined,
  );
  const original = note.getNote();
  // Capture Zotero's normalized HTML without leaving an unsaved edit across an await.
  note.setNote(next);
  intent.after = noteSnapshot(note);
  note.setNote(original);
  intent.target = target;
  await checkpoint();
  guard();
  checkVersion?.(image ? image.id : undefined);
  if (intent.before !== noteSnapshot(note, image ? image.id : undefined))
    ambiguous(intent);
  note.setNote(next);
  try {
    await note.saveTx();
  } catch (error) {
    if (intent.after === noteSnapshot(note)) note.setNote(original);
    throw error;
  }
  await recordSaved(att, note, intent, options);
  await finish(att, intent, options);
  return { key: note.key, drawingKey: intent.replacement?.key };
}
