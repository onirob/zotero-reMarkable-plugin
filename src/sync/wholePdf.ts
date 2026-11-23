import { PDFDocument } from "pdf-lib";
import type { RemarkableCloud } from "../remarkable/cloud";
import { pageRefs, replacePdfPages } from "../remarkable/content";
import { sha256Hex, uuid4 } from "../remarkable/hash";
import { parseRm } from "../remarkable/rmscene";
import { writePageMarks } from "../remarkable/rmwrite";
import {
  markSignature,
  PAGE_BASE_VERSION,
  type EditableMark,
  type MarkLink,
} from "./editableMarks";
import {
  EDITABLE_PDF_LIMIT,
  type EmbeddedPdf,
  openEmbeddedPdf,
  patchEmbeddedPdf,
  pdfWithoutSyncedMarks,
  referencePageFingerprint,
} from "./embeddedPdf";
import type { DocState } from "./state";
import { combineTabletMarks, tabletMarks, toSceneMark } from "./tabletMarks";

type Snapshot = NonNullable<
  Awaited<ReturnType<RemarkableCloud["getDocumentFiles"]>>
>;
type TabletPdf = {
  raw: Uint8Array;
  pdf: EmbeddedPdf;
  pageIds: string[];
  ordered: boolean;
};
type PdfVersion = {
  bytes: Uint8Array;
  verified: EmbeddedPdf;
  links: MarkLink[];
};

export async function inspectTabletPdf(
  cloud: RemarkableCloud,
  doc: DocState,
  files: Snapshot,
  guard: () => void,
): Promise<TabletPdf> {
  const blob = files.files.find((file) => file.id === `${doc.rmDocId}.pdf`);
  if (!blob) throw new Error("The tablet PDF is missing");
  if (doc.appendedPageCount && blob.hash !== doc.tabletPdfHash)
    throw new Error(
      "The tablet’s appended notes pages can no longer be identified",
    );
  guard();
  const raw = await cloud.getBlob(blob.hash, blob.id, EDITABLE_PDF_LIMIT);
  guard();
  const pdf = await openEmbeddedPdf(raw);
  const refs = pageRefs(files.content).filter(
    (ref) => ref.pdfIndex !== undefined,
  );
  const byPdfIndex = [...refs].sort((a, b) => a.pdfIndex! - b.pdfIndex!);
  if (
    refs.length !== pdf.boxes.length ||
    byPdfIndex.some((ref, i) => ref.pdfIndex !== i) ||
    refs.length <= doc.appendedPageCount
  )
    throw new Error(
      "This tablet PDF needs a complete page map for replacement",
    );
  const originalCount = refs.length - doc.appendedPageCount;
  return {
    raw,
    pdf,
    pageIds: byPdfIndex.slice(0, originalCount).map((ref) => ref.id),
    ordered: refs.every((ref, i) => ref.pdfIndex === i),
  };
}

/** Render a recoverable editable PDF from the tablet’s ordinary portable marks. */
export async function tabletVersion(
  tablet: TabletPdf,
  files: Snapshot,
): Promise<PdfVersion> {
  if (!tablet.ordered)
    throw new Error(
      "The tablet’s PDF pages are reordered. Restore their PDF order to use this version.",
    );
  const source = await openEmbeddedPdf(tablet.raw);
  if (source.marks.size)
    throw new Error(
      "The tablet PDF itself contains embedded ink or highlights",
    );
  while (source.doc.getPageCount() > tablet.pageIds.length)
    source.doc.removePage(source.doc.getPageCount() - 1);
  const updates = new Map<string, EditableMark>();
  const links: MarkLink[] = [];
  for (const [page, pageId] of tablet.pageIds.entries()) {
    const bytes = files.rm.get(pageId);
    if (!bytes) continue;
    const scene = parseRm(bytes);
    const layers = new Map(
      [...scene.lines, ...scene.glyphs].map((mark) => [mark.id, mark.parent]),
    );
    for (const [native, mark] of tabletMarks(scene, page, source.boxes[page])) {
      const id = uuid4();
      updates.set(id, mark);
      links.push({
        id,
        pdf: mark,
        tablet: mark,
        native: [native],
        nativeLayers: [layers.get(native)!],
      });
    }
  }
  const bytes = await patchEmbeddedPdf(source, updates);
  const verified = await openEmbeddedPdf(bytes);
  const reference = await referencePageFingerprint(
    tablet.raw,
    tablet.pageIds.length,
    tablet.pdf.boxes.length - tablet.pageIds.length,
  );
  if (verified.base !== (await reference(PAGE_BASE_VERSION)))
    throw new Error(
      "Replacing the Zotero PDF would change the tablet’s page layout",
    );
  for (const [id, mark] of updates)
    if (markSignature(verified.marks.get(id)?.mark) !== markSignature(mark))
      throw new Error(
        "The tablet annotations could not be verified in the replacement PDF",
      );
  return { bytes, verified, links };
}

export async function zoteroVersion(
  bytes: Uint8Array,
  local: EmbeddedPdf,
  tablet: TabletPdf,
  files: Snapshot,
  doc: DocState,
  authorUuid: string,
): Promise<
  PdfVersion & {
    tabletBytes: Uint8Array;
    content: unknown;
    pageIds: string[];
    pages: Map<string, Uint8Array>;
  }
