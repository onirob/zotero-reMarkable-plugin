import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { RemarkableService } from "../../src/modules/service";
import { buildPdfContent, addInsertedPage } from "../../src/remarkable/content";
import { sha256Hex } from "../../src/remarkable/hash";
import { HEADER, parseRm } from "../../src/remarkable/rmscene";
import { writePageText } from "../../src/remarkable/rmwrite";
import {
  CONVERTER_VERSION,
  fingerprint,
  makeTransform,
} from "../../src/sync/convert";
import {
  fakeAttachment,
  installGlobals,
  makeEngine,
  makeState,
  memoryIO,
} from "./engineHarness";
import type { RemarkableCloud } from "../../src/remarkable/cloud";
import { rememberReview, reviewEntries } from "../../src/sync/review";
import type { DocState } from "../../src/sync/state";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL("../fixtures/" + name, import.meta.url)));
function firstReview(doc: DocState) {
  const entry = reviewEntries(doc)[0];
  assert.ok(entry, "expected a pending review");
  return entry;
}
function resolveFirst(
  session: Awaited<ReturnType<Awaited<ReturnType<typeof pairedPaper>>["boot"]>>,
  att: Zotero.Item,
  choice: Parameters<typeof session.engine.resolve>[3],
) {
  const [id, review] = firstReview(session.doc);
  return session.engine.resolve(att, id, review.revision, choice);
}

const author = "33333333-3333-4333-8333-333333333333";

test("two conflicts persist independently while a third page syncs", async () => {
  const p = await pairedPaper();
  const pages = ["a", "b", "c"];
  let index = 0;
  p.tablet.content = buildPdfContent({
    newId: () => pages[index++],
    authorId: author,
    pageCount: 3,
    sizeInBytes: 3,
  });
  const writePage = (id: string, text: string) => {
    p.tablet.rm.set(
      id,
      writePageText(undefined, [{ style: 1, text }], { authorUuid: author }),
    );
    p.tablet.hash += "+";
  };
  p.tablet.rm.clear();
  for (const id of pages) writePage(id, `Original ${id}`);
  const initial = await p.boot();
  initial.doc.originalPageCount = 3;
  initial.doc.pageBoxes = pages.map(() => initial.doc.pageBoxes[0]);
  await initial.state.save();
  assert.deepEqual((await initial.engine.sync([p.att])).errors, []);
  const key = (id: string) => initial.doc.imported[`${id}/t`].zoteroKey;
  const comment = (id: string) => p.items.get(key(id)).annotationComment;
  p.items.get(key("a")).annotationComment = "Zotero A";
  p.items.get(key("b")).annotationComment = "Zotero B";
  writePage("a", "Tablet A");
  writePage("b", "Tablet B");
  writePage("c", "Tablet C");
  assert.equal((await initial.engine.sync([p.att])).errors.length, 2);
  assert.equal(comment("a"), "Zotero A");
  assert.equal(comment("b"), "Zotero B");
  assert.equal(comment("c"), "Tablet C");
  const restart = await p.boot();
  const [first, second] = reviewEntries(restart.doc);
  assert.ok(first && second);
  const revisions = new Map(
    reviewEntries(restart.doc).map((row) => [row[1].pageId, row]),
  );
  const [aId, aReview] = revisions.get("a")!;
  writePage("c", "Newer C");
  await restart.engine.resolve(
    p.att,
    aId,
    aReview.revision,
    "Use tablet version",
  );
  assert.equal(comment("a"), "Tablet A");
  assert.equal(comment("c"), "Newer C");
  assert.equal(comment("b"), "Zotero B");
  const [bId, bReview] = firstReview(restart.doc);
  writePage("b", "Newer tablet B");
  await restart.engine.resolve(
    p.att,
    bId,
    bReview.revision,
    "Use tablet version",
  );
  assert.equal(comment("b"), "Zotero B");
  assert.notEqual(firstReview(restart.doc)[1].revision, bReview.revision);
  await resolveFirst(restart, p.att, "Use tablet version");
  assert.equal(comment("b"), "Newer tablet B");
  assert.deepEqual(reviewEntries(restart.doc), []);
});

