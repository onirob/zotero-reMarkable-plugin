import type { DocState } from "./state";

export type ReviewChoice =
  | "Keep both"
  | "Use tablet version"
  | "Use Zotero version"
  | "Retry";

export interface SyncReview {
  location: string;
  pageId?: string;
  reason: string;
  tablet?: string;
  zotero?: string;
  revision: string;
  choices: ReviewChoice[];
  decision?: ReviewChoice;
  /** Snapshots to verify again before executing a saved choice. */
  tabletHash?: string;
  localKey?: string;
  localHash?: string;
}

export class ReviewNeeded extends Error {
  constructor(readonly review: SyncReview) {
    super(
      `${review.choices.includes("Retry") ? "Review needed" : "Conflict — review needed"} · ${review.location} · ${review.reason}`,
    );
  }
}

export function unreadable(location: string, reason: string): never {
  throw new ReviewNeeded({
    location,
    reason,
    revision: reason,
    choices: ["Retry"],
  });
}

/** Decisions apply only to the two snapshots actually presented to the user. */
export function decisionFor(
  previous: SyncReview | undefined,
  current: SyncReview,
) {
  for (const side of ["tablet", "zotero"] as const) {
    const value = current[side];
    if (value && value.length > 4000)
      current[side] = value.slice(0, 4000) + "… (preview shortened)";
  }
  if (
    previous?.location === current.location &&
    previous.revision === current.revision &&
    previous.decision &&
    current.choices.includes(previous.decision)
  )
    return previous.decision;
  throw new ReviewNeeded(current);
}

/** Separate scopes allow writes on other pages while retaining each decision. */
export function reviewId(review: Pick<SyncReview, "location" | "pageId">) {
  return review.pageId === undefined
    ? "document"
    : JSON.stringify([review.pageId, review.location]);
}

export function reviewEntries(doc: DocState) {
  return Object.entries(doc.reviews ?? {});
}

export function rememberReview(doc: DocState, review: SyncReview) {
  doc.reviews ??= {};
  doc.reviews[reviewId(review)] = review;
}

export function forgetReview(
  doc: DocState,
  review: Pick<SyncReview, "location" | "pageId">,
) {
  if (doc.reviews) delete doc.reviews[reviewId(review)];
}

export function pageBlocked(doc: DocState, pageId: string) {
  return reviewEntries(doc).some(
    ([, review]) => review.pageId === pageId && review.decision !== "Retry",
  );
}

export function pageDecision(
  doc: DocState,
  current: SyncReview,
  legacyRevision?: string,
) {
  const previous = doc.reviews?.[reviewId(current)];
  // Legacy decisions used the whole document hash. Retain a decision only
  // when that original, stricter snapshot still matches.
  const comparable =
    previous && previous.revision === legacyRevision
      ? { ...previous, revision: current.revision }
      : previous;
  try {
    return decisionFor(comparable, current);
  } catch (error) {
    if (!(error instanceof ReviewNeeded)) throw error;
    rememberReview(doc, current);
    return undefined;
  }
}

export function pageUnreadable(doc: DocState, pageId: string, reason: string) {
  const review = {
    pageId,
    location: "Page " + pageId,
    reason,
    revision: reason,
    choices: ["Retry"] as ReviewChoice[],
  };
  rememberReview(doc, review);
}

export function pageReadable(doc: DocState, pageId: string) {
  for (const [, review] of reviewEntries(doc)) {
    if (
      review.pageId === pageId &&
      review.location === `Page ${pageId}` &&
      review.decision === "Retry"
    )
      forgetReview(doc, review);
  }
}

export function refreshMissingReview(
  doc: DocState,
  pageId: string,
  location: string,
) {
  const target = { pageId, location };
  const previous = doc.reviews?.[reviewId(target)];
  if (!previous) return;
  if (previous.decision === "Retry") forgetReview(doc, target);
  else
    rememberReview(doc, {
      ...target,
      reason:
        "This item no longer matches the conflict. Retry to refresh the page without applying the old choice.",
      revision: "refresh:" + previous.revision.replace(/^refresh:/, ""),
      choices: ["Retry"],
    });
}