> {
  // Name only previously unnamed marks. Their bytes remain editable in Zotero.
  const unnamed = new Map(
    [...local.marks.entries()]
      .filter(([, item]) => !item.id)
      .map(([id, item]) => [id, item.mark]),
  );
  const normalized = unnamed.size
    ? await patchEmbeddedPdf(local, unnamed)
    : bytes;
  const verified = await openEmbeddedPdf(normalized);
  if (
    verified.base !== local.base ||
    [...local.marks].some(
      ([id, item]) =>
        markSignature(verified.marks.get(id)?.mark) !==
        markSignature(item.mark),
    )
  )
    throw new Error(
      "The Zotero annotations could not be verified for replacement",
    );
  const clean = await pdfWithoutSyncedMarks(normalized);
  let tabletBytes = clean;
  if (doc.appendedPageCount) {
    const combined = await PDFDocument.load(clean, { updateMetadata: false });
    const appendix = Array.from(
      { length: doc.appendedPageCount },
      (_, i) => tablet.pageIds.length + i,
    );
    for (const page of await combined.copyPages(tablet.pdf.doc, appendix))
      combined.addPage(page);
    tabletBytes = await combined.save({ useObjectStreams: false });
  }
  if (tabletBytes.byteLength > EDITABLE_PDF_LIMIT)
    throw new Error("The replacement PDF exceeds the sync size limit");
  const pageIds = verified.boxes.map(() => uuid4());
  const content = replacePdfPages(
    files.content,
    tablet.pdf.boxes.length,
    pageIds,
    doc.appendedPageCount,
    tabletBytes.byteLength,
    authorUuid,
  );
  const pages = new Map<string, Uint8Array>();
  const links: MarkLink[] = [];
  const marksByPage = new Map<number, { id?: string; mark: EditableMark }[]>();
  for (const item of verified.marks.values()) {
    const marks = marksByPage.get(item.mark.page) ?? [];
    marks.push(item);
    marksByPage.set(item.mark.page, marks);
  }
  for (const [page, pageId] of pageIds.entries()) {
    const marks = marksByPage.get(page);
    if (!marks) continue;
    const groups = marks.map(({ mark }) =>
      toSceneMark(mark, verified.boxes[page]),
    );
    const output = writePageMarks(undefined, [], groups.flat(), { authorUuid });
    const scene = parseRm(output.bytes);
    const projected = tabletMarks(scene, page, verified.boxes[page]);
    const layers = new Map(
      [...scene.lines, ...scene.glyphs].map((item) => [item.id, item.parent]),
    );
    let offset = 0;
    for (const [i, item] of marks.entries()) {
      const native = output.ids.slice(offset, offset + groups[i].length);
      offset += native.length;
      const projectedItems = native.map((key) => projected.get(key));
      if (projectedItems.some((mark) => !mark))
        throw new Error("A Zotero mark cannot be represented on the tablet");
      const tabletMark = combineTabletMarks(projectedItems as EditableMark[]);
      if (!tabletMark)
        throw new Error("A Zotero mark could not be verified on the tablet");
      links.push({
        id: item.id!,
        pdf: item.mark,
        tablet: tabletMark,
        native,
        nativeLayers: native.map((id) => layers.get(id)!),
      });
    }
    pages.set(pageId, output.bytes);
  }
  return {
    bytes: normalized,
    verified,
    links,
    tabletBytes,
    content,
    pageIds,
    pages,
  };
}

export function pdfRecoveryFolder(stage: string) {
  return `${stage}.recovery`;
}

const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value, null, 2));

/** These files are retained after the transaction ends or is abandoned. */
export async function savePdfRecovery(
  stage: string,
  doc: DocState,
  local: Uint8Array,
  tablet: TabletPdf,
  files: Snapshot,
  visibleTabletPdf: Uint8Array | undefined,
  guard: () => void,
) {
  const dir = pdfRecoveryFolder(stage);
  await IOUtils.makeDirectory(dir, { ignoreExisting: false });
  const entries: { name: string; hash: string }[] = [];
  const pageFiles: { id: string; name: string }[] = [];
  const write = async (name: string, bytes: Uint8Array) => {
    guard();
    const path = PathUtils.join(dir, name);
    const hash = await sha256Hex(bytes);
    await IOUtils.write(path, bytes, { mode: "create", flush: true });
    entries.push({ name, hash });
  };
  await write("zotero.pdf", local);
  await write("tablet-source.pdf", tablet.raw);
  if (visibleTabletPdf) await write("tablet-annotated.pdf", visibleTabletPdf);
  await write("tablet-content.json", encode(files.content));
  await write("pairing.json", encode(doc));
  for (const [id, bytes] of files.rm) {
    const name = `page-${pageFiles.length}.rm`;
    await write(name, bytes);
    pageFiles.push({ id, name });
  }
  const manifest = encode({
    version: 1,
    document: doc.rmDocId,
    entries,
    pageFiles,
  });
  const hash = await sha256Hex(manifest);
  guard();
  await IOUtils.write(PathUtils.join(dir, "manifest.json"), manifest, {
    mode: "create",
    flush: true,
  });
  await verifyPdfRecovery(stage, hash);
  return hash;
}

export async function verifyPdfRecovery(stage: string, manifestHash: string) {
  const dir = pdfRecoveryFolder(stage);
  const manifest = new Uint8Array(
    await IOUtils.read(PathUtils.join(dir, "manifest.json")),
  );
  if ((await sha256Hex(manifest)) !== manifestHash)
    throw new Error("The PDF recovery manifest could not be verified");
  const { entries } = JSON.parse(new TextDecoder().decode(manifest)) as {
    entries: { name: string; hash: string }[];
  };
  for (const { name, hash } of entries) {
    if (
      !/^(zotero\.pdf|tablet-(source|annotated)\.pdf|tablet-content\.json|pairing\.json|page-\d+\.rm)$/.test(
        name,
      ) ||
      (await sha256Hex(
        new Uint8Array(await IOUtils.read(PathUtils.join(dir, name))),
      )) !== hash
    )
      throw new Error("A PDF recovery file could not be verified");
  }
}
