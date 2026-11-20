import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "../../src/remarkable/hash";
import {
  recoverDrawings,
  writeDrawing,
  type DrawingWrite,
} from "../../src/sync/drawingJournal";
import { drawingImg } from "../../src/sync/notes";
import type { DocState } from "../../src/sync/state";

function fixture() {
  const note = {
    key: "COPY0001",
    id: 20,
    parentID: 10,
    deleted: false,
    html: '<p>Text</p><img data-attachment-key="OLD00001"><img data-attachment-key="USER0001">',
    isNote: () => true,
    getNote() {
      return this.html;
    },
    setNote(html: string) {
      this.html = html;
    },
    getTags: () => [],
    getAttachments: () =>
      [...images.values()]
        .filter((image) => image.parentID === 20)
        .map((image) => image.id),
    saveTx: async () => {},
  };
  function image(id: number, key: string) {
    return {
      id,
      key,
      parentID: 20,
      deleted: false,
      attachmentContentType: "image/svg+xml",
      getFilePathAsync: async () => key,
      saveTx: async () => {},
    };
  }
  const old = image(21, "OLD00001");
  const user = image(22, "USER0001");
  const images = new Map([old, user].map((image) => [image.key, image]));
  const enc = new TextEncoder();
  const bytes = new Map([[old.key, enc.encode("<svg>Original</svg>")]]);
  const drawing = { markup: "<svg>New</svg>", width: 4, height: 5 };
  let imports = 0;
  const host = globalThis as any;
  host.Zotero = {
    Items: {
      getByLibraryAndKey: (_library: number, key: string) =>
        key === note.key ? note : images.get(key),
      get: (id: number) =>
        [...images.values()].find((value) => value.id === id),
    },
    Attachments: {
      importEmbeddedImage: async ({ blob }: { blob: Blob }) => {
        const created = image(23 + imports++, `NEW0000${imports}`);
        images.set(created.key, created);
        bytes.set(created.key, new Uint8Array(await blob.arrayBuffer()));
        return created;
      },
    },
  };
  host.IOUtils = { read: async (path: string) => bytes.get(path) };
  const attachment = { libraryID: 1, parentID: 10 } as Zotero.Item;
  const doc: DocState = {
    libraryID: 1,
    attachmentKey: "ATT00001",
    rmDocId: "doc",
    originalPageCount: 1,
    pageBoxes: [],
    appendedPageCount: 0,
    imported: {},
    notePages: {},
  };
  const target: DrawingWrite["target"] = {
    kind: "page",
    id: "page",
    retain: "RICH0001",
    record: { noteKey: note.key, owned: true, base: "Text" },
  };
  const render = (replacement?: Parameters<typeof drawingImg>[0]) =>
    `<p>Text</p>${replacement ? drawingImg(replacement) : ""}<img data-attachment-key="USER0001">`;
  return {
    note,
    old,
    user,
    bytes,
    images,
    drawing,
    attachment,
    doc,
    target,
    render,
    imports: () => imports,
  };
}

for (const phase of [
  "before stage checkpoint",
  "before note save",
  "before ownership checkpoint",
  "after Trash",
] as const) {
  test(`drawing recovery resumes after interruption ${phase}`, async () => {
    const f = fixture();
    f.doc.drawingDigests = {
      [f.old.key]: await sha256Hex(f.bytes.get(f.old.key)!),
    };
    let disk = structuredClone(f.doc);
    let breakOnce = true;
    const failNoteSave = f.note.saveTx;
    f.note.saveTx = async () => {
      if (phase === "before note save" && breakOnce) {
        breakOnce = false;
        throw new Error("interrupted");
      }
      await failNoteSave();
    };
    const makeWrite = (doc: DocState, interrupt: boolean): DrawingWrite => ({
      doc,
      target: f.target,
      previous: f.old.key,
      guard() {},
      async checkpoint() {
        const intent = doc.drawingJournal?.[f.note.key];
        if (
          interrupt &&
          breakOnce &&
          ((phase === "before stage checkpoint" &&
            intent?.replacement &&
            !intent.recorded) ||
            (phase === "before ownership checkpoint" && intent?.recorded) ||
            (phase === "after Trash" && f.old.deleted))
        ) {
          breakOnce = false;
          throw new Error("interrupted");
        }
        disk = structuredClone(doc);
      },
    });
    const note = f.note as unknown as Zotero.Item;
    await assert.rejects(
      writeDrawing(
        f.attachment,
        note,
        f.drawing,
        f.render,
        makeWrite(f.doc, true),
      ),
      /interrupted/,
    );
    if (phase !== "after Trash") assert.equal(f.old.deleted, false);
    const resumed = makeWrite(structuredClone(disk), false);
    await recoverDrawings(f.attachment, resumed);
    if (!resumed.doc.notePages?.page) {
      await writeDrawing(f.attachment, note, f.drawing, f.render, resumed);
    }
    const copy = resumed.doc.notePages?.page;
    assert.equal(copy?.noteKey, f.note.key);
    assert.match(f.note.html, /NEW00001/);
    assert.match(f.note.html, /USER0001/);
    assert.equal(copy?.drawingKey, "NEW00001");
    assert.deepEqual(resumed.doc.retainedNotes, ["RICH0001"]);
    assert.equal(f.imports(), 1);
    assert.equal(f.old.deleted, true);
    assert.equal(f.user.deleted, false);
    assert.equal(Object.keys(resumed.doc.drawingJournal ?? {}).length, 0);
  });
}

test("an edited old drawing is retained after the new drawing is recorded", async () => {
  const f = fixture();
  f.doc.drawingDigests = {
    [f.old.key]: await sha256Hex(f.bytes.get(f.old.key)!),
  };
  f.bytes.set(f.old.key, new TextEncoder().encode("<svg>User edit</svg>"));
  await writeDrawing(
    f.attachment,
    f.note as unknown as Zotero.Item,
    f.drawing,
    f.render,
    {
      doc: f.doc,
      target: f.target,
      previous: f.old.key,
      guard() {},
      checkpoint: async () => {},
    },
  );
  assert.equal(f.old.deleted, false);
  assert.equal(f.doc.notePages?.page.drawingKey, "NEW00001");
});
