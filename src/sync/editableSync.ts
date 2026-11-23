import type { IndexEntry, RemarkableCloud } from "../remarkable/cloud";
import { pageRefs, reconcileContent } from "../remarkable/content";
import { sha256Hex, uuid4 } from "../remarkable/hash";
import { parseRm, type RmPage } from "../remarkable/rmscene";
import { writePageMarks } from "../remarkable/rmwrite";
import {
  type EmbeddedPdf,
  EDITABLE_PDF_LIMIT,
  openEmbeddedPdf,
  patchEmbeddedPdf,
  referencePageFingerprint,
} from "./embeddedPdf";
import {
  compareMark,
  markSignature,
  PAGE_BASE_VERSION,
  samePaths,
  type EditableMark,
  type MarkLink,
  type MarkTransaction,
} from "./editableMarks";
import { fingerprint } from "./convert";
import {
  forgetReview,
  isWholePdfChoice,
  pageDecision,
  PDF_PAGE_LAYOUT_REVIEW,
  rememberReview,
  reviewEntries,
  reviewId,
  ReviewNeeded,
  unreadable,
} from "./review";
import type { DocState, SyncStateStore } from "./state";
import { combineTabletMarks, tabletMarks, toSceneMark } from "./tabletMarks";
import {
  inspectTabletPdf,
  pdfRecoveryFolder,
  savePdfRecovery,
  tabletVersion,
  verifyPdfRecovery,
  zoteroVersion,
} from "./wholePdf";

export type EditableSnapshot = NonNullable<
  Awaited<ReturnType<RemarkableCloud["getDocumentFiles"]>>
>;
type LocalFile = { path: string; bytes: Uint8Array; hash: string };

interface EditableContext {
  att: Zotero.Item;
  doc: DocState;
  store: SyncStateStore;
  cloud: RemarkableCloud;
  authorUuid: string;
  guard: () => void;
  seed: () => EditableMark[];
  cleanTabletPdf: (files: EditableSnapshot) => Promise<Uint8Array>;
  wholeUploadFingerprint: (base: string) => string;
  earlierPdfPath?: string;
}

type Candidate = {
  id: string;
  previous?: MarkLink;
  pdf?: EditableMark;
  tablet?: EditableMark;
  native: string[];
  desired?: EditableMark;
  keepTablet?: boolean;
  resolved?: string;
  partialErasure?: EditableMark;
};

const legacyId = (page: number, id: string) => `${page}/${id}`;
const where = (page: number) => `Embedded annotations · page ${page + 1}`;
const emptyHash = "";
const hashPage = (bytes: Uint8Array | undefined) =>
  bytes ? sha256Hex(bytes) : Promise.resolve(emptyHash);
const tabletPdfHash = (files: EditableSnapshot, docId: string) =>
  files.files.find((file) => file.id === `${docId}.pdf`)?.hash;
const contentHash = (files: EditableSnapshot) =>
  sha256Hex(new TextEncoder().encode(JSON.stringify(files.content)));

function sceneLayers(scene: RmPage) {
  return new Map(
    [...scene.lines, ...scene.glyphs].map(({ id, parent }) => [id, parent]),
  );
}

function tabletLink(
  candidate: Candidate,
  tablet: EditableMark,
  layers: Map<string, string>,
): MarkLink {
  return {
    id: candidate.id,
    pdf: candidate.desired!,
    tablet,
    native: candidate.native,
    nativeLayers: candidate.native.map((id) => layers.get(id)!),
  };
}

function verifyPageLayout(
  local: LocalFile,
  reason: string,
  verifyEarlierPdf?: true,
): never {
  throw new ReviewNeeded({
    location: PDF_PAGE_LAYOUT_REVIEW,
    reason,
    zotero: "The current PDF and its annotations are preserved.",
    tablet: "The paired PDF and its annotations are preserved.",
    revision: local.hash,
    choices: ["Retry"],
    verifyEarlierPdf,
  });
}

