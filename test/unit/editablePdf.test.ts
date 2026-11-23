import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { deflateSync, inflateSync } from "node:zlib";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFString,
} from "pdf-lib";
import type { RemarkableCloud } from "../../src/remarkable/cloud";
import { pageRefs } from "../../src/remarkable/content";
import { sha256Hex, uuid4 } from "../../src/remarkable/hash";
import { parseRm, sceneItemEnvelope } from "../../src/remarkable/rmscene";
import { writePageMarks } from "../../src/remarkable/rmwrite";
import {
  type EditableMark,
  markSignature,
  PAGE_BASE_VERSION,
} from "../../src/sync/editableMarks";
import { openEmbeddedPdf, patchEmbeddedPdf } from "../../src/sync/embeddedPdf";
import { fingerprint } from "../../src/sync/convert";
import { SyncEngine } from "../../src/sync/engine";
import {
  PDF_PAGE_LAYOUT_REVIEW,
  rememberReview,
  reviewId,
} from "../../src/sync/review";
import { toSceneMark, tabletMarks } from "../../src/sync/tabletMarks";
import { localSnapshot } from "../../src/sync/zotero";
import {
  fakeAttachment,
  installGlobals,
  makePdf,
  makeState,
  memoryIO,
} from "./engineHarness";

const PATH = "/library/paper.pdf";
const AUTHOR = "a7c0b01d-70f6-4e43-9b2b-f58a6a865762";
const DOC = uuid4();
const BOX = { x: 0, y: 0, width: 200, height: 200 };
const ink = (page: number, y = 50): EditableMark => ({
  page,
  kind: "ink",
  color: "#000000",
  width: 2,
  paths: [[10, y, 25, y + 5, 47, y + 1]],
});
const highlight = (page: number, y = 110): EditableMark => ({
  page,
  kind: "highlight",
  color: "#fbf719",
  width: 0,
  paths: [
    [35, y, 70, y + 8],
    [35, y - 14, 65, y - 5],
  ],
});

async function setup(original?: Uint8Array) {
  const z = installGlobals();
  const att = fakeAttachment({
    key: "ATTKEY01",
    path: PATH,
    title: { value: "Paper" },
  });
  const io = memoryIO();
  original ??= await makePdf(3);
  z.files.set(PATH, original);
  const tablet = {
    pages: new Map<string, Uint8Array>(),
    content: { pages: ["p0", "p1", "p2"], pageCount: 3 } as unknown,
    pdf: original,
    serial: 0,
    writes: 0,
    interrupt: "" as "before" | "after" | "",
  };
  const index = () => ({
    id: DOC,
    hash: tablet.serial.toString(16).padStart(64, "0"),
    type: "0",
    subfiles: 1,
    size: tablet.pdf.length,
  });
  const cloud = {
    clearPageCache() {},
    async getRoot() {
      return { hash: "root", generation: tablet.serial, schemaVersion: 4 };
    },
    async getRootEntries() {
      return [index()];
    },
    async findDocument() {
      return index();
    },
    async readMetadata() {
      return { parent: "", visibleName: "Paper", type: "DocumentType" };
    },
    async getBlob(hash: string, name: string) {
      const bytes =
        name === `${DOC}.pdf`
          ? tablet.pdf
          : tablet.pages.get(name.slice(DOC.length + 1, -3));
      assert.ok(bytes);
      assert.equal(hash, await sha256Hex(bytes));
      return bytes;
    },
    async getDocEntries() {
      return [
        { id: `${DOC}.pdf`, hash: await sha256Hex(tablet.pdf) },
        ...(await Promise.all(
          [...tablet.pages].map(async ([pageId, bytes]) => ({
            id: `${DOC}/${pageId}.rm`,
            hash: await sha256Hex(bytes),
          })),
        )),
      ];
    },
    async getDocumentFiles() {
      return {
        hash: index().hash,
        content: tablet.content,
        rm: new Map(tablet.pages),
        files: [{ id: `${DOC}.pdf`, hash: await sha256Hex(tablet.pdf) }],
      };
    },
    async updateDocument(
      id: string,
      update: {
        pages: Map<string, Uint8Array>;
        pdf?: Uint8Array;
        content?: unknown;
        removePages?: string[];
      },
      options: { expectedHash: string; beforeCommit: () => void },
    ) {
      assert.equal(id, DOC);
      assert.equal(options.expectedHash, index().hash);
      options.beforeCommit();
      if (tablet.interrupt === "before")
        throw new Error("interrupted before tablet write");
      if (update.pdf) tablet.pdf = update.pdf;
      if (update.content) tablet.content = update.content;
      for (const key of update.removePages ?? []) tablet.pages.delete(key);
      for (const [key, value] of update.pages) tablet.pages.set(key, value);
      tablet.writes++;
      tablet.serial++;
      if (tablet.interrupt === "after")
        throw new Error("lost response after tablet write");
    },
  } as unknown as RemarkableCloud;
  const disk = { locked: false };
  Object.assign(IOUtils, {
    async makeDirectory() {},
    async write(path: string, data: Uint8Array, options?: { mode?: string }) {
      if (path === PATH && disk.locked) throw new Error("sharing violation");
      if (options?.mode === "create" && z.files.has(path))
        throw new Error("destination already exists");
      z.files.set(path, data.slice());
    },
    async remove(path: string) {
      z.files.delete(path);
    },
  });
  Object.assign(globalThis, {
    PathUtils: { join: (...parts: string[]) => parts.join("/") },
  });
  const boot = async () => {
    const state = makeState(io);
    await state.load();
    const engine = new SyncEngine(
      cloud,
      state,
      () => ({
        folder: "",
        appendNotesPages: false,
        importHandwriting: true,
      }),
      AUTHOR,
      undefined,
      (id) => id === 1,
    );
    const pair = () => state.get(1, att.key)!;
    return { engine, state, pair, sync: () => engine.sync([att]) };
  };
  const first = await boot();
  first.state.set({
    libraryID: 1,
    attachmentKey: att.key,
    rmDocId: DOC,
    rmDocHash: index().hash,
    originalPageCount: 3,
    appendedPageCount: 0,
    pageBoxes: [BOX, BOX, BOX],
    sourcePdfHash: await sha256Hex(original),
    tabletPdfHash: await sha256Hex(tablet.pdf),
    imported: {},
  });
  await first.state.save();
  const editPdf = async (id: string, mark?: EditableMark) => {
    const pdf = await openEmbeddedPdf(z.files.get(PATH)!);
    z.files.set(PATH, await patchEmbeddedPdf(pdf, new Map([[id, mark]])));
  };
  const readPdf = () => openEmbeddedPdf(z.files.get(PATH)!);
  const editTablet = (page: number, erase: string[], mark?: EditableMark) => {
    const id = `p${page}`;
    const output = writePageMarks(
      tablet.pages.get(id),
      erase,
      mark ? toSceneMark(mark, BOX) : [],
      { authorUuid: AUTHOR },
    );
    tablet.pages.set(id, output.bytes);
    tablet.serial++;
    return output.ids;
  };
  const readTablet = (page: number) => {
    const bytes = tablet.pages.get(`p${page}`);
    return bytes ? tabletMarks(parseRm(bytes), page, BOX) : new Map();
  };
  return {
    ...first,
    att,
    tablet,
    disk,
    boot,
    editPdf,
    readPdf,
    editTablet,
    readTablet,
    files: z.files,
  };
}