test("library selection gates tag searches, manual work, tracked lookup and queued operations", async () => {
  const z = installGlobals();
  const io = memoryIO();
  const state = makeState(io);
  await state.load();
  const libraries = [1, 2, 3].map((libraryID, i) => ({
    name: i ? "Group " + i : "My Library",
    libraryType: i ? "group" : "user",
    libraryID,
    editable: true,
    filesEditable: i !== 2,
  }));
  const items = libraries.map((lib) => ({
    id: lib.libraryID,
    libraryID: lib.libraryID,
    key: "PAPER",
    isPDFAttachment: () => true,
    isRegularItem: () => false,
    getDisplayTitle: () => "Paper",
    getFilePathAsync: async () => false,
  }));
  const searches: number[] = [];
  const prefs: Record<string, unknown> = {};
  const host = globalThis as any;
  host.Localization = class {
    formatMessagesSync() {
      return [];
    }
  };
  Object.assign(host.Zotero, {
    Libraries: { getAll: () => libraries },
    Prefs: {
      get: (k: string) => (k.endsWith("syncTag") ? "same tag" : prefs[k]),
      set: (k: string, v: unknown) => {
        prefs[k] = v;
      },
    },
    Search: class {
      constructor(readonly lib: { libraryID: number }) {}
      addCondition() {}
      async search() {
        searches.push(this.lib.libraryID);
        return [this.lib.libraryID];
      }
    },
    Items: {
      get: (ids: number[]) => ids.map((id) => items[id - 1]),
      getByLibraryAndKey: (id: number) => items[id - 1],
    },
    ProgressWindow: class {
      ItemProgress = class {
        setProgress() {}
        setError() {}
        setText() {}
      };
      changeHeadline() {}
      show() {}
      startCloseTimer() {}
    },
    getMainWindow: () => ({ confirm: () => false }),
    getString: () => "",
  });
  const service = new RemarkableService();
  Object.assign(service, { token: "test", account: "account-a", state });
  const requests: number[] = [];
  const cloud = {
    clearPageCache() {},
    getRoot: async () => {
      requests.push(1);
      return {};
    },
    getRootEntries: async () => [],
  } as unknown as RemarkableCloud;
  const engine = makeEngine({
    state,
    cloud,
    eligible: (id) => service.eligible(id),
  });
  Object.assign(service, { engine });
  for (const item of items)
    state.set({
      libraryID: item.libraryID,
      attachmentKey: item.key,
      rmDocId: "doc-" + item.id,
      originalPageCount: 1,
      appendedPageCount: 0,
      pageBoxes: [],
      imported: {},
    });
  await service.syncAll(true);
  assert.deepEqual(requests, []);
  assert.deepEqual(searches, []);
  service.selectLibrary(2, true);
  service.selectLibrary(3, true);
  await service.syncAll(true);
  assert.deepEqual(searches, [2]);
  assert.deepEqual(
    (await engine.trackedAttachments()).map((a) => a.libraryID),
    [2],
  );
  libraries[1].name = "Renamed";
  assert.equal(service.eligible(2), true);
  assert.equal(service.eligible(3), false);
  const excluded = {
    ...items[0],
    isPDFAttachment() {
      throw new Error("unchecked item inspected");
    },
  };
  assert.equal(service.isTracked(excluded as never), false);
  await service.removeFromTablet([excluded as never]);
  await service.removeImported([excluded as never], false);
  await service.removeImported([excluded as never], true);
  await service.syncSelected([excluded as never]);
  const queued = engine.sync([items[1] as never]);
  service.selectLibrary(2, false);
  await queued;
  assert.equal(requests.length, 1);
  service.selectLibrary(2, true);
  Object.assign(service, { account: "account-b" });
  assert.equal(service.eligible(2), false);
  await service.syncAll(true);
  assert.equal(requests.length, 1);
  Object.assign(service, { account: "account-a" });
  assert.equal(service.eligible(2), true);
  assert.ok(z.erased.length === 0);
});

