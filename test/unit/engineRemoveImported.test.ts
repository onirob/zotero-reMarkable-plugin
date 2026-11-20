import assert from "node:assert/strict";
import { test } from "node:test";
import type { DocState } from "../../src/sync/state";
import {
  FakeTablet,
  diskState,
  fakeAttachment,
  installGlobals,
  makeEngine,
  makeState,
  memoryIO,
} from "./engineHarness";

const LIB = 1;
const ATT = "ATTKEY01";

function trackedDoc(): DocState {
  return {
    attachmentKey: ATT,
    libraryID: LIB,
    rmDocId: "rm-doc",
    originalPageCount: 1,
    appendedPageCount: 0,
    pageBoxes: [],
    rmDocHash: "hash-1",
    imported: {
      "p1:a": { zoteroKey: "IMPORTED", hash: "h1", kind: "annotation" },
    },
    detachedImported: ["DETACHED"],
  };
}

/** Engine over a saved state with imported, detached and registry keys. */
async function setup() {
  const z = installGlobals();
  // The user's own objects must never be touched.
  for (const key of ["IMPORTED", "DETACHED", "REGISTRY", "USER_ANNOT"])
    z.addItem(LIB, key);
  const io = memoryIO();
  const seed = makeState(io);
  await seed.load();
  seed.set(trackedDoc());
  seed.addDetached(LIB, ATT, ["REGISTRY"]);
  // A second attachment with its own registry key that must stay.
  seed.addDetached(LIB, "OTHERATT", ["OTHER_REGISTRY"]);
  z.addItem(LIB, "OTHER_REGISTRY");
  await seed.save();
  const state = makeState(io);
  const engine = makeEngine({ cloud: new FakeTablet().cloud(), state });
  const att = fakeAttachment({
    key: ATT,
    path: "/x.pdf",
    title: { value: "t" },
  });
  return { z, io, state, engine, att };
}

test("cleanup preserves legacy imports with unverified ownership and content", async () => {
  const { z, engine, att } = await setup();
  assert.equal(await engine.removeImported([att]), 0);
  assert.deepEqual(z.erased, []);
});
test("reimport invalidates conversion in place and preserves both keys and objects", async () => {
  const { z, engine, att, io } = await setup();
  await engine.removeImported([att], true);
  const doc = diskState(io).docs[`${LIB}/${ATT}`];
  assert.deepEqual(doc.imported, trackedDoc().imported);
  assert.equal(doc.pullIncomplete, true);
  assert.deepEqual(z.erased, []);
});