function groupTabletErasures(
  bytes: Uint8Array,
  ids: string[],
  count = ids.length,
) {
  // Model the device compacting consecutive delete markers into one range.
  const [author, first] = ids[0].split(":").map(Number);
  assert.ok(ids.every((id, i) => id === `${author}:${first + i}`));
  const erased = Buffer.from(
    writePageMarks(bytes, ids, [], { authorUuid: AUTHOR }).bytes,
  );
  const chunks = [erased.subarray(0, 43)];
  for (let start = 43; start < erased.length; ) {
    const end = start + 8 + erased.readUInt32LE(start);
    if (erased[start + 7] === 8) {
      const { id } = sceneItemEnvelope(erased.subarray(start + 8, end));
      if (id === ids[0]) {
        assert.equal(erased[end - 5], 0x54);
        erased.writeUInt32LE(count, end - 4);
      } else if (ids.includes(id)) {
        start = end;
        continue;
      }
    }
    chunks.push(erased.subarray(start, end));
    start = end;
  }
  return Buffer.concat(chunks);
}

async function handwrittenWord() {
  const f = await setup();
  const initial = writePageMarks(
    undefined,
    [],
    [45, 63, 80].flatMap((y) => toSceneMark(ink(0, y), BOX)),
    { authorUuid: AUTHOR },
  );
  f.tablet.pages.set("p0", initial.bytes);
  f.tablet.serial++;
  await f.engine.editableMode(f.att);
  assert.deepEqual((await f.sync()).errors, []);
  const paperCircle = { ...ink(0, 110), color: "#fff400" };
  await f.editPdf("circle", paperCircle);
  assert.deepEqual((await f.sync()).errors, []);
  return { ...f, word: initial.ids, paperCircle };
}

test("real tablet fixture reports compacted stroke deletions and single-item tombstones", async () => {
  const bytes = await readFile(
    new URL(
      "../fixtures/More_color_highlight_shader_v3.15.4.2.rm",
      import.meta.url,
    ),
  );
  const scene = parseRm(bytes);
  assert.ok(scene.wasDeleted?.("1:14", "0:11"));
  assert.ok(scene.wasDeleted?.("1:236", "0:11"));
  assert.ok(scene.wasDeleted?.("1:240", "0:11"));
  assert.equal(scene.wasDeleted?.("1:237", "0:11"), false);
  assert.equal(scene.wasDeleted?.("1:240", "0:12"), false);
  assert.equal(scene.wasDeleted?.("2:240", "0:11"), false);
  assert.ok(scene.lines.some((line) => line.id === "1:237"));
});

test("Retry after restart syncs a grouped tablet erasure and keeps an unrelated PDF circle", async () => {
  const f = await handwrittenWord();
  // The pairing predates saved layer IDs and has an existing 0.4.1 review.
  for (const link of f.pair().editable!.links) delete link.nativeLayers;
  const review = {
    location: "Embedded annotations · page 1",
    pageId: "p0",
    reason: "Unsupported scene deletion",
    revision: "seen-on-0.4.1",
    choices: ["Retry"] as const,
  };
  rememberReview(f.pair(), { ...review, choices: [...review.choices] });
  await f.state.save();
  const grouped = groupTabletErasures(f.tablet.pages.get("p0")!, f.word);
  f.tablet.pages.set("p0", grouped);
  f.tablet.serial++;
  const writes = f.tablet.writes;
  const restarted = await f.boot();
  assert.deepEqual(
    (
      await restarted.engine.resolve(
        f.att,
        reviewId(review),
        review.revision,
        "Retry",
      )
    ).errors,
    [],
  );
  assert.deepEqual([...(await f.readPdf()).marks.keys()], ["circle"]);
  assert.deepEqual((await f.readPdf()).marks.get("circle")?.mark, {
    ...f.paperCircle,
    author: undefined,
    comment: undefined,
  });
  assert.equal(f.readTablet(0).size, 1);
  assert.equal(f.tablet.pages.get("p0"), grouped);
  assert.equal(f.tablet.writes, writes);
  assert.equal(restarted.pair().editable?.erased.length, 3);
  assert.deepEqual(restarted.pair().reviews, {});
  assert.deepEqual((await restarted.sync()).errors, []);
  assert.deepEqual([...(await f.readPdf()).marks.keys()], ["circle"]);
  assert.equal(restarted.pair().editable?.erased.length, 3);
  assert.deepEqual([...f.files.keys()], [PATH]);
});

test("upgrading retires only the unchanged Zotero overlay covered by synced erasure history", async () => {
  const f = await handwrittenWord();
  f.tablet.pages.set(
    "p0",
    groupTabletErasures(f.tablet.pages.get("p0")!, f.word),
  );
  f.tablet.serial++;
  assert.deepEqual((await f.sync()).errors, []);
  const edit = f.pair().editable!;
  edit.refreshAnnotations = undefined;
  const paths = edit.erased.flatMap((mark) => mark.paths);
  const annotation = (key: string, geometry = paths) => ({
    key,
    parentID: f.att.id,
    deleted: false,
    annotationType: "ink",
    annotationColor: "#000000",
    annotationComment: "",
    annotationPosition: JSON.stringify({
      pageIndex: 0,
      width: 2,
      paths: geometry,
    }),
    getTags: () => [{ tag: "reMarkable import" }],
    isAnnotation: () => true,
    saves: 0,
    async saveTx() {
      this.saves++;
    },
  });
  const legacy = annotation("OWNED001");
  const edited = annotation("EDITED01");
  const unmatched = annotation("OTHER001", [...paths, ...ink(0, 146).paths]);
  const manual = annotation("MANUAL01");
  const items = new Map(
    [legacy, edited, unmatched, manual].map((item) => [item.key, item]),
  );
  Object.assign(Zotero.Items, {
    getByLibraryAndKey: (library: number, key: string) =>
      library === f.att.libraryID ? (items.get(key) ?? false) : false,
  });
  Object.assign(f.att, {
    getAnnotations: () => [...items.values()].filter((item) => !item.deleted),
  });
  for (const [i, item] of [legacy, edited, unmatched].entries()) {
    f.pair().imported[`p0/i/1:${20 + i}`] = {
      zoteroKey: item.key,
      kind: "annotation",
      hash: "legacy",
      localHash: localSnapshot(f.att, item.key),
    };
  }
  edited.annotationComment = "A Zotero-only edit";
  await f.state.save();

  const pdf = f.files.get(PATH);
  const tablet = f.tablet.pages.get("p0");
  const restarted = await f.boot();
  const report = await restarted.sync();
  assert.deepEqual(report.errors, []);
  assert.equal(report.removed, 1);
  assert.equal(legacy.deleted, true);
  assert.equal(legacy.saves, 1);
  assert.equal(edited.deleted, false);
  assert.equal(unmatched.deleted, false);
  assert.equal(manual.deleted, false);
  assert.equal(f.files.get(PATH), pdf);
  assert.equal(f.tablet.pages.get("p0"), tablet);
  assert.deepEqual([...(await f.readPdf()).marks.keys()], ["circle"]);
  assert.equal((await restarted.sync()).removed, 0);
  assert.equal(legacy.saves, 1);
});