async function pairedPaper(importHandwriting = false) {
  const z = installGlobals();
  const host = globalThis as any;
  const pdf = new Uint8Array([1, 2, 3]);
  z.files.set("paper", pdf);
  const io = memoryIO();
  const att = fakeAttachment({
    key: "PAPER",
    path: "paper",
    title: { value: "Paper" },
  });
  const items = new Map<string, any>();
  let seq = 0;
  let failSave = false;
  host.Zotero.DataObjectUtilities = { generateKey: () => "KEY" + ++seq };
  host.Zotero.Items = {
    getByLibraryAndKey: (_id: number, key: string) => items.get(key),
    get: (ids: string[]) => ids.map((id) => items.get(id)),
  };
  host.Zotero.Annotations = {
    saveFromJSON: async (_att: unknown, json: any) => {
      if (failSave) throw new Error("Disk full");
      const item = {
        key: json.key,
        parentID: att.id,
        libraryID: 1,
        isAnnotation: () => true,
        isNote: () => false,
        annotationType: json.type,
        annotationPosition: JSON.stringify(json.position),
        annotationText: json.text,
        related: [] as string[],
        addRelatedItem(other: { key: string }) {
          this.related.push(other.key);
        },
        saveTx: async () => {},
        annotationComment: json.comment,
        annotationColor: json.color,
        annotationSortIndex: json.sortIndex,
        annotationPageLabel: json.pageLabel,
        getTags: () => json.tags,
      };
      items.set(item.key, item);
      return item;
    },
  };
  const original = fixture("Wikipedia_highlighted_p1.rm");
  const tablet = {
    hash: "h1",
    rm: new Map([["p", original]]),
    content: buildPdfContent({
      newId: () => "p",
      authorId: author,
      pageCount: 1,
      sizeInBytes: 3,
    }),
    offline: false,
  };
  const cloud = {
    clearPageCache() {},
    getRoot: async () => ({}),
    getRootEntries: async () => [{ id: "doc", hash: tablet.hash }],
    findDocument: async () => ({ hash: tablet.hash }),
    getDocumentFiles: async () => {
      if (tablet.offline) throw new Error("Connection interrupted");
      return tablet;
    },
    updateDocument: async (
      _id: string,
      changes: { pages: Map<string, Uint8Array> },
      opts: { expectedHash: string },
    ) => {
      assert.equal(opts.expectedHash, tablet.hash);
      for (const [id, bytes] of changes.pages) tablet.rm.set(id, bytes);
      const baseHash = tablet.hash;
      tablet.hash += "+";
      return { baseHash, hash: tablet.hash };
    },
  } as unknown as RemarkableCloud;
  const seed = makeState(io);
  await seed.load();
  const doc: DocState = {
    attachmentKey: att.key,
    libraryID: 1,
    rmDocId: "doc",
    rmDocHash: "old",
    originalPageCount: 1,
    appendedPageCount: 0,
    pageBoxes: [{ x: 0, y: 0, width: 612, height: 792 }],
    converterVersion: CONVERTER_VERSION,
    sourcePdfHash: await sha256Hex(pdf),
    pushedTitle: "Paper",
    imported: {},
    uploadedFingerprint: fingerprint({
      annotations: [],
      notes: [],
      size: 3,
      mtime: 1,
      appendNotesPages: false,
    }),
  };
  seed.set(doc);
  await seed.save();
  let enabled = true;
  async function boot() {
    const state = makeState(io);
    await state.load();
    return {
      engine: makeEngine({
        state,
        cloud,
        importHandwriting,
        eligible: () => enabled,
      }),
      doc: state.get(1, att.key)!,
      state,
    };
  }
  return {
    att,
    items,
    tablet,
    boot,
    original,
    host,
    fail: (v: boolean) => {
      failSave = v;
    },
    enable: (v: boolean) => {
      enabled = v;
    },
  };
}

test("incomplete downloads and local saves retry after restart; verified tablet erasure keeps local edits", async () => {
  const p = await pairedPaper();
  p.tablet.offline = true;
  assert.match(
    (await (await p.boot()).engine.sync([p.att])).errors[0],
    /Sync incomplete/,
  );
  assert.equal(p.items.size, 0);
  p.tablet.offline = false;
  p.fail(true);
  assert.match(
    (await (await p.boot()).engine.sync([p.att])).errors[0],
    /Sync incomplete/,
  );
  assert.deepEqual(p.tablet.rm.get("p"), p.original);
  p.fail(false);
  assert.deepEqual((await (await p.boot()).engine.sync([p.att])).errors, []);
  assert.equal(p.items.size, 2);
  const first = [...p.items.values()][0];
  first.annotationComment = "Keep my edits";
  p.tablet.rm.clear();
  p.tablet.hash = "erased";
  const report = await (await p.boot()).engine.sync([p.att]);
  assert.equal(report.notices.length, 2);
  assert.equal(p.items.size, 2);
  assert.equal(first.annotationComment, "Keep my edits");
  await (await p.boot()).engine.sync([p.att]);
  assert.equal(p.items.size, 2);
  assert.equal(p.tablet.rm.size, 0);
});

