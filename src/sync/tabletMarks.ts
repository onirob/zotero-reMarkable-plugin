import type { SceneMark } from "../remarkable/rmwrite";
import {
  isEraser,
  isHighlighter,
  isShader,
  type RmPage,
} from "../remarkable/rmscene";
import { makeTransform } from "./convert";
import {
  type EditableMark,
  roundMark,
  validEditableMark,
} from "./editableMarks";
import type { PageBox } from "./types";

const colorTable: Record<number, string> = {
  0: "#000000",
  1: "#909090",
  2: "#ffffff",
  3: "#fbf719",
  4: "#77c197",
  5: "#ffb1cb",
  6: "#5c81ff",
  7: "#d41f25",
  9: "#ffed75",
  10: "#beeaFE",
  11: "#b0e0a8",
  12: "#f29ef0",
  13: "#f7e851",
};
const pdfScale = 72 / 226;
const widthScale = 0.0945;

export function tabletMarks(scene: RmPage, page: number, box: PageBox) {
  const transform = makeTransform(box);
  const marks = new Map<string, EditableMark>();
  const color = (item: RmPage["glyphs"][number] | RmPage["lines"][number]) => {
    if (item.rgba)
      return (
        "#" +
        [item.rgba.r, item.rgba.g, item.rgba.b]
          .map((value) => value.toString(16).padStart(2, "0"))
          .join("")
      );
    return (colorTable[item.color] ?? "#000000").toLowerCase();
  };
  function include(id: string, mark: EditableMark) {
    if (marks.has(id) || !validEditableMark(mark))
      throw new Error("Ambiguous tablet drawing");
    marks.set(id, mark);
  }
  for (const glyph of scene.glyphs) {
    if (!glyph.rects.length) continue;
    include(glyph.id, {
      page,
      kind: "highlight",
      color: color(glyph),
      width: 0,
      paths: glyph.rects.map((rect) => [
        roundMark(transform.x(rect.x)),
        roundMark(transform.y(rect.y + rect.h)),
        roundMark(transform.x(rect.x + rect.w)),
        roundMark(transform.y(rect.y)),
      ]),
    });
  }
  for (const line of scene.lines) {
    if (isEraser(line.tool))
      throw new Error("A tablet eraser operation could not be reconstructed");
    if (!line.points.length) continue;
    const points = line.points.flatMap((point) => [
      roundMark(transform.x(point.x)),
      roundMark(transform.y(point.y)),
    ]);
    // Anything outside the printable area remains in the existing margin-note flow.
    if (
      line.points.some(
        (point) =>
          !transform.inside(transform.x(point.x), transform.y(point.y)),
      )
    )
      continue;
    const width = Math.max(
      0.2,
      roundMark(
        (line.points.reduce((sum, point) => sum + point.width, 0) /
          line.points.length) *
          widthScale,
      ),
    );
    if (isHighlighter(line.tool) || isShader(line.tool)) {
      const px = points.filter((_, i) => i % 2 === 0);
      const py = points.filter((_, i) => i % 2 !== 0);
      const pad = width / 2;
      include(line.id, {
        page,
        kind: "highlight",
        color: color(line),
        width: 0,
        paths: [
          [
            roundMark(px.reduce((a, b) => Math.min(a, b), Infinity) - pad),
            roundMark(py.reduce((a, b) => Math.min(a, b), Infinity) - pad),
            roundMark(px.reduce((a, b) => Math.max(a, b), -Infinity) + pad),
            roundMark(py.reduce((a, b) => Math.max(a, b), -Infinity) + pad),
          ],
        ],
      });
    } else
      include(line.id, {
        page,
        kind: "ink",
        color: color(line),
        width,
        paths: [points],
      });
  }
  return marks;
}

export function toSceneMark(mark: EditableMark, box: PageBox): SceneMark[] {
  const x = (pdf: number) => (pdf - box.x - box.width / 2) / pdfScale;
  const y = (pdf: number) => (box.y + box.height - pdf) / pdfScale;
  const rgba = (0xff000000 | parseInt(mark.color.slice(1), 16)) >>> 0;
  const palette = Object.entries(colorTable).map(([id, val]) => {
    const rgb = [1, 3, 5].map((i) => parseInt(val.slice(i, i + 2), 16));
    const difference = rgb.reduce(
      (sum, c, i) =>
        sum + (c - parseInt(mark.color.slice(1 + 2 * i, 3 + 2 * i), 16)) ** 2,
      0,
    );
    return [Number(id), difference];
  });
  const color = palette.sort((a, b) => a[1] - b[1])[0][0];
  if (mark.kind === "ink")
    return mark.paths.map((path) => ({
      kind: "ink",
      color,
      rgba,
      width: Math.min(65535, Math.max(2, Math.round(mark.width / widthScale))),
      points: path.map((coordinate, i) =>
        i % 2 ? y(coordinate) : x(coordinate),
      ),
    }));
  return [
    {
      kind: "highlight",
      color,
      rgba,
      rects: mark.paths.map(([x1, y1, x2, y2]) => ({
        x: x(x1),
        y: y(y2),
        w: (x2 - x1) / pdfScale,
        h: (y2 - y1) / pdfScale,
      })),
    },
  ];
}

export function combineTabletMarks(marks: EditableMark[]) {
  const [first] = marks;
  if (!first) return undefined;
  if (
    marks.some(
      (mark) =>
        mark.page !== first.page ||
        mark.kind !== first.kind ||
        mark.color !== first.color,
    )
  )
    throw new Error("A tablet annotation was split across incompatible marks");
  return { ...first, paths: marks.flatMap((mark) => mark.paths) };
}