/** Upgrade only from bytes already authenticated by the pairing's previous baseline. */
async function verifyBaseline(
  ctx: EditableContext,
  local: LocalFile,
  pdf: EmbeddedPdf,
  remotePdf: string,
) {
  const { doc, guard } = ctx;
  const edit = doc.editable!;
  const previousVersion = edit.baseVersion ?? 1;
  const changed =
    "The page content, order, geometry, or rendering resources could not be matched to the verified PDF. Use the original page layout and retry.";
  if (edit.baseVersion === PAGE_BASE_VERSION) {
    if (edit.base !== pdf.base) verifyPageLayout(local, changed);
    return;
  }
  if (
    doc.sourcePdfHash === local.hash ||
    (edit.base && (await pdf.baseAtVersion(previousVersion)) === edit.base)
  )
    return;

  async function checkReference(bytes: Uint8Array, appended: number) {
    const reference = await referencePageFingerprint(
      bytes,
      doc.originalPageCount,
      appended,
    );
    const trusted =
      (appended === 0 && doc.sourcePdfHash === (await sha256Hex(bytes))) ||
      (edit.base && (await reference(previousVersion)) === edit.base);
    return trusted ? reference(PAGE_BASE_VERSION) : undefined;
  }

  let reference: string | undefined;
  if (ctx.earlierPdfPath) {
    try {
      guard();
      const path = ctx.earlierPdfPath;
      if (path === local.path)
        throw new Error(
          "Choose a copy saved before the PDF editor changed the file.",
        );
      const bytes = new Uint8Array(
        await IOUtils.read(path, { maxBytes: EDITABLE_PDF_LIMIT + 1 }),
      );
      guard();
      reference = await checkReference(bytes, 0);
    } catch (error) {
      Zotero.logError(error as Error);
    }
    if (!reference)
      verifyPageLayout(
        local,
        "The selected PDF does not match this pairing’s saved baseline. Choose an earlier copy of this same paper.",
        true,
      );
  } else if (doc.tabletPdfHash === remotePdf) {
    try {
      const bytes = await ctx.cloud.getBlob(
        remotePdf,
        `${doc.rmDocId}.pdf`,
        EDITABLE_PDF_LIMIT,
      );
      guard();
      reference = await checkReference(bytes, doc.appendedPageCount);
    } catch (error) {
      Zotero.logError(error as Error);
    }
  }
  guard();
  if (!reference)
    verifyPageLayout(
      local,
      "The previous page layout could not be verified from the tablet copy. Select a PDF saved before the editor change to compare the pages.",
      true,
    );
  if (reference !== pdf.base) verifyPageLayout(local, changed);
}

async function reviewWholePdf(
  ctx: EditableContext,
  local: LocalFile,
  pdf: EmbeddedPdf,
  files: EditableSnapshot,
  remotePdf: string,
  previousReview: ReviewNeeded,
) {
  const { doc, store, guard } = ctx;
  if (
    doc.pendingTabletPdfHash ||
    Object.keys(doc.drawingJournal ?? {}).length ||
    Object.keys(doc.pendingPages ?? {}).length ||
    Object.keys(doc.pendingKeys ?? {}).length
  )
    throw previousReview;
  let tablet: Awaited<ReturnType<typeof inspectTabletPdf>>;
  try {
    tablet = await inspectTabletPdf(ctx.cloud, doc, files, guard);
  } catch (error) {
    throw new ReviewNeeded({
      ...previousReview.review,
      tablet: (error as Error).message,
    });
  }
  let fromTablet: Awaited<ReturnType<typeof tabletVersion>> | undefined;
  let fromZotero: Awaited<ReturnType<typeof zoteroVersion>> | undefined;
  let tabletDetails = `${tablet.pageIds.length} PDF pages`;
  let zoteroDetails = `${pdf.boxes.length} PDF pages`;
  try {
    fromTablet = await tabletVersion(tablet, files);
    tabletDetails += `, ${fromTablet.links.length} editable marks`;
  } catch (error) {
    tabletDetails += ` · ${(error as Error).message}`;
  }
  try {
    fromZotero = await zoteroVersion(
      local.bytes,
      pdf,
      tablet,
      files,
      doc,
      ctx.authorUuid,
    );
    zoteroDetails += `, ${fromZotero.links.length} editable marks`;
  } catch (error) {
    zoteroDetails += ` · ${(error as Error).message}`;
  }
  const review = {
    ...previousReview.review,
    revision: await sha256Hex(
      new TextEncoder().encode(
        JSON.stringify([local.path, local.hash, files.hash]),
      ),
    ),
    zotero: zoteroDetails,
    tablet: tabletDetails,
  };
  if (fromTablet) review.choices = [...review.choices, "Use reMarkable PDF"];
  if (fromZotero) review.choices = [...review.choices, "Use Zotero PDF"];
  const prior = doc.reviews?.document;
  const choice = prior?.decision;
  if (
    !isWholePdfChoice(choice) ||
    prior?.revision !== review.revision ||
    !review.choices.includes(choice)
  )
    throw new ReviewNeeded(review);
  const chosen = choice === "Use reMarkable PDF" ? fromTablet! : fromZotero!;
  const upload = choice === "Use Zotero PDF" ? fromZotero : undefined;
  const pageIds = upload?.pageIds ?? tablet.pageIds;
  const retiredPages = upload ? tablet.pageIds : [];
  const observed = new Set([...files.rm.keys(), ...pageIds, ...retiredPages]);
  const pages = upload?.pages ?? new Map<string, Uint8Array>();
  const id = uuid4();
  const stage = store.editableStage(id);
  guard();
  const backupManifest = await savePdfRecovery(
    stage,
    doc,
    local.bytes,
    tablet,
    files,
    fromTablet?.bytes,
    guard,
  );
  const plan: MarkTransaction = {
    id,
    beforePdf: local.hash,
    afterPdf: await sha256Hex(chosen.bytes),
    beforeTabletPdf: remotePdf,
    observedPages: Object.fromEntries(
      await Promise.all(
        [...observed].map(async (id) => [id, await hashPage(files.rm.get(id))]),
      ),
    ),
    pages: await Promise.all(
      [...pages].map(async ([id, bytes]) => ({
        id,
        hash: await sha256Hex(bytes),
        before: "",
      })),
    ),
    tabletPdfHash: upload ? await sha256Hex(upload.tabletBytes) : undefined,
    beforeContentHash: await contentHash(files),
    afterContentHash: upload
      ? await contentHash({ ...files, content: upload.content })
      : undefined,
    tabletContent: upload?.content,
    base: chosen.verified.base,
    baseVersion: PAGE_BASE_VERSION,
    pageIds,
    links: chosen.links,
    erased: [],
    resolved: reviewEntries(doc).map(([key]) => key),
    wholePdf: {
      beforePath: local.path,
      beforeDocument: files.hash,
      pageBoxes: chosen.verified.boxes,
      appendedPageCount: doc.appendedPageCount,
      retiredPages,
      backupManifest,
    },
  };
  return stageAndCommit(
    ctx,
    local,
    plan,
    chosen.bytes,
    pages,
    upload?.tabletBytes,
  );
}