test("unreadable page or page map pauses one paper across restart and deselection", async () => {
  for (const problem of ["page", "map"]) {
    const p = await pairedPaper();
    const map = p.tablet.content;
    if (problem === "page") p.tablet.rm.set("p", p.original.slice(0, -1));
    else p.tablet.content = {} as typeof map;
    await (await p.boot()).engine.sync([p.att]);
    const b = await p.boot();
    assert.deepEqual(firstReview(b.doc)[1].choices, ["Retry"]);
    assert.equal(p.items.size, 0);
    p.enable(false);
    await b.engine.sync([p.att]);
    await assert.rejects(resolveFirst(b, p.att, "Retry"));
    p.enable(true);
    p.tablet.rm.set("p", p.original);
    p.tablet.content = map;
    await b.engine.sync([p.att]);
    assert.equal(p.items.size, 0);
    const result = await resolveFirst(b, p.att, "Retry");
    assert.deepEqual(result.errors, []);
    assert.equal(p.items.size, 2);
  }
});

for (const choice of [
  "Keep both",
  "Use tablet version",
  "Use Zotero version",
] as const) {
  test("note conflict across restart: " + choice, async () => {
    const p = await pairedPaper();
    const html = (body: string) =>
      '<div data-schema-version="9"><h1>reMarkable Note 1</h1><p>' +
      body +
      "</p></div>";
    const note = {
      id: 99,
      key: "NOTE",
      parentID: 5,
      libraryID: 1,
      deleted: false,
      html: html("Local edit"),
      isAnnotation: () => false,
      isNote: () => true,
      getTags: () => [],
      getNote() {
        return this.html;
      },
      setNote(v: string) {
        this.html = v;
      },
      getNoteTitle: () => "reMarkable Note 1",
      getAttachments: () => [] as number[],
      saveTx: async () => {},
      addTag: () => {},
    };
    if (choice === "Keep both") {
      note.html = html('<a href="https://example.org">Citation</a>');
      note.getAttachments = () => [25];
    }
    p.items.set("NOTE", note);
    p.host.Zotero.Item = class {
      key = "";
      html = "";
      parentID = 5;
      getNote() {
        return this.html;
      }
      setNote(s: string) {
        this.html = s;
      }
      getNoteTitle() {
        return "reMarkable Note 2";
      }
      getAttachments() {
        return [];
      }
      getTags() {
        return [];
      }
      addTag() {}
      isNote() {
        return true;
      }
      isAnnotation() {
        return false;
      }
      async saveTx() {
        p.items.set(this.key, this);
      }
    };
    Object.assign(p.att, {
      parentID: 5,
      parentItem: {
        getNotes: () =>
          [...p.items.values()].filter((i) => i.isNote()).map((i) => i.key),
        getField: (f: string) => (f === "title" ? "Paper" : ""),
      },
    });
    p.tablet.content = addInsertedPage(p.tablet.content, "note-page", author);
    const bytes = writePageText(
      undefined,
      [{ style: 1, text: "Tablet edit" }],
      { authorUuid: author },
    );
    p.tablet.rm.clear();
    p.tablet.rm.set("note-page", bytes);
    const a = await p.boot();
    a.doc.notePages = {
      "note-page": { base: "Common base", noteKey: "NOTE", owned: true },
    };
    await a.state.save();
    const before = note.html;
    const report = await a.engine.sync([p.att]);
    assert.match(report.errors[0], /review needed/i);
    assert.equal(note.html, before);
    assert.deepEqual(p.tablet.rm.get("note-page"), bytes);
    const b = await p.boot();
    await b.engine.sync([p.att]);
    assert.equal(p.items.size, 1);
    const result = await resolveFirst(b, p.att, choice);
    assert.deepEqual(result.errors, []);
    if (choice === "Keep both") {
      assert.equal(note.html, before);
      assert.deepEqual(note.getAttachments(), [25]);
      assert.equal(p.items.size, 2);
      assert.match(
        p.items.get(b.doc.notePages!["note-page"].noteKey).html,
        /Tablet edit/,
      );
    } else if (choice === "Use tablet version") {
      assert.match(note.html, /Tablet edit/);
      assert.deepEqual(p.tablet.rm.get("note-page"), bytes);
    } else {
      assert.equal(note.html, before);
      assert.match(
        parseRm(p.tablet.rm.get("note-page")!).rootText!.text,
        /Local edit/,
      );
    }
    await (await p.boot()).engine.sync([p.att]);
    assert.equal(p.items.size, choice === "Keep both" ? 2 : 1);
  });
}