test("an unsupported scene version reports the block and saves only the requested tablet page", async () => {
  const f = await handwrittenWord();
  const page = Buffer.from(f.tablet.pages.get("p0")!);
  for (
    let offset = 43;
    offset < page.length;
    offset += 8 + page.readUInt32LE(offset)
  ) {
    if (page[offset + 7] !== 5) continue;
    page[offset + 5] = 3;
    page[offset + 6] = 3;
    break;
  }
  f.tablet.pages.set("p0", page);
  f.tablet.serial++;
  const pdf = f.files.get(PATH);
  const report = await f.sync();
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0], /tablet block 0x05 \(minimum 3, saved 3\)/);
  const [id, review] = Object.entries(f.pair().reviews!)[0];
  const destination = "/diagnostics/page.rm";
  await assert.rejects(
    f.engine.saveTabletReviewFile(f.att, id, "stale revision", destination),
    /Review changed/,
  );
  await f.engine.saveTabletReviewFile(f.att, id, review.revision, destination);
  assert.deepEqual(Buffer.from(f.files.get(destination)!), page);
  await assert.rejects(
    f.engine.saveTabletReviewFile(f.att, id, review.revision, destination),
    /already exists/,
  );
  assert.equal(f.files.get(PATH), pdf);
  assert.equal(f.tablet.pages.get("p0"), page);
});

function withSceneExtension(page: Uint8Array, count: number) {
  // The version-3 block captured after merging layers, with tag 1 carrying
  // the length-prefixed list of entries.
  const block = Buffer.from([
    6,
    0,
    0,
    0,
    0,
    3,
    3,
    0x0e,
    0x1c,
    1,
    0,
    0,
    0,
    count,
  ]);
  return Buffer.concat([page, block]);
}

test("a merged layer's empty scene extension allows a paused erasure to resume", async () => {
  const f = await handwrittenWord();
  const previous = {
    location: "Embedded annotations · page 1",
    pageId: "p0",
    reason:
      "Unsupported block version for tablet block 0x0e (minimum 3, saved 3)",
    revision: "blocked in 0.4.3",
    choices: ["Retry"] as ["Retry"],
  };
  rememberReview(f.pair(), previous);
  await f.state.save();
  const page = withSceneExtension(
    groupTabletErasures(f.tablet.pages.get("p0")!, f.word),
    0,
  );
  f.tablet.pages.set("p0", page);
  f.tablet.serial++;
  const restarted = await f.boot();
  assert.deepEqual(
    (
      await restarted.engine.resolve(
        f.att,
        reviewId(previous),
        previous.revision,
        "Retry",
      )
    ).errors,
    [],
  );
  assert.deepEqual([...(await f.readPdf()).marks.keys()], ["circle"]);
  assert.equal(restarted.pair().editable?.erased.length, 3);
  assert.equal(f.tablet.pages.get("p0"), page);
  const extension = page.subarray(-14);
  const edited = writePageMarks(page, [], toSceneMark(ink(0), BOX), {
    authorUuid: AUTHOR,
  });
  assert.ok(Buffer.from(edited.bytes).includes(extension));
});

test("a populated scene extension keeps the PDF and tablet page untouched", async () => {
  const f = await handwrittenWord();
  const page = withSceneExtension(
    groupTabletErasures(f.tablet.pages.get("p0")!, f.word),
    1,
  );
  f.tablet.pages.set("p0", page);
  f.tablet.serial++;
  const pdf = f.files.get(PATH);
  const writes = f.tablet.writes;
  assert.match(
    (await f.sync()).errors[0],
    /Unsupported tablet scene extension contents/,
  );
  assert.equal(f.files.get(PATH), pdf);
  assert.equal(f.tablet.pages.get("p0"), page);
  assert.equal(f.tablet.writes, writes);
  assert.deepEqual(f.pair().editable?.erased, []);
});

test("a page-layout review can save the tracked tablet PDF without replacing the attachment", async () => {
  const f = await handwrittenWord();
  const review = {
    location: PDF_PAGE_LAYOUT_REVIEW,
    reason: "Recorded page layout differs",
    revision: "layout-review",
    choices: ["Retry"] as ["Retry"],
  };
  rememberReview(f.pair(), review);
  const pdf = f.files.get(PATH);
  const writes = f.tablet.writes;
  await f.engine.saveTabletReviewFile(
    f.att,
    "document",
    review.revision,
    "/diagnostics/reference.pdf",
  );
  assert.deepEqual(f.files.get("/diagnostics/reference.pdf"), f.tablet.pdf);
  assert.equal(f.files.get(PATH), pdf);
  assert.equal(f.tablet.writes, writes);
  f.pair().tabletPdfHash = "0".repeat(64);
  await assert.rejects(
    f.engine.saveTabletReviewFile(
      f.att,
      "document",
      review.revision,
      "/diagnostics/other.pdf",
    ),
    /could not be matched/,
  );
});

