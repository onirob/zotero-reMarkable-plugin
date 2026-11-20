import assert from "node:assert/strict";
import { test } from "node:test";
import { splitInk, POSITION_MAX } from "../../src/sync/inkFit";

/** A stroke of `n` points with realistic coordinate widths. */
function stroke(n: number, seed = 0): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++)
    out.push(
      Math.round((100 + i * 0.37 + seed) * 1000) / 1000,
      Math.round((200 + Math.sin(i) * 50 + seed) * 1000) / 1000,
    );
  return out;
}
const len = (v: unknown) => JSON.stringify(v).length;

test("linked positions retain every point in an oversized stroke", () => {
  const path = stroke(18000);
  const parts = splitInk({ pageIndex: 3, width: 2, paths: [path] });
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => len(p) <= POSITION_MAX && p.pageIndex === 3));
  assert.deepEqual(
    parts.flatMap((p, i) => p.paths[0].slice(i ? 2 : 0)),
    path,
  );
});
test("retains short strokes that cross annotation boundaries", () => {
  const paths = Array.from({ length: 2000 }, (_, i) => stroke(1, i));
  const parts = splitInk({ paths }, 300);
  assert.deepEqual(
    parts.flatMap((p) => p.paths),
    paths,
  );
  assert.ok(parts.every((p) => len(p) <= 300));
});