test("stale decisions refresh before either side changes", async () => {
  const p = await pairedPaper();
  const b = await p.boot();
  const oldHash = p.tablet.hash;
  rememberReview(b.doc, {
    location: "PDF",
    reason: "Versions differed",
    revision: "displayed",
    tabletHash: oldHash,
    choices: ["Keep both"],
  });
  await b.state.save();
  p.tablet.hash = "newer";
  const restarted = await p.boot();
  const report = await restarted.engine.resolve(
    p.att,
    "document",
    "displayed",
    "Keep both",
  );
  assert.match(report.errors[0], /changed since review/);
  assert.equal(p.items.size, 0);
  assert.deepEqual(p.tablet.rm.get("p"), p.original);
  assert.deepEqual(firstReview((await p.boot()).doc)[1].choices, ["Retry"]);
});

test("a valid tablet page deletion keeps exactly one paired Zotero note across restarts", async () => {
  const p = await pairedPaper();
  const html = "<p>reMarkable Note 1</p><p>Local edits after import</p>";
  const note = {
    key: "NOTE",
    deleted: false,
    parentID: 5,
    getNoteTitle: () => "reMarkable Note 1",
    getNote: () => html,
    isNote: () => true,
    isAnnotation: () => false,
  };
  p.items.set(note.key, note);
  Object.assign(p.att, {
    parentID: 5,
    parentItem: {
      getNotes: () => ["NOTE"],
      getField: (f: string) => (f === "title" ? "Paper" : ""),
    },
  });
  p.tablet.rm.clear();
  const b = await p.boot();
  b.doc.notePages = {
    gone: { noteKey: "NOTE", base: "Before edit", owned: true },
  };
  await b.state.save();
  const result = await b.engine.sync([p.att]);
  assert.deepEqual(result.errors, []);
  assert.match(result.notices[0], /Removed on tablet/);
  await (await p.boot()).engine.sync([p.att]);
  assert.equal(p.items.size, 1);
  assert.equal(note.getNote(), html);
  assert.equal(p.tablet.rm.size, 0);
  assert.equal((await p.boot()).doc.notePages!.gone.removedOnTablet, true);
});

test("changed PDF bytes pause the pairing even when file size and modification time match", async () => {
  const p = await pairedPaper();
  p.host.IOUtils.read = async () => new Uint8Array([3, 2, 1]);
  const state = await p.boot();
  const res = await state.engine.sync([p.att]);
  assert.match(res.errors[0], /PDF/);
  assert.deepEqual(firstReview(state.doc)[1].choices, ["Keep both"]);
  assert.equal(state.doc.rmDocId, "doc");
  assert.deepEqual(p.tablet.rm.get("p"), p.original);
  assert.equal(p.items.size, 0);
});
test("deselecting during PDF read stops local and tablet changes", async () => {
  const p = await pairedPaper();
  const read = p.host.IOUtils.read;
  p.host.IOUtils.read = async (path: string) => {
    p.enable(false);
    return read(path);
  };
  await (await p.boot()).engine.sync([p.att]);
  assert.deepEqual(p.tablet.rm.get("p"), p.original);
  assert.equal(p.items.size, 0);
  p.enable(true);
  p.host.IOUtils.read = read;
  assert.deepEqual((await (await p.boot()).engine.sync([p.att])).errors, []);
});
for (const decision of ["Keep both", "Use tablet version"] as const) {
  test(
    "conflicting typed annotation preserves both versions until " + decision,
    async () => {
      const p = await pairedPaper();
      const page = (text: string) =>
        writePageText(undefined, [{ style: 1, text }], { authorUuid: author });
      p.tablet.rm.set("p", page("Initial"));
      const a = await p.boot();
      await a.engine.sync([p.att]);
      const original = p.items.get(a.doc.imported["p/t"].zoteroKey);
      original.annotationComment = "Local revision";
      const newer = page("Tablet revision");
      p.tablet.rm.set("p", newer);
      p.tablet.hash = "changed";
      const b = await p.boot();
      await b.engine.sync([p.att]);
      assert.ok(firstReview(b.doc));
      assert.equal(original.annotationComment, "Local revision");
      p.fail(true);
      const attempted = await resolveFirst(b, p.att, decision);
      assert.match(attempted.errors[0], /Disk full/);
      assert.equal(p.items.size, 1);
      assert.deepEqual(p.tablet.rm.get("p"), newer);
      p.fail(false);
      const retry = await p.boot();
      const done = await retry.engine.sync([p.att]);
      assert.deepEqual(done.errors, []);
      assert.equal(
        p.items.get(retry.doc.imported["p/t"].zoteroKey).annotationComment,
        "Tablet revision",
      );
      if (decision === "Keep both")
        assert.equal(original.annotationComment, "Local revision");
      await (await p.boot()).engine.sync([p.att]);
      assert.equal(p.items.size, decision === "Keep both" ? 2 : 1);
      assert.deepEqual(p.tablet.rm.get("p"), newer);
    },
  );
}