test("partial erasure of a multi-stroke PDF mark recovers only the erased strokes", async () => {
  const f = await setup();
  await f.engine.editableMode(f.att);
  assert.deepEqual((await f.sync()).errors, []);
  const PDFMark = {
    ...ink(0),
    paths: [45, 62, 85].flatMap((y) => ink(0, y).paths),
  };
  await f.editPdf("word", PDFMark);
  assert.deepEqual((await f.sync()).errors, []);
  const [first, second, last] = f.pair().editable!.links[0].native;
  const grouped = groupTabletErasures(f.tablet.pages.get("p0")!, [
    first,
    second,
  ]);
  f.tablet.pages.set("p0", grouped);
  f.tablet.serial++;
  assert.deepEqual((await f.sync()).errors, []);
  assert.deepEqual([...f.readTablet(0).keys()], [last]);
  assert.deepEqual(
    (await f.readPdf()).marks.get("word")?.mark.paths,
    PDFMark.paths.slice(2),
  );
  assert.deepEqual(
    f.pair().editable?.erased[0].paths,
    PDFMark.paths.slice(0, 2),
  );
  await f.engine.editableMode(f.att, true);
  assert.deepEqual((await f.sync()).errors, []);
  const pdf = await f.readPdf();
  assert.equal(pdf.marks.size, 2);
  assert.equal(f.readTablet(0).size, 3);
  assert.deepEqual(
    [...pdf.marks.values()].flatMap(({ mark }) => mark.paths),
    [PDFMark.paths[2], PDFMark.paths[0], PDFMark.paths[1]],
  );
});

test("editing the PDF during a grouped tablet erasure creates a conflict before any writes", async () => {
  const f = await handwrittenWord();
  const link = f
    .pair()
    .editable?.links.find((link) => link.native.includes(f.word[0]));
  assert.ok(link);
  await f.editPdf(link.id, ink(0, 120));
  const edited = f.files.get(PATH);
  const grouped = groupTabletErasures(f.tablet.pages.get("p0")!, f.word);
  f.tablet.pages.set("p0", grouped);
  f.tablet.serial++;
  const writes = f.tablet.writes;
  assert.match((await f.sync()).errors[0], /Both sides changed/);
  assert.equal(f.files.get(PATH), edited);
  assert.equal(f.tablet.pages.get("p0"), grouped);
  assert.equal(f.tablet.writes, writes);
  const [key, review] = Object.entries(f.pair().reviews!)[0];
  assert.deepEqual(
    (await f.engine.resolve(f.att, key, review.revision, "Use Zotero version"))
      .errors,
    [],
  );
  assert.deepEqual(
    new Set((await f.readPdf()).marks.keys()),
    new Set([link.id, "circle"]),
  );
  assert.equal(f.readTablet(0).size, 2);
});

for (const [description, eraseCount, length, error] of [
  ["an invalid length", 3, 0, /Invalid tablet deletion record/],
  ["a missing stroke outside the range", 3, 2, /erasure could not be verified/],
  ["a live stroke within the range", 2, 3, /records disagree/],
] as const) {
  test(`a grouped deletion with ${description} preserves both copies`, async () => {
    const f = await handwrittenWord();
    const before = f.files.get(PATH);
    const page = groupTabletErasures(
      f.tablet.pages.get("p0")!,
      f.word.slice(0, eraseCount),
      length,
    );
    f.tablet.pages.set("p0", page);
    f.tablet.serial++;
    const writes = f.tablet.writes;
    assert.match((await f.sync()).errors[0], error);
    assert.equal(f.files.get(PATH), before);
    assert.equal(f.tablet.pages.get("p0"), page);
    assert.equal(f.tablet.writes, writes);
    assert.equal(f.pair().editable?.erased.length, 0);
  });
}

test("native PDF annotation edits preserve the paper and unrelated annotation", async () => {
  const doc = await PDFDocument.load(await makePdf(2));
  doc.getPage(0).node.addAnnot(
    doc.context.register(
      doc.context.obj({
        Type: "Annot",
        Subtype: "Text",
        Rect: [1, 2, 3, 4],
      }),
    ),
  );
  const base = await openEmbeddedPdf(await doc.save());
  const marks = new Map([
    ["ink", ink(0)],
    ["highlight", highlight(1)],
  ]);
  const actual = await openEmbeddedPdf(await patchEmbeddedPdf(base, marks));
  assert.equal(actual.base, base.base);
  assert.equal(actual.doc.getPage(0).node.Annots()?.size(), 2);
  assert.ok(actual.marks.get("ink")?.dict.has(PDFName.of("InkList")));
  assert.ok(actual.marks.get("highlight")?.dict.has(PDFName.of("QuadPoints")));
  for (const [id, mark] of marks)
    assert.equal(
      markSignature(actual.marks.get(id)?.mark),
      markSignature(mark),
    );
});

test("the scene writer can edit existing tablet pages without discarding other marks", async () => {
  const source = new Uint8Array(
    await readFile(
      new URL("../fixtures/Normal_A_stroke_2_layers.rm", import.meta.url),
    ),
  );
  const before = parseRm(source);
  const added = writePageMarks(
    source,
    [],
    [...toSceneMark(ink(0), BOX), ...toSceneMark(highlight(0), BOX)],
    { authorUuid: AUTHOR },
  );
  const after = parseRm(added.bytes);
  assert.deepEqual(after.lines.slice(0, before.lines.length), before.lines);
  assert.equal(after.lines.length, before.lines.length + 1);
  assert.equal(after.glyphs.length, before.glyphs.length + 1);
  const erased = parseRm(
    writePageMarks(added.bytes, added.ids, [], { authorUuid: AUTHOR }).bytes,
  );
  assert.deepEqual(erased.lines, before.lines);
  assert.deepEqual(erased.glyphs, before.glyphs);
});

test("one original PDF and one pairing carry ink and highlights in both directions, including erasure and recovery", async () => {
  const f = await setup();
  f.editTablet(0, [], ink(0));
  await f.engine.editableMode(f.att);
  assert.deepEqual((await f.sync()).errors, []);
  const [inkId] = (await f.readPdf()).marks.keys();
  assert.ok(inkId);
  await f.editPdf("highlight", highlight(1));
  assert.deepEqual((await f.sync()).errors, []);
  assert.equal(f.readTablet(1).size, 1);
  assert.equal((await f.readPdf()).marks.size, 2);
  const unchangedWrites = f.tablet.writes;
  assert.deepEqual((await f.sync()).errors, []);
  assert.equal(f.tablet.writes, unchangedWrites);
  await f.editPdf("highlight");
  assert.deepEqual((await f.sync()).errors, []);
  assert.equal(f.readTablet(1).size, 0);
  const nativeInk = [...f.readTablet(0).keys()];
  f.editTablet(0, nativeInk);
  assert.deepEqual((await f.sync()).errors, []);
  assert.equal((await f.readPdf()).marks.size, 0);
  assert.equal(f.pair().editable?.erased.length, 2);
  const restarted = await f.boot();
  await restarted.engine.editableMode(f.att, true);
  assert.deepEqual((await restarted.sync()).errors, []);
  assert.equal((await f.readPdf()).marks.size, 1);
  assert.equal(f.readTablet(0).size, 1);
  assert.equal(restarted.pair().editable?.erased.length, 1);
  assert.equal(restarted.pair().editable?.restore, undefined);
  assert.equal(restarted.pair().rmDocId, DOC);
  assert.deepEqual([...f.files.keys()], [PATH]);
});

