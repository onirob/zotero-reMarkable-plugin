import type { PageBox } from "./types";

/** Coordinates are in PDF user space. Comments and authors belong to the PDF. */
export interface EditableMark {
  page: number;
  kind: "ink" | "highlight";
  color: string;
  paths: number[][];
  width: number;
  comment?: string;
  author?: string;
}

export interface MarkLink {
  id: string;
  native: string[];
  /** Layer IDs aligned with native stroke IDs, when saved by a recent sync. */
  nativeLayers?: string[];
  pdf: EditableMark;
  tablet: EditableMark;
}

export const PAGE_BASE_VERSION = 3;
export type PageBaselineVersion = 1 | 2 | typeof PAGE_BASE_VERSION;
export type StoredPageBaselineVersion = Exclude<PageBaselineVersion, 1>;

export interface EditableState {
  base?: string;
  baseVersion?: StoredPageBaselineVersion;
  /** Keep the tablet PDF export fingerprint stable across page-hash migrations. */
  uploadBase?: string;
  pageIds?: string[];
  links: MarkLink[];
  erased: EditableMark[];
  pending?: MarkTransaction;
  restore?: EditableMark;
  refreshAnnotations?: boolean;
  lastPdfRecovery?: string;
}

export interface MarkTransaction {
  id: string;
  beforePdf: string;
  afterPdf: string;
  observedPages: Record<string, string>;
  pages: { id: string; hash: string; before: string }[];
  beforeTabletPdf?: string;
  beforeContentHash?: string;
  afterContentHash?: string;
  tabletPdfHash?: string;
  tabletContent?: unknown;
  base: string;
  baseVersion?: StoredPageBaselineVersion;
  pageIds: string[];
  links: MarkLink[];
  erased: EditableMark[];
  resolved: string[];
  restoreApplied?: boolean;
  wholePdf?: {
    beforePath: string;
    beforeDocument: string;
    pageBoxes: PageBox[];
    appendedPageCount: number;
    retiredPages: string[];
    backupManifest: string;
  };
}

export const roundMark = (n: number) => Math.round(n * 1000) / 1000;

export function markSignature(
  mark: EditableMark | undefined,
  includeMetadata = true,
) {
  if (!mark) return "";
  return JSON.stringify([
    mark.page,
    mark.kind,
    mark.color,
    mark.width,
    mark.paths.map((path) => path.map(roundMark)),
    ...(includeMetadata ? [mark.comment, mark.author] : []),
  ]);
}

export function samePaths(
  first: EditableMark,
  second: EditableMark,
  tolerance = 0.002,
) {
  return (
    first.page === second.page &&
    first.kind === second.kind &&
    first.paths.length === second.paths.length &&
    first.paths.every(
      (path, i) =>
        path.length === second.paths[i].length &&
        path.every(
          (value, j) => Math.abs(value - second.paths[i][j]) <= tolerance,
        ),
    )
  );
}

/** Retain both snapshots because a tablet may quantize width and positions. */
export function compareMark(
  link: MarkLink,
  pdf?: EditableMark,
  tablet?: EditableMark,
) {
  if (!pdf && !tablet) return "pdf";
  const pChanged = markSignature(pdf) !== markSignature(link.pdf);
  const tChanged = markSignature(tablet) !== markSignature(link.tablet);
  if (
    pChanged &&
    tChanged &&
    (markSignature(pdf, false) !== markSignature(tablet, false) ||
      pdf?.comment !== link.pdf.comment ||
      pdf?.author !== link.pdf.author)
  )
    return "conflict";
  return pChanged ? "pdf" : tChanged ? "tablet" : "same";
}

export function validEditableMark(mark: EditableMark) {
  return (
    !!mark &&
    Number.isSafeInteger(mark.page) &&
    mark.page >= 0 &&
    (mark.kind === "ink" || mark.kind === "highlight") &&
    /^#[a-f0-9]{6}$/.test(mark.color) &&
    Number.isFinite(mark.width) &&
    mark.width >= 0 &&
    (mark.comment === undefined ||
      (typeof mark.comment === "string" && mark.comment.length <= 100000)) &&
    (mark.author === undefined ||
      (typeof mark.author === "string" && mark.author.length <= 10000)) &&
    Array.isArray(mark.paths) &&
    mark.paths.length > 0 &&
    mark.paths.every(
      (path) =>
        Array.isArray(path) &&
        path.every((n) => Number.isFinite(n) && Math.abs(n) < 1000000) &&
        (mark.kind === "ink"
          ? path.length >= 2 && path.length % 2 === 0
          : path.length === 4 && path[0] < path[2] && path[1] < path[3]),
    )
  );
}