test("oversized tablet stroke imports every point across linked annotations after a failed part", async () => {
  const p = await pairedPaper(true);
  const count = 12000;
  const points = Buffer.alloc(count * 14);
  for (let i = 0; i < count; i++) {
    points.writeFloatLE(i % 100, i * 14);
    points.writeFloatLE(100 + i / 200, i * 14 + 4);
    points.writeUInt16LE(8, i * 14 + 10);
  }
  const word = (n: number) => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32LE(n);
    return bytes;
  };
  const tagged = (tag: number, bytes: Buffer) =>
    Buffer.concat([Buffer.from([tag]), bytes]);
  const block = (tag: number, data: Buffer) =>
    tagged(tag, Buffer.concat([word(data.length), data]));
  const line = Buffer.concat([
    Buffer.from([3]),
    tagged(0x14, word(2)),
    tagged(0x24, word(0)),
    tagged(0x38, Buffer.alloc(8)),
    tagged(0x44, word(0)),
    block(0x5c, points),
  ]);
  const body = Buffer.concat([
    Buffer.from([31, 1, 1, 47, 1, 2, 63, 0, 0, 79, 0, 0]),
    tagged(0x54, word(0)),
    block(0x6c, line),
  ]);
  const bytes = Buffer.concat([
    Buffer.from(HEADER.padEnd(43)),
    word(body.length),
    Buffer.from([0, 1, 2, 5]),
    body,
  ]);
  p.tablet.rm.set("p", bytes);
  const save = p.host.Zotero.Annotations.saveFromJSON;
  let writes = 0;
  p.host.Zotero.Annotations.saveFromJSON = async (...args: unknown[]) => {
    if (++writes === 2) throw new Error("Disk full");
    return save(...args);
  };
  const first = await p.boot();
  assert.match((await first.engine.sync([p.att])).errors[0], /Disk full/);
  assert.equal(first.doc.pullIncomplete, true);
  p.host.Zotero.Annotations.saveFromJSON = save;
  const restarted = await p.boot();
  assert.deepEqual((await restarted.engine.sync([p.att])).errors, []);
  const prefix = "p/i/1:2";
  const anchor = restarted.doc.imported[prefix].zoteroKey;
  const keys = Object.keys(restarted.doc.imported).sort(
    (a, b) =>
      Number(a.split("/part-")[1] ?? 1) - Number(b.split("/part-")[1] ?? 1),
  );
  assert.ok(keys.length > 1);
  const actual = keys.flatMap((k, i) => {
    const item = p.items.get(restarted.doc.imported[k].zoteroKey);
    if (i) assert.ok(item.related.includes(anchor));
    assert.ok(item.annotationPosition.length <= 65000);
    return JSON.parse(item.annotationPosition).paths[0].slice(i ? 2 : 0);
  });
  const transform = makeTransform({ x: 0, y: 0, width: 612, height: 792 });
  const round = (n: number) => Math.round(n * 1000) / 1000;
  const expected = parseRm(bytes).lines[0].points.flatMap((pt) => [
    round(transform.x(pt.x)),
    round(transform.y(pt.y)),
  ]);
  assert.deepEqual(actual, expected);
  assert.deepEqual(p.tablet.rm.get("p"), bytes);
  await (await p.boot()).engine.sync([p.att]);
  assert.equal(p.items.size, keys.length);
});