test("a conflict holds its page while another page syncs; Keep both and stale choices are verified", async () => {
  const f = await setup();
  f.editTablet(0, [], ink(0));
  f.editTablet(1, [], highlight(1));
  await f.engine.editableMode(f.att);
  assert.deepEqual((await f.sync()).errors, []);
  for (const link of f.pair().editable!.links)
    await f.editPdf(
      link.id,
      link.pdf.kind === "ink" ? ink(0, 60) : highlight(1, 130),
    );
  f.editTablet(0, [...f.readTablet(0).keys()]);
  f.editTablet(1, [...f.readTablet(1).keys()]);
  f.editTablet(2, [], ink(2));
  const conflicts = await f.sync();
  assert.equal(conflicts.errors.length, 2);
  assert.equal((await f.readPdf()).marks.size, 3);
  const [id, review] = Object.entries(f.pair().reviews!).find(
    ([, review]) => review.pageId === "p0",
  )!;
  const oldMark = [...(await f.readPdf()).marks].find(
    ([, entry]) => entry.mark.page === 0,
  )![0];
  await f.editPdf(oldMark, ink(0, 75));
  await f.engine.resolve(f.att, id, review.revision, "Use tablet version");
  assert.equal(f.readTablet(0).size, 0);
  assert.ok((await f.readPdf()).marks.has(oldMark));
  const fresh = f.pair().reviews![id];
  assert.notEqual(fresh.revision, review.revision);
  await f.engine.resolve(f.att, id, fresh.revision, "Keep both");
  assert.equal(f.readTablet(0).size, 1, "Keep both retains the surviving mark");
  assert.equal(Object.keys(f.pair().reviews!).length, 1);
});

test("locked original and lost tablet acknowledgment resume without duplicate marks", async () => {
  const f = await setup();
  f.editTablet(0, [], ink(0));
  await f.engine.editableMode(f.att);
  f.disk.locked = true;
  assert.match((await f.sync()).errors[0], /original PDF could not be updated/);
  assert.equal((await f.readPdf()).marks.size, 0);
  assert.equal(f.readTablet(0).size, 1);
  assert.equal(f.tablet.writes, 0);
  f.disk.locked = false;
  f.tablet.interrupt = "after";
  const restarted = await f.boot();
  const review = restarted.pair().reviews!.document;
  assert.match(
    (await restarted.engine.resolve(
      f.att,
      "document",
      review.revision,
      "Retry",
    ))!.errors[0],
    /lost response/,
  );
  assert.equal(f.tablet.writes, 1);
  const restartedAgain = await f.boot();
  f.tablet.interrupt = "";
  assert.deepEqual((await restartedAgain.sync()).errors, []);
  assert.equal(f.tablet.writes, 1);
  assert.equal((await f.readPdf()).marks.size, 1);
  assert.equal(f.readTablet(0).size, 1);
  assert.deepEqual([...f.files.keys()], [PATH]);
});

test("two readable edits can be kept as two marks in the same PDF", async () => {
  const f = await setup();
  await f.engine.editableMode(f.att);
  assert.deepEqual((await f.sync()).errors, []);
  const stroke = ink(0);
  await f.editPdf("pdf-ink", {
    ...stroke,
    paths: [...stroke.paths, ...ink(0, 82).paths],
  });
  assert.deepEqual((await f.sync()).errors, []);
  const [, erase] = [...f.readTablet(0).keys()];
  assert.ok(erase);
  f.editTablet(0, [erase]);
  await f.editPdf("pdf-ink", ink(0, 105));
  assert.match((await f.sync()).errors[0], /Both sides changed/);
  const [key, review] = Object.entries(f.pair().reviews!)[0];
  const edited = (await f.readPdf()).marks.get("pdf-ink")!.mark;
  assert.deepEqual(
    (await f.engine.resolve(f.att, key, review.revision, "Keep both"))!.errors,
    [],
  );
  const pdf = await f.readPdf();
  assert.equal(pdf.marks.size, 2);
  assert.deepEqual(pdf.marks.get("pdf-ink")!.mark, edited);
  assert.equal(f.readTablet(0).size, 2);
  assert.deepEqual((await f.sync()).errors, []);
  assert.equal((await f.readPdf()).marks.size, 2);
});

test("a new edit during a partial write is compared after restart", async () => {
  const f = await setup();
  await f.engine.editableMode(f.att);
  assert.deepEqual((await f.sync()).errors, []);
  await f.editPdf("highlight", highlight(1));
  f.editTablet(0, [], ink(0));
  f.tablet.interrupt = "before";
  assert.match((await f.sync()).errors[0], /interrupted before tablet write/);
  assert.equal((await f.readPdf()).marks.size, 2);
  assert.equal(f.readTablet(1).size, 0);
  f.tablet.interrupt = "";
  f.editTablet(0, [], ink(0, 80));
  const restarted = await f.boot();
  assert.match(
    (await restarted.sync()).errors[0],
    /tablet changed during the pending sync/,
  );
  const { revision } = restarted.pair().reviews!.document;
  assert.deepEqual(
    (await restarted.engine.resolve(f.att, "document", revision, "Retry"))!
      .errors,
    [],
  );
  assert.equal((await f.readPdf()).marks.size, 3);
  assert.equal(f.readTablet(0).size, 2);
  assert.equal(f.readTablet(1).size, 1);
  assert.deepEqual([...f.files.keys()], [PATH]);
});

test("reordering the tablet PDF pages pauses edits before either side is written", async () => {
  const f = await setup();
  await f.engine.editableMode(f.att);
  assert.deepEqual((await f.sync()).errors, []);
  await f.editPdf("highlight", highlight(1));
  f.tablet.content = {
    pages: ["p2", "p1", "p0"],
    redirectionPageMap: [2, 1, 0],
    pageCount: 3,
  };
  f.tablet.serial++;
  const writes = f.tablet.writes;
  const original = f.files.get(PATH);
  assert.match((await f.sync()).errors[0], /one-to-one page map/);
  assert.equal(f.tablet.writes, writes);
  assert.equal(f.files.get(PATH), original);
});