function blocked(doc: DocState, pageId: string) {
  return reviewEntries(doc).some(
    ([, review]) => review.pageId === pageId && !review.decision,
  );
}

function mappedPages(files: EditableSnapshot, count: number) {
  try {
    const mapped = pageRefs(files.content).filter(
      (ref) => ref.pdfIndex !== undefined && ref.pdfIndex < count,
    );
    if (mapped.length === count && mapped.every((ref, i) => ref.pdfIndex === i))
      return mapped.map((ref) => ref.id);
  } catch (error) {
    unreadable("Editable PDF", (error as Error).message);
  }
  unreadable(
    "Editable PDF",
    "The tablet and original PDF no longer have a verified one-to-one page map",
  );
}

function verifyMapping(files: EditableSnapshot, ids: string[]) {
  if (mappedPages(files, ids.length).some((id, i) => id !== ids[i]))
    unreadable("Editable PDF", "The tablet page mapping changed during sync");
}

async function getFiles(ctx: EditableContext, entry?: IndexEntry) {
  ctx.guard();
  const files = await ctx.cloud.getDocumentFiles(ctx.doc.rmDocId, entry);
  if (!files)
    unreadable("Editable PDF", "The paired tablet document is unavailable");
  const metadata = await ctx.cloud.readMetadata({
    id: ctx.doc.rmDocId,
    hash: files.hash,
  });
  if (!metadata || metadata.deleted || metadata.parent === "trash")
    unreadable(
      "Editable PDF",
      "The paired tablet document is unavailable or in Trash",
    );
  ctx.guard();
  return files;
}

async function readSamePath(ctx: EditableContext, path: string) {
  ctx.guard();
  if ((await ctx.att.getFilePathAsync()) !== path)
    unreadable("Editable PDF", "The attachment path changed");
  ctx.guard();
  return new Uint8Array(await IOUtils.read(path));
}

/** Finish one durable transaction. A lost tablet response is detected by the staged page hashes. */
async function commit(
  ctx: EditableContext,
  path: string,
  plan: MarkTransaction,
) {
  const { doc, store, guard } = ctx;
  const edit = doc.editable!;
  const stage = store.editableStage(plan.id);
  const whole = plan.wholePdf;
  if (whole) {
    if (whole.beforePath !== path)
      unreadable(
        "Editable PDF",
        "The attachment path changed during PDF replacement. Restore its original path before retrying.",
      );
    await verifyPdfRecovery(stage, whole.backupManifest);
  }
  const before = await getFiles(ctx);
  if (!whole) verifyMapping(before, plan.pageIds);
  const tabletHash = tabletPdfHash(before, doc.rmDocId);
  const mapHash = plan.beforeContentHash
    ? await contentHash(before)
    : undefined;
  const pageHashes = new Map(
    await Promise.all(
      Object.keys(plan.observedPages).map(
        async (id) => [id, await hashPage(before.rm.get(id))] as const,
      ),
    ),
  );
  const hasRemote = plan.pages.length > 0 || plan.tabletPdfHash !== undefined;
  const committed =
    hasRemote &&
    tabletHash === (plan.tabletPdfHash ?? plan.beforeTabletPdf) &&
    (!plan.afterContentHash || mapHash === plan.afterContentHash) &&
    !whole?.retiredPages.some((id) => before.rm.has(id)) &&
    plan.pages.every((page) => page.hash === pageHashes.get(page.id));
  const ready =
    tabletHash === plan.beforeTabletPdf &&
    mapHash === plan.beforeContentHash &&
    (!whole || before.hash === whole.beforeDocument) &&
    Object.entries(plan.observedPages).every(
      ([id, hash]) => pageHashes.get(id) === hash,
    );
  if (plan.tabletContent !== undefined) {
    const after = { ...before, content: plan.tabletContent };
    if ((await contentHash(after)) !== plan.afterContentHash)
      throw new Error("The staged tablet page map failed verification");
    verifyMapping(after, plan.pageIds);
  }
  const local = await readSamePath(ctx, path);
  let localHash = await sha256Hex(local);
  const localMoved =
    localHash !== plan.beforePdf && localHash !== plan.afterPdf;
  const retry = doc.reviews?.document?.decision === "Retry";
  if (localMoved && !retry)
    unreadable(
      "Editable PDF",
      "The PDF changed while a sync was pending. Retry to compare both versions.",
    );
  if (!committed && (!ready || localMoved)) {
    if (doc.reviews?.document?.decision !== "Retry")
      unreadable(
        "Editable PDF",
        "The tablet changed during the pending sync. Retry to compare the latest versions.",
      );
    if (!localMoved && localHash !== plan.beforePdf) {
      const saved = new Uint8Array(await IOUtils.read(`${stage}.before.pdf`));
      if ((await sha256Hex(saved)) !== plan.beforePdf)
        throw new Error("PDF recovery snapshot failed verification");
      await atomicReplace(ctx, path, localHash, saved, plan.id);
    }
    edit.pending = undefined;
    forgetReview(doc, { location: "Editable PDF" });
    await store.save();
    await cleanStage(stage, plan);
    return { changed: false, retry: true };
  }

  if (!localMoved && localHash !== plan.afterPdf) {
    const staged = new Uint8Array(await IOUtils.read(`${stage}.after.pdf`));
    if ((await sha256Hex(staged)) !== plan.afterPdf)
      throw new Error("Staged PDF failed verification");
    await atomicReplace(ctx, path, localHash, staged, plan.id);
    localHash = await sha256Hex(await readSamePath(ctx, path));
    if (localHash !== plan.afterPdf)
      unreadable("Editable PDF", "The replacement PDF could not be verified");
  }
  if (hasRemote && !committed) {
    const pages = new Map<string, Uint8Array>();
    for (const [i, page] of plan.pages.entries()) {
      const bytes = new Uint8Array(await IOUtils.read(`${stage}.${i}.rm`));
      if ((await sha256Hex(bytes)) !== page.hash)
        throw new Error("Staged tablet page failed verification");
      pages.set(page.id, bytes);
    }
    const pdf = plan.tabletPdfHash
      ? new Uint8Array(await IOUtils.read(`${stage}.tablet.pdf`))
      : undefined;
    if (pdf && (await sha256Hex(pdf)) !== plan.tabletPdfHash)
      throw new Error("Staged tablet PDF failed verification");
    if ((await sha256Hex(await readSamePath(ctx, path))) !== plan.afterPdf)
      unreadable(
        "Editable PDF",
        "The PDF editor saved another version during sync",
      );
    guard();
    await ctx.cloud.updateDocument(
      doc.rmDocId,
      {
        pages,
        pdf,
        content: plan.tabletContent,
        removePages: whole?.retiredPages,
      },
      {
        expectedHash: before.hash,
        beforeCommit: guard,
      },
    );
  }
  const latest = await getFiles(ctx);
  verifyMapping(latest, plan.pageIds);
  if (
    (!hasRemote && whole && latest.hash !== whole.beforeDocument) ||
    whole?.retiredPages.some((id) => latest.rm.has(id))
  )
    unreadable(
      "Editable PDF",
      "The replacement tablet pages could not be verified",
    );
  if (
    plan.tabletPdfHash &&
    tabletPdfHash(latest, doc.rmDocId) !== plan.tabletPdfHash
  )
    unreadable("Editable PDF", "The uploaded tablet PDF could not be verified");
  for (const page of plan.pages) {
    if ((await hashPage(latest.rm.get(page.id))) !== page.hash)
      unreadable(
        "Editable PDF",
        "An uploaded tablet page changed before verification",
      );
  }
  if (
    plan.afterContentHash &&
    (await contentHash(latest)) !== plan.afterContentHash
  )
    unreadable(
      "Editable PDF",
      "The uploaded tablet page map could not be verified",
    );
  if (
    !hasRemote &&
    (tabletPdfHash(latest, doc.rmDocId) !== plan.beforeTabletPdf ||
      (
        await Promise.all(
          Object.entries(plan.observedPages).map(
            async ([id, hash]) => (await hashPage(latest.rm.get(id))) === hash,
          ),
        )
      ).some((matches) => !matches))
  )
    unreadable(
      "Editable PDF",
      "The tablet changed before sync could be verified",
    );
  if (
    (await sha256Hex(await readSamePath(ctx, path))) !==
    (localMoved ? localHash : plan.afterPdf)
  )
    unreadable("Editable PDF", "The PDF changed before sync could be verified");
  guard();
  const wholeUpload = whole ? ctx.wholeUploadFingerprint(plan.base) : undefined;
  if (whole) {
    const obsolete = new Set([...(edit.pageIds ?? []), ...whole.retiredPages]);
    for (const page of plan.pageIds) obsolete.delete(page);
    const detached: string[] = [];
    for (const [key, record] of Object.entries(doc.imported)) {
      if (!obsolete.has(key.split("/")[0])) continue;
      detached.push(record.zoteroKey);
      delete doc.imported[key];
    }
    store.addDetached(doc.libraryID, doc.attachmentKey, detached);
    doc.originalPageCount = plan.pageIds.length;
    doc.appendedPageCount = whole.appendedPageCount;
    doc.pageBoxes = whole.pageBoxes;
    edit.uploadBase = undefined;
    edit.restore = undefined;
    edit.lastPdfRecovery = plan.id;
  } else if (edit.base && edit.base !== plan.base)
    edit.uploadBase ??= edit.base;
  edit.base = plan.base;
  edit.baseVersion = plan.baseVersion;
  edit.pageIds = plan.pageIds;
  edit.links = plan.links;
  edit.erased = plan.erased;
  if (plan.restoreApplied) edit.restore = undefined;
  if (plan.beforePdf !== plan.afterPdf) edit.refreshAnnotations = true;
  edit.pending = undefined;
  doc.sourcePdfHash = plan.afterPdf;
  if (plan.tabletPdfHash || whole)
    doc.tabletPdfHash = plan.tabletPdfHash ?? plan.beforeTabletPdf;
  if (wholeUpload) doc.uploadedFingerprint = wholeUpload;
  for (const id of plan.resolved) if (doc.reviews) delete doc.reviews[id];
  if (
    doc.reviews?.document?.location === "Editable PDF" ||
    doc.reviews?.document?.location === PDF_PAGE_LAYOUT_REVIEW
  )
    delete doc.reviews.document;
  await store.save();
  await cleanStage(stage, plan);
  return {
    changed: hasRemote || plan.beforePdf !== plan.afterPdf,
    retry: localMoved,
    recovery: whole ? pdfRecoveryFolder(stage) : undefined,
  };
}