test("restoring an erased annotation also recovers its embedded PDF comment", async () => {
  const f = await setup();
  await f.engine.editableMode(f.att);
  assert.deepEqual((await f.sync()).errors, []);
  const mark = { ...ink(1), comment: "A note in the PDF", author: "Reader" };
  await f.editPdf("commented", mark);
  assert.deepEqual((await f.sync()).errors, []);
  f.editTablet(1, [...f.readTablet(1).keys()]);
  assert.deepEqual((await f.sync()).errors, []);
  assert.equal((await f.readPdf()).marks.size, 0);
  await f.engine.editableMode(f.att, true);
  assert.deepEqual((await f.sync()).errors, []);
  const [restored] = (await f.readPdf()).marks.values();
  assert.equal(restored.mark.comment, mark.comment);
  assert.equal(restored.mark.author, mark.author);
});

async function paperWithText() {
  const doc = await PDFDocument.load(await makePdf(3));
  for (const [i, page] of doc.getPages().entries())
    page.drawText(`Original paper, page ${i + 1}`, { x: 20, y: 160, size: 11 });
  return doc.save();
}

async function differentPaper(pageCount: number, mark?: EditableMark) {
  const doc = await PDFDocument.load(await makePdf(pageCount));
  doc
    .getPage(0)
    .drawText("Different paper layout", { x: 15, y: 165, size: 12 });
  const bytes = await doc.save();
  if (!mark) return bytes;
  return patchEmbeddedPdf(
    await openEmbeddedPdf(bytes),
    new Map([["new-ink", mark]]),
  );
}

test("Use Zotero PDF replaces the existing tablet PDF and preserves notebook data with a verified recovery copy", async () => {
  const f = await handwrittenWord();
  const beforeTablet = f.tablet.pdf;
  const oldPage = f.tablet.pages.get("p0")!;
  const notebook = writePageMarks(undefined, [], toSceneMark(ink(0), BOX), {
    authorUuid: AUTHOR,
  }).bytes;
  f.tablet.pages.set("notebook", notebook);
  f.tablet.content = {
    pages: ["p0", "p1", "p2", "notebook"],
    pageCount: 4,
    originalPageCount: 3,
    redirectionPageMap: [0, 1, 2, -1],
  };
  f.tablet.serial++;
  const local = await differentPaper(2, ink(1));
  f.files.set(PATH, local);
  assert.match((await f.sync()).errors[0], /PDF page count changed/);
  const review = f.pair().reviews!.document;
  assert.deepEqual(review.choices, [
    "Retry",
    "Use reMarkable PDF",
    "Use Zotero PDF",
  ]);
  const writes = f.tablet.writes;
  const report = await f.engine.resolve(
    f.att,
    "document",
    review.revision,
    "Use Zotero PDF",
  );
  assert.deepEqual(report.errors, []);
  assert.match(report.notices[0], /recovery folder/);
  assert.equal(f.tablet.writes, writes + 1);
  assert.equal(f.pair().rmDocId, DOC);
  assert.equal(f.pair().originalPageCount, 2);
  assert.equal(f.files.get(PATH), local);
  const result = await openEmbeddedPdf(f.tablet.pdf);
  assert.equal(result.base, (await f.readPdf()).base);
  assert.equal(result.marks.size, 0);
  const refs = pageRefs(f.tablet.content);
  assert.deepEqual(
    refs.map((page) => page.pdfIndex),
    [0, 1, undefined],
  );
  assert.equal(refs.at(-1)?.id, "notebook");
  assert.equal(f.tablet.pages.get("notebook"), notebook);
  assert.equal(f.tablet.pages.has("p0"), false);
  assert.equal(parseRm(f.tablet.pages.get(refs[1].id)!).lines.length, 1);
  const backup = `${f.state.editableStage(f.pair().editable!.lastPdfRecovery!)}.recovery`;
  assert.deepEqual(f.files.get(`${backup}/zotero.pdf`), local);
  assert.deepEqual(f.files.get(`${backup}/tablet-source.pdf`), beforeTablet);
  const manifest = JSON.parse(
    new TextDecoder().decode(f.files.get(`${backup}/manifest.json`)),
  );
  const oldPageFile = manifest.pageFiles.find(
    (item: { id: string }) => item.id === "p0",
  );
  assert.deepEqual(
    Buffer.from(f.files.get(`${backup}/${oldPageFile.name}`)!),
    Buffer.from(oldPage),
  );
  assert.equal(
    (await openEmbeddedPdf(f.files.get(`${backup}/tablet-annotated.pdf`)!))
      .marks.size,
    4,
  );
  const later = await (await f.boot()).sync();
  assert.equal(later.errors.length, 1);
  assert.match(
    later.errors[0],
    /A Zotero parent item is needed to save this note/,
  );
  assert.equal(f.tablet.writes, writes + 1);
});

test("Use reMarkable PDF resumes after a lock and replaces the same original from the current tablet version", async () => {
  const f = await handwrittenWord();
  const local = f.files.get(PATH)!;
  const incoming = await differentPaper(2);
  f.tablet.pdf = incoming;
  f.tablet.content = { pages: ["p0", "p1"], pageCount: 2 };
  f.tablet.serial++;
  const native = f.tablet.pages.get("p0");
  assert.match((await f.sync()).errors[0], /tablet PDF changed/);
  const review = f.pair().reviews!.document;
  f.disk.locked = true;
  assert.match(
    (
      await f.engine.resolve(
        f.att,
        "document",
        review.revision,
        "Use reMarkable PDF",
      )
    ).errors[0],
    /could not be updated/,
  );
  const pending = f.pair().editable?.pending;
  assert.ok(pending?.wholePdf);
  assert.equal(f.files.get(PATH), local);
  assert.equal(f.tablet.pdf, incoming);
  const writes = f.tablet.writes;
  f.disk.locked = false;
  const restarted = await f.boot();
  const next = restarted.pair().reviews!.document;
  const report = await restarted.engine.resolve(
    f.att,
    "document",
    next.revision,
    "Retry",
  );
  assert.deepEqual(report.errors, []);
  assert.match(report.notices[0], /recovery folder/);
  assert.equal(restarted.pair().editable?.lastPdfRecovery, pending.id);
  assert.equal(restarted.pair().originalPageCount, 2);
  assert.equal(restarted.pair().rmDocId, DOC);
  assert.equal(restarted.pair().tabletPdfHash, await sha256Hex(incoming));
  const updated = await f.readPdf();
  assert.equal(updated.base, (await openEmbeddedPdf(incoming)).base);
  assert.equal(updated.marks.size, 4);
  assert.equal(f.tablet.pdf, incoming);
  assert.equal(f.tablet.pages.get("p0"), native);
  assert.equal(f.tablet.writes, writes);
  assert.deepEqual((await restarted.sync()).errors, []);
  assert.equal(f.tablet.writes, writes);
});