async function atomicReplace(
  ctx: EditableContext,
  path: string,
  expected: string,
  bytes: Uint8Array,
  id: string,
) {
  if ((await sha256Hex(await readSamePath(ctx, path))) !== expected)
    unreadable(
      "Editable PDF",
      "The PDF was changed by another editor before replacement",
    );
  ctx.guard();
  try {
    await IOUtils.write(path, bytes, {
      tmpPath: `${path}.${id}.tmp`,
      flush: true,
    });
  } catch {
    unreadable(
      "Editable PDF",
      "The original PDF could not be updated. Close it in your PDF editor and choose Retry.",
    );
  }
}

async function cleanStage(stage: string, plan: MarkTransaction) {
  const names = [
    ".before.pdf",
    ".after.pdf",
    ".tablet.pdf",
    ...plan.pages.map((_, i) => `.${i}.rm`),
  ];
  for (const suffix of names) {
    try {
      await IOUtils.remove(stage + suffix, { ignoreAbsent: true });
    } catch (error) {
      Zotero.logError(error as Error);
    }
  }
}

export async function syncEditable(
  ctx: EditableContext,
  local: LocalFile,
  entry?: IndexEntry,
) {
  const { doc, store, guard } = ctx;
  const edit = doc.editable!;
  if (edit.pending) {
    const result = await commit(ctx, local.path, edit.pending);
    return { ...result, resumed: true };
  }
  let pdf: Awaited<ReturnType<typeof openEmbeddedPdf>>;
  try {
    pdf = await openEmbeddedPdf(local.bytes);
  } catch (error) {
    unreadable("Editable PDF", (error as Error).message);
  }

  const files = await getFiles(ctx, entry);
  const currentTabletPdf = tabletPdfHash(files, doc.rmDocId);
  if (!currentTabletPdf)
    unreadable("Editable PDF", "The tablet PDF is missing");
  let pageIds: string[];
  try {
    if (pdf.boxes.length !== doc.originalPageCount)
      verifyPageLayout(
        local,
        "The PDF page count changed. Restore the original page layout before retrying.",
      );
    if (doc.tabletPdfHash && doc.tabletPdfHash !== currentTabletPdf)
      verifyPageLayout(local, "The tablet PDF changed outside the pairing.");
    try {
      pageIds = mappedPages(files, pdf.boxes.length);
    } catch (error) {
      if (!(error instanceof ReviewNeeded)) throw error;
      verifyPageLayout(local, error.review.reason);
    }
    if (
      edit.pageIds &&
      pageIds.some((id, index) => edit.pageIds?.[index] !== id)
    )
      verifyPageLayout(
        local,
        "The tablet and original PDF no longer have a verified one-to-one page map.",
      );
    await verifyBaseline(ctx, local, pdf, currentTabletPdf);
  } catch (error) {
    if (
      !(error instanceof ReviewNeeded) ||
      error.review.location !== PDF_PAGE_LAYOUT_REVIEW
    )
      throw error;
    return reviewWholePdf(ctx, local, pdf, files, currentTabletPdf, error);
  }
  const pageMarks = new Map<number, Map<string, EditableMark>>();
  const pageScenes = new Map<
    number,
    { wasDeleted: RmPage["wasDeleted"]; layers: Map<string, string> }
  >();
  for (const [page, id] of pageIds.entries()) {
    try {
      const bytes = files.rm.get(id);
      const scene = bytes ? parseRm(bytes) : undefined;
      if (
        scene &&
        edit.links.some(
          (link) =>
            link.tablet.page === page &&
            link.native.some((key) => scene.hiddenItems?.includes(key)),
        )
      )
        throw new Error("A paired tablet annotation is in a hidden layer");
      pageMarks.set(
        page,
        scene ? tabletMarks(scene, page, pdf.boxes[page]) : new Map(),
      );
      if (scene)
        pageScenes.set(page, {
          wasDeleted: scene.wasDeleted,
          layers: sceneLayers(scene),
        });
      const previous =
        doc.reviews?.[reviewId({ location: where(page), pageId: id })];
      if (previous?.decision === "Retry") forgetReview(doc, previous);
    } catch (error) {
      rememberReview(doc, {
        location: where(page),
        pageId: id,
        reason: (error as Error).message,
        choices: ["Retry"],
        revision: files.hash,
      });
    }
  }

  const candidates: Candidate[] = [];
  const usedPdf = new Set<string>();
  const usedTablet = new Set<string>();
  const links = new Map(edit.links.map((link) => [link.id, link]));
  const erased = [...edit.erased];
  for (const previous of edit.links) {
    const page = previous.tablet.page;
    const native = pageMarks.get(page);
    if (!native) continue;
    const ids = previous.native.filter((id) => native.has(id));
    for (const id of ids) usedTablet.add(legacyId(page, id));
    const existing = pdf.marks.get(previous.id)?.mark;
    if (existing) usedPdf.add(previous.id);
    const downloaded = pageScenes.get(page);
    const missing = previous.native.length - ids.length;
    if (
      missing &&
      previous.native.some(
        (id, i) =>
          !native.has(id) &&
          (!downloaded ||
            downloaded.layers.has(id) ||
            !downloaded.wasDeleted?.(id, previous.nativeLayers?.[i])),
      )
    ) {
      rememberReview(doc, {
        location: where(page),
        pageId: pageIds[page],
        reason:
          "The tablet no longer shows a paired stroke, but its erasure could not be verified. Both copies were kept.",
        choices: ["Retry"],
        revision: files.hash,
      });
      continue;
    }
    const tablet = combineTabletMarks(ids.map((id) => native.get(id)!));
    // Some editors drop /NM. An unnamed replacement on this page could be
    // an edit, so absence of the old /NM is insufficient proof of erasure.
    if (
      !existing &&
      [...pdf.marks.values()].some(
        (item) => !item.id && item.mark.page === previous.pdf.page,
      )
    ) {
      rememberReview(doc, {
        location: where(page),
        pageId: pageIds[page],
        choices: ["Retry"],
        reason:
          "The PDF editor removed annotation IDs. Save with annotation identities preserved before retrying.",
        revision: local.hash,
      });
      continue;
    }
    const change = compareMark(previous, existing, tablet);
    const tabletVersion = tablet && {
      ...tablet,
      comment: existing?.comment ?? previous.pdf.comment,
      author: existing?.author ?? previous.pdf.author,
    };
    let desired = change === "tablet" ? tabletVersion : existing;
    let keepTablet =
      change === "tablet" ||
      change === "same" ||
      (!!tablet &&
        markSignature(existing, false) === markSignature(previous.pdf, false));
    let resolved: string | undefined;
    const target = {
      location: `${where(page)} · ${previous.id}`,
      pageId: pageIds[page],
    };
    if (change === "conflict") {
      const review = {
        ...target,
        reason: "Both sides changed this embedded mark",
        tablet: tablet ? JSON.stringify(tablet) : "Erased on tablet",
        zotero: existing ? JSON.stringify(existing) : "Erased in PDF",
        revision: fingerprint([
          markSignature(existing),
          markSignature(tablet),
          pageIds[page],
        ]),
        choices: ["Keep both", "Use tablet version", "Use Zotero version"] as (
          | "Keep both"
          | "Use tablet version"
          | "Use Zotero version"
        )[],
      };
      const choice = pageDecision(doc, review);
      if (!choice) continue;
      resolved = reviewId(review);
      keepTablet =
        choice === "Use tablet version" ||
        (choice === "Keep both" && !existing);
      desired = keepTablet ? tabletVersion : existing;
      if (choice === "Keep both" && existing && tablet) {
        candidates.push({
          id: uuid4(),
          native: ids,
          tablet,
          desired: tablet,
          keepTablet: true,
          resolved,
        });
        candidates.push({
          id: previous.id,
          previous,
          pdf: existing,
          native: [],
          desired: existing,
          resolved,
        });
        continue;
      }
    } else if (doc.reviews?.[reviewId(target)]) {
      const prior = doc.reviews[reviewId(target)];
      if (prior.decision !== "Retry") {
        rememberReview(doc, {
          ...target,
          reason:
            "The versions changed since review. Retry to compare them again.",
          revision: local.hash,
          choices: ["Retry"],
        });
        continue;
      }
      resolved = reviewId(target);
    }
    candidates.push({
      id: previous.id,
      previous,
      pdf: existing,
      tablet,
      native: ids,
      desired,
      keepTablet,
      resolved,
      partialErasure:
        missing > 0 && tablet
          ? {
              ...previous.pdf,
              paths:
                previous.pdf.kind === "ink" &&
                previous.pdf.paths.length === previous.native.length
                  ? previous.pdf.paths.filter(
                      (_, i) => !native.has(previous.native[i]),
                    )
                  : previous.pdf.paths,
            }
          : undefined,
    });
  }

  // Existing PDF marks and freshly drawn tablet marks can be adopted once.
  for (const [id, entry] of pdf.marks) {
    if (usedPdf.has(id)) continue;
    const page = entry.mark.page;
    const native = pageMarks.get(page);
    if (!native) continue;
    const matches = [...native].filter(
      ([key, mark]) =>
        !usedTablet.has(legacyId(page, key)) && samePaths(mark, entry.mark),
    );
    const identical = [...pdf.marks.values()].filter((mark) =>
      samePaths(mark.mark, entry.mark),
    );
    if (matches.length > 1 || (matches.length && identical.length !== 1)) {
      rememberReview(doc, {
        location: where(page),
        pageId: pageIds[page],
        choices: ["Retry"],
        reason:
          "Identical annotations could not be paired uniquely. Separate them before retrying.",
        revision: local.hash,
      });
      continue;
    }
    const match = matches[0];
    if (match) usedTablet.add(legacyId(page, match[0]));
    candidates.push({
      id,
      pdf: entry.mark,
      tablet: match?.[1],
      native: match ? [match[0]] : [],
      desired: entry.mark,
      keepTablet: !!match,
    });
  }
  for (const [page, marks] of pageMarks) {
    for (const [key, mark] of marks)
      if (!usedTablet.has(legacyId(page, key))) {
        candidates.push({
          id: uuid4(),
          tablet: mark,
          native: [key],
          desired: mark,
          keepTablet: true,
        });
      }
  }
  if (!edit.base) {
    for (const mark of ctx.seed()) {
      if (
        candidates.some(
          (candidate) =>
            candidate.desired && samePaths(candidate.desired, mark),
        )
      )
        continue;
      candidates.push({ id: uuid4(), native: [], desired: mark });
    }
  }
  if (edit.restore)
    candidates.push({ id: uuid4(), native: [], desired: edit.restore });

  const active = candidates.filter((candidate) => {
    const a = candidate.previous?.tablet.page ?? candidate.desired?.page;
    const b = candidate.desired?.page ?? a;
    return (
      a !== undefined &&
      b !== undefined &&
      pageMarks.has(a) &&
      pageMarks.has(b) &&
      (candidate.resolved ||
        (!blocked(doc, pageIds[a]) && !blocked(doc, pageIds[b])))
    );
  });
  const initialized = edit.base !== undefined;
  // On adoption, the clean tablet PDF and its native overlays land together.
  if (!initialized && pageIds.some((id) => blocked(doc, id)))
    return { changed: false, retry: false, resumed: false };

  const pdfChanges = new Map<string, EditableMark | undefined>();
  const eraseNative = new Map<number, string[]>();
  const addNative = new Map<number, Candidate[]>();
  const resolved: string[] = [];
  for (const c of active) {
    if (c.resolved) resolved.push(c.resolved);
    if (
      markSignature(c.desired) !== markSignature(c.pdf) ||
      (c.desired && pdf.marks.get(c.id)?.id === undefined)
    )
      pdfChanges.set(c.id, c.desired);
    if (!c.keepTablet && c.native.length && c.tablet) {
      const out = eraseNative.get(c.tablet.page) ?? [];
      out.push(...c.native);
      eraseNative.set(c.tablet.page, out);
      c.native = [];
    }
    if (!c.desired) {
      if (c.previous) erased.push(c.previous.pdf);
      links.delete(c.id);
    } else if (!c.keepTablet || !c.tablet) {
      const out = addNative.get(c.desired.page) ?? [];
      out.push(c);
      addNative.set(c.desired.page, out);
    } else {
      if (c.partialErasure) erased.push(c.partialErasure);
      links.set(
        c.id,
        tabletLink(c, c.tablet, pageScenes.get(c.tablet.page)!.layers),
      );
    }
  }

  const tabletPages = new Map<string, Uint8Array>();
  for (const page of new Set([...eraseNative.keys(), ...addNative.keys()])) {
    const id = pageIds[page];
    const adds = addNative.get(page) ?? [];
    const groups = adds.map((candidate) =>
      toSceneMark(candidate.desired!, pdf.boxes[page]),
    );
    const patched = writePageMarks(
      files.rm.get(id),
      eraseNative.get(page) ?? [],
      groups.flat(),
      { authorUuid: ctx.authorUuid },
    );
    const scene = parseRm(patched.bytes);
    const verified = tabletMarks(scene, page, pdf.boxes[page]);
    const layers = sceneLayers(scene);
    let offset = 0;
    for (const [i, candidate] of adds.entries()) {
      const native = patched.ids.slice(offset, offset + groups[i].length);
      offset += native.length;
      const tablet = combineTabletMarks(
        native.map((key) => verified.get(key)!),
      );
      if (!tablet || native.some((key) => !verified.has(key)))
        throw new Error("The tablet projection could not be verified");
      candidate.native = native;
      links.set(candidate.id, tabletLink(candidate, tablet, layers));
    }
    tabletPages.set(id, patched.bytes);
  }

  const clean = initialized ? undefined : await ctx.cleanTabletPdf(files);
  const reconciled = clean
    ? reconcileContent(
        files.content,
        doc.originalPageCount + doc.appendedPageCount,
        clean.length,
        uuid4,
        ctx.authorUuid,
      )
    : undefined;
  const rewritten = pdfChanges.size
    ? await patchEmbeddedPdf(pdf, pdfChanges)
    : local.bytes;
  if (pdfChanges.size) {
    const verified = await openEmbeddedPdf(rewritten);
    if (
      verified.base !== pdf.base ||
      [...pdfChanges].some(
        ([id, mark]) =>
          markSignature(mark) !== markSignature(verified.marks.get(id)?.mark),
      )
    )
      throw new Error("The staged PDF failed annotation verification");
  }

  if (
    !pdfChanges.size &&
    !tabletPages.size &&
    !clean &&
    JSON.stringify([...links.values()]) === JSON.stringify(edit.links) &&
    !resolved.length
  ) {
    guard();
    if (edit.baseVersion !== PAGE_BASE_VERSION) {
      if ((await sha256Hex(await readSamePath(ctx, local.path))) !== local.hash)
        unreadable(
          "Editable PDF",
          "The PDF changed while verifying the page layout",
        );
      guard();
      if (edit.base && edit.base !== pdf.base) edit.uploadBase ??= edit.base;
      edit.base = pdf.base;
      edit.baseVersion = PAGE_BASE_VERSION;
    }
    edit.links = [...links.values()];
    edit.erased = erased;
    for (const id of resolved) if (doc.reviews) delete doc.reviews[id];
    if (
      (doc.reviews?.document?.location === "Editable PDF" ||
        doc.reviews?.document?.location === PDF_PAGE_LAYOUT_REVIEW) &&
      doc.reviews.document.decision
    )
      delete doc.reviews.document;
    doc.sourcePdfHash = local.hash;
    await store.save();
    return { changed: false, retry: false, resumed: false };
  }
  const afterPdf = await sha256Hex(rewritten);
  const restoreApplied =
    !!edit.restore &&
    active.some((candidate) => candidate.desired === edit.restore);
  if (restoreApplied) erased.splice(edit.erased.length - 1, 1);
  const plan: MarkTransaction = {
    id: uuid4(),
    beforePdf: local.hash,
    afterPdf,
    beforeTabletPdf: currentTabletPdf,
    observedPages: Object.fromEntries(
      await Promise.all(
        pageIds.map(async (id) => [id, await hashPage(files.rm.get(id))]),
      ),
    ),
    pages: await Promise.all(
      [...tabletPages].map(async ([id, bytes]) => ({
        id,
        hash: await sha256Hex(bytes),
        before: await hashPage(files.rm.get(id)),
      })),
    ),
    tabletPdfHash: clean ? await sha256Hex(clean) : undefined,
    beforeContentHash: reconciled ? await contentHash(files) : undefined,
    afterContentHash: reconciled
      ? await sha256Hex(new TextEncoder().encode(JSON.stringify(reconciled)))
      : undefined,
    tabletContent: reconciled,
    base: pdf.base,
    baseVersion: PAGE_BASE_VERSION,
    pageIds,
    links: [...links.values()],
    erased,
    resolved,
    restoreApplied,
  };
  return stageAndCommit(ctx, local, plan, rewritten, tabletPages, clean);
}

async function stageAndCommit(
  ctx: EditableContext,
  local: LocalFile,
  plan: MarkTransaction,
  rewritten: Uint8Array,
  tabletPages: Map<string, Uint8Array>,
  clean?: Uint8Array,
) {
  const { doc, store, guard } = ctx;
  const stage = store.editableStage(plan.id);
  guard();
  if (plan.afterPdf !== local.hash) {
    await IOUtils.write(`${stage}.before.pdf`, local.bytes, { flush: true });
    await IOUtils.write(`${stage}.after.pdf`, rewritten, { flush: true });
  }
  for (const [i, page] of plan.pages.entries()) {
    guard();
    await IOUtils.write(`${stage}.${i}.rm`, tabletPages.get(page.id)!, {
      flush: true,
    });
  }
  if (clean) await IOUtils.write(`${stage}.tablet.pdf`, clean, { flush: true });
  guard();
  doc.editable!.pending = plan;
  await store.save();
  return { ...(await commit(ctx, local.path, plan)), resumed: false };
}