test("a whole-PDF review cannot replace a version that changed after review", async () => {
  const f = await handwrittenWord();
  f.files.set(PATH, await differentPaper(2));
  await f.sync();
  const originalReview = f.pair().reviews!.document;
  const newer = await differentPaper(4, ink(3));
  f.files.set(PATH, newer);
  const tablet = f.tablet.pdf;
  const writes = f.tablet.writes;
  const report = await f.engine.resolve(
    f.att,
    "document",
    originalReview.revision,
    "Use reMarkable PDF",
  );
  assert.equal(report.errors.length, 1);
  assert.notEqual(f.pair().reviews!.document.revision, originalReview.revision);
  assert.equal(f.files.get(PATH), newer);
  assert.equal(f.tablet.pdf, tablet);
  assert.equal(f.tablet.writes, writes);
  assert.deepEqual([...f.files.keys()], [PATH]);
});

test("a lost tablet acknowledgment resumes the PDF replacement without making a second backup", async () => {
  const f = await handwrittenWord();
  f.files.set(PATH, await differentPaper(2, ink(1)));
  await f.sync();
  const review = f.pair().reviews!.document;
  const writes = f.tablet.writes;
  f.tablet.interrupt = "after";
  assert.match(
    (
      await f.engine.resolve(
        f.att,
        "document",
        review.revision,
        "Use Zotero PDF",
      )
    ).errors[0],
    /lost response/,
  );
  const pending = f.pair().editable!.pending!;
  assert.ok(pending.wholePdf);
  assert.equal(f.tablet.writes, writes + 1);
  const restarted = await f.boot();
  f.tablet.interrupt = "";
  assert.deepEqual((await restarted.sync()).errors, []);
  assert.equal(f.tablet.writes, writes + 1);
  assert.equal(restarted.pair().editable?.lastPdfRecovery, pending.id);
  assert.equal(
    [...f.files.keys()].filter((path) => path.endsWith("/manifest.json"))
      .length,
    1,
  );
});

test("failing to save the recovery copy prevents any replacement", async () => {
  const f = await handwrittenWord();
  const local = await differentPaper(2);
  f.files.set(PATH, local);
  await f.sync();
  const review = f.pair().reviews!.document;
  const write = IOUtils.write;
  Object.assign(IOUtils, {
    async write(path: string, bytes: Uint8Array, options: WriteOptions) {
      if (path.endsWith("/tablet-source.pdf"))
        throw new Error("recovery directory out of space");
      return write(path, bytes, options);
    },
  });
  const tablet = f.tablet.pdf;
  const writes = f.tablet.writes;
  assert.match(
    (
      await f.engine.resolve(
        f.att,
        "document",
        review.revision,
        "Use reMarkable PDF",
      )
    ).errors[0],
    /out of space/,
  );
  assert.equal(f.files.get(PATH), local);
  assert.equal(f.tablet.pdf, tablet);
  assert.equal(f.tablet.writes, writes);
  assert.equal(f.pair().editable?.pending, undefined);
});

async function withFontCharset(bytes: Uint8Array, charset: PDFString) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const fonts = doc
    .getPage(0)
    .node.Resources()!
    .lookup(PDFName.of("Font"), PDFDict);
  const font = doc.context.lookup(fonts.values()[0], PDFDict);
  font.set(
    PDFName.of("FontDescriptor"),
    doc.context.obj({
      Type: "FontDescriptor",
      CharSet: charset,
    }),
  );
  return doc.save();
}

async function editorSave(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const contents = doc.getPage(0).node.Contents();
  assert.ok(contents instanceof PDFArray);
  const ref = contents.get(0);
  assert.ok(ref instanceof PDFRef);
  const stream = doc.context.lookup(ref, PDFRawStream);
  const data = deflateSync(inflateSync(stream.getContents()), { level: 0 });
  const replacement = doc.context.stream(data, { Filter: "FlateDecode" });
  doc.context.assign(ref, replacement);
  const edited = await openEmbeddedPdf(await doc.save());
  return patchEmbeddedPdf(
    edited,
    new Map([["pdfgear-ink", { ...ink(0, 73), color: "#fff400" }]]),
  );
}

async function legacyPair(original: Uint8Array, version?: 2) {
  const f = await setup(original);
  f.editTablet(0, [], ink(0));
  await f.engine.editableMode(f.att);
  assert.deepEqual((await f.sync()).errors, []);
  const before = f.files.get(PATH)!;
  const oldBase = await (await openEmbeddedPdf(before)).baseAtVersion(
    version ?? 1,
  );
  const editable = f.pair().editable!;
  editable.base = oldBase;
  editable.baseVersion = version;
  f.pair().uploadedFingerprint = fingerprint({
    annotations: [],
    notes: [],
    base: oldBase,
    appendNotesPages: false,
  });
  f.pair().reviews = {
    document: {
      location: "Editable PDF",
      reason: "The underlying PDF changed or has no verified baseline.",
      revision: "paused by 0.4.0",
      choices: ["Retry"],
    },
  };
  await f.state.save();
  return { ...f, before, oldBase };
}

for (const priorVersion of [undefined, 2] as const) {
  test(`an older layout baseline v${priorVersion ?? 1} accepts a PDF editor rewriting a font string`, async () => {
    const escaped = PDFString.of("/T/e/s/\\164");
    const plain = PDFString.of("/T/e/s/t");
    assert.deepEqual(escaped.asBytes(), plain.asBytes());
    const f = await legacyPair(
      await withFontCharset(await paperWithText(), escaped),
      priorVersion,
    );
    const after = await openEmbeddedPdf(await withFontCharset(f.before, plain));
    const before = await openEmbeddedPdf(f.before);
    assert.notEqual(
      await before.baseAtVersion(priorVersion ?? 1),
      await after.baseAtVersion(priorVersion ?? 1),
    );
    assert.equal(before.base, after.base);
    const changed = await openEmbeddedPdf(
      await withFontCharset(f.before, PDFString.of("/T/e/s/x")),
    );
    assert.notEqual(changed.base, before.base);
    const edited = await patchEmbeddedPdf(
      after,
      new Map([["laptop-ink", ink(0, 105)]]),
    );
    f.files.set(PATH, edited);
    const ref = f.tablet.pdf;
    const writes = f.tablet.writes;
    const { engine, pair, sync } = await f.boot();
    assert.deepEqual(
      (await engine.resolve(f.att, "document", "paused by 0.4.0", "Retry"))
        .errors,
      [],
    );
    assert.equal(pair().editable?.baseVersion, PAGE_BASE_VERSION);
    assert.equal(pair().rmDocId, DOC);
    assert.equal(f.files.get(PATH), edited);
    assert.equal(f.tablet.pdf, ref);
    assert.equal(f.readTablet(0).size, 2);
    assert.equal(f.tablet.writes, writes + 1);
    assert.deepEqual((await sync()).errors, []);
    assert.equal(f.tablet.writes, writes + 1);
  });
}

test("upgrading a paused legacy pairing accepts a recompressed editor save and sends new ink once", async () => {
  const f = await legacyPair(await paperWithText());
  const edited = await editorSave(f.before);
  const pdf = await openEmbeddedPdf(edited);
  assert.notEqual(await pdf.baseAtVersion(1), f.oldBase);
  assert.equal(pdf.base, (await openEmbeddedPdf(f.before)).base);
  f.files.set(PATH, edited);
  const paperOnTablet = f.tablet.pdf;
  const writes = f.tablet.writes;
  const { engine, pair, sync } = await f.boot();
  const report = await engine.resolve(
    f.att,
    "document",
    "paused by 0.4.0",
    "Retry",
  );
  assert.deepEqual(report.errors, []);
  assert.equal(pair().editable?.baseVersion, PAGE_BASE_VERSION);
  assert.equal(pair().editable?.links.length, 2);
  assert.equal(pair().rmDocId, DOC);
  assert.equal(f.readTablet(0).size, 2);
  assert.equal(f.tablet.pdf, paperOnTablet);
  assert.equal(f.files.get(PATH), edited);
  assert.equal(f.tablet.writes, writes + 1);
  assert.deepEqual((await sync()).errors, []);
  assert.equal(f.tablet.writes, writes + 1);
});

test("only a verified earlier PDF can recover a legacy pairing when the tablet PDF differs", async () => {
  const f = await legacyPair(await paperWithText());
  // A previous tablet export included drawings in its PDF body.
  const tabletPdf = await PDFDocument.load(f.tablet.pdf);
  tabletPdf.getPage(0).drawText("Legacy export drawing");
  f.tablet.pdf = await tabletPdf.save();
  f.pair().tabletPdfHash = await sha256Hex(f.tablet.pdf);
  await f.state.save();
  const edited = await editorSave(f.before);
  f.files.set(PATH, edited);
  const earlier = "/backup/previous.pdf";
  const { engine, pair } = await f.boot();
  const review = () => pair().reviews!.document;
  const writes = f.tablet.writes;
  assert.match(
    (await engine.resolve(f.att, "document", review().revision, "Retry"))
      .errors[0],
    /tablet copy/,
  );
  assert.equal(review().verifyEarlierPdf, true);
  f.files.set(earlier, await makePdf(3));
  assert.match(
    (
      await engine.resolve(
        f.att,
        "document",
        review().revision,
        "Retry",
        earlier,
      )
    ).errors[0],
    /does not match/,
  );
  assert.equal(f.tablet.writes, writes);
  f.files.set(earlier, f.before);
  assert.deepEqual(
    (
      await engine.resolve(
        f.att,
        "document",
        review().revision,
        "Retry",
        earlier,
      )
    ).errors,
    [],
  );
  assert.equal(f.files.get(earlier), f.before);
  assert.equal(f.files.get(PATH), edited);
  assert.equal(f.readTablet(0).size, 2);
  assert.equal(pair().editable?.baseVersion, PAGE_BASE_VERSION);
});

test("a legacy pairing with a verified but different page layout stays paused across upgrades and retries", async () => {
  const f = await legacyPair(await paperWithText());
  const compatibleEdit = await editorSave(f.before);
  const changed = await PDFDocument.load(compatibleEdit);
  changed
    .getPage(0)
    .drawText("A change to the paper itself", { x: 20, y: 140 });
  const edited = await changed.save();
  f.files.set(PATH, edited);

  const baseline = (await f.boot()).pair().editable;
  const priorSourceHash = f.pair().sourcePdfHash;
  const priorTabletPdf = f.tablet.pdf;
  const priorTabletPage = f.tablet.pages.get("p0");
  const writes = f.tablet.writes;
  assert.equal(
    await (await openEmbeddedPdf(priorTabletPdf)).baseAtVersion(1),
    f.oldBase,
  );

  for (let attempt = 0; attempt < 2; attempt++) {
    const { engine, pair } = await f.boot();
    const review = pair().reviews!.document;
    const report = await engine.resolve(
      f.att,
      "document",
      review.revision,
      "Retry",
    );
    assert.match(report.errors[0], /PDF page layout.*could not be matched/);
    assert.deepEqual(Object.keys(pair().reviews!), ["document"]);
    assert.deepEqual(pair().editable, baseline);
    assert.equal(pair().sourcePdfHash, priorSourceHash);
    assert.equal(pair().rmDocId, DOC);
    assert.equal(f.tablet.writes, writes);
    assert.equal(f.tablet.pdf, priorTabletPdf);
    assert.equal(f.tablet.pages.get("p0"), priorTabletPage);
    assert.equal(f.files.get(PATH), edited);
    assert.equal((await f.readPdf()).marks.size, 2);
  }

  f.files.set(PATH, compatibleEdit);
  const { engine, pair, sync } = await f.boot();
  const review = pair().reviews!.document;
  assert.deepEqual(
    (await engine.resolve(f.att, "document", review.revision, "Retry")).errors,
    [],
  );
  assert.equal(pair().editable?.baseVersion, PAGE_BASE_VERSION);
  assert.equal(pair().editable?.links.length, 2);
  assert.equal(f.tablet.pdf, priorTabletPdf);
  assert.equal(f.tablet.writes, writes + 1);
  assert.deepEqual((await sync()).errors, []);
  assert.equal(f.tablet.writes, writes + 1);
});

for (const change of ["reorder", "replace", "flatten"] as const) {
  test(`a verified layout rejects ${change} before writing either copy`, async () => {
    const f = await setup(await paperWithText());
    f.editTablet(0, [], ink(0));
    await f.engine.editableMode(f.att);
    assert.deepEqual((await f.sync()).errors, []);
    const changed = await PDFDocument.load(f.files.get(PATH)!);
    if (change === "reorder") {
      const first = changed.getPage(0);
      changed.removePage(0);
      changed.addPage(first);
    } else if (change === "replace") {
      changed.removePage(0);
      changed.insertPage(0, [200, 200]).drawText("Replacement");
    } else {
      const first = changed.getPage(0);
      first.node.delete(PDFName.of("Annots"));
      first.drawLine({ start: { x: 10, y: 50 }, end: { x: 25, y: 55 } });
    }
    const edited = await changed.save();
    f.files.set(PATH, edited);
    const writes = f.tablet.writes;
    assert.match((await f.sync()).errors[0], /PDF page layout/);
    assert.equal(f.tablet.writes, writes);
    assert.equal(f.files.get(PATH), edited);
    assert.equal(f.readTablet(0).size, 1);
  });
}
