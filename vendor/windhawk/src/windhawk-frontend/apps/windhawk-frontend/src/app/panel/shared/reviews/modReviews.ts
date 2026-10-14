/**
 * A mod's reviews as the pages site publishes them, and the reading rules both
 * surfaces (the card's popover and the reviews modal) apply to them.
 *
 * The document is `https://mods.windhawk.net/reviews/<mod-id>.json`: every
 * approved review of the mod in one flat list, a review being a review with
 * no parent and a reply one whose parent is a review in the same list. The
 * server's vote count is what the file carries; what the user sees adds their
 * own vote as the host holds it (effectiveVotes), since the server learns of it
 * with the next update check and shows it a deploy later.
 */

import type { ModReviewVote } from '@app/webviewIPCMessages';

export type ModReview = {
  // The server's row id, never reused, which is what a vote names.
  id: number;
  // Null for a review; a review's id for a reply.
  parentId: number | null;
  // Unix seconds.
  timestamp: number;
  authorName: string;
  modVersion: string | null;
  // The text as posted, with `\n` line breaks.
  content: string;
  votes: number;
};

export type ModReviewsDocument = {
  modId: string;
  // In ascending id.
  reviews: ModReview[];
};

export type ReviewThread = {
  review: ModReview;
  // In posting order.
  replies: ModReview[];
};

// How long the user's own vote is counted on top of the server's number; past
// it, the server's number is taken to hold the vote.
const OWN_VOTE_SECONDS = 12 * 60 * 60;

export function findVote(
  votes: ModReviewVote[],
  reviewId: number
): ModReviewVote | undefined {
  return votes.find((vote) => vote.reviewId === reviewId);
}

export function isVoted(votes: ModReviewVote[], reviewId: number): boolean {
  return findVote(votes, reviewId) !== undefined;
}

// How long after its click a vote can be taken back, by the modal that cast
// it. The host keeps no such clock: it removes a vote whenever asked to.
export const VOTE_UNDO_WINDOW_MS = 60_000;

export function isVoteUndoable(castAtMs: number, nowMs: number): boolean {
  return nowMs - castAtMs < VOTE_UNDO_WINDOW_MS;
}

/**
 * The vote count drawn for a review: the server's, plus the user's own vote
 * while the server is assumed not to have counted it yet, and never zero under
 * a voted mark whatever the server says.
 */
export function effectiveVotes(
  review: ModReview,
  localVote: ModReviewVote | undefined,
  nowSeconds: number
): number {
  let effective = review.votes;
  if (localVote) {
    if (nowSeconds - localVote.timestamp < OWN_VOTE_SECONDS) {
      effective += 1;
    }
    if (effective === 0) {
      effective = 1;
    }
  }
  return effective;
}

// How the reviews are ordered: by effective votes, the newest first among
// equals, or by date alone.
export type ReviewOrder = 'top' | 'newest';

/**
 * The reviews with their replies under them, in the given order; replies in
 * posting order. A reply whose review is not in the document has nowhere to
 * go and is dropped.
 */
export function groupThreads(
  document: ModReviewsDocument,
  votes: ModReviewVote[],
  nowSeconds: number,
  order: ReviewOrder = 'top'
): ReviewThread[] {
  const threads = new Map<number, ReviewThread>();
  for (const review of document.reviews) {
    if (review.parentId === null) {
      threads.set(review.id, { review: review, replies: [] });
    }
  }
  for (const review of document.reviews) {
    if (review.parentId !== null) {
      threads.get(review.parentId)?.replies.push(review);
    }
  }

  const rank = (review: ModReview) =>
    order === 'top'
      ? effectiveVotes(review, findVote(votes, review.id), nowSeconds)
      : 0;
  return [...threads.values()]
    .map((thread) => ({
      ...thread,
      replies: [...thread.replies].sort((a, b) => a.timestamp - b.timestamp),
    }))
    .sort(
      (a, b) =>
        rank(b.review) - rank(a.review) ||
        b.review.timestamp - a.review.timestamp
    );
}

export function topReview(
  document: ModReviewsDocument,
  votes: ModReviewVote[],
  nowSeconds: number
): ModReview | null {
  return groupThreads(document, votes, nowSeconds)[0]?.review ?? null;
}

// What a post sends, before and after normalization.
export type ReviewPostFields = {
  modId: string;
  authorName: string;
  authorEmail: string;
  content: string;
  parentId?: number;
  modVersion?: string;
};

export type ReviewPostField = 'authorName' | 'authorEmail' | 'content' | 'modVersion';

export type ReviewPostProblem = {
  field: ReviewPostField;
  // A key under `mod.reviews.form`.
  messageKey: string;
};

export const NAME_MAX = 100;
const EMAIL_MIN = 3;
export const EMAIL_MAX = 254;
const VERSION_MAX = 50;
export const CONTENT_MAX = 5000;
const CONTENT_MIN_WORDS = 5;

// Counted as the server counts them, in characters rather than UTF-16 units.
const length = (text: string) => [...text].length;

// Built on first use rather than at load, so a browser without the API can
// still show the reviews; null once it is known to be missing.
let wordSegmenter: Intl.Segmenter | null | undefined;

// The words in the text as the segmenter reads them: by dictionary in a script
// written without spaces, so a Chinese or Thai review counts as it reads;
// punctuation and emoji count for none. Without a segmenter, the runs between
// whitespace.
function countWords(text: string): number {
  if (wordSegmenter === undefined) {
    wordSegmenter =
      typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter(undefined, { granularity: 'word' })
        : null;
  }
  if (wordSegmenter === null) {
    return text.split(/\s+/).filter(Boolean).length;
  }
  let count = 0;
  for (const { isWordLike } of wordSegmenter.segment(text)) {
    if (isWordLike) {
      count++;
    }
  }
  return count;
}

// Whether the text holds a C0 control or DEL, `\n` and `\t` excepted.
function hasForbiddenControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code < 0x20 && code !== 0x0a && code !== 0x09) || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * The fields as they are sent: every string trimmed, the content's `\r\n`
 * folded to `\n`, and an empty optional left out.
 */
export function normalizeReviewPost(fields: ReviewPostFields): ReviewPostFields {
  const normalized: ReviewPostFields = {
    modId: fields.modId,
    authorName: fields.authorName.trim(),
    authorEmail: fields.authorEmail.trim(),
    content: fields.content.replace(/\r\n/g, '\n').trim(),
  };
  if (fields.parentId !== undefined) {
    normalized.parentId = fields.parentId;
  }
  const modVersion = fields.modVersion?.trim();
  if (modVersion) {
    normalized.modVersion = modVersion;
  }
  return normalized;
}

/**
 * The server's own rules, applied before a request is made so a post it would
 * refuse never spends a rate-limit slot, and one of the client's: a post of
 * fewer than five words, which says no more than the stars and the votes do.
 * The first failing field, or null when the post can go. Judged over the
 * normalized fields, which is what is sent.
 */
export function validateReviewPost(fields: ReviewPostFields): ReviewPostProblem | null {
  const { authorName, authorEmail, content, modVersion } = normalizeReviewPost(fields);

  if (authorName.length === 0) {
    return { field: 'authorName', messageKey: 'nameRequired' };
  }
  if (length(authorName) > NAME_MAX) {
    return { field: 'authorName', messageKey: 'nameTooLong' };
  }

  const at = authorEmail.indexOf('@');
  if (
    length(authorEmail) < EMAIL_MIN ||
    length(authorEmail) > EMAIL_MAX ||
    at < 1 ||
    at !== authorEmail.lastIndexOf('@') ||
    at === authorEmail.length - 1 ||
    /\s/.test(authorEmail)
  ) {
    return { field: 'authorEmail', messageKey: 'emailInvalid' };
  }

  if (modVersion !== undefined && length(modVersion) > VERSION_MAX) {
    return { field: 'modVersion', messageKey: 'failed' };
  }

  if (content.length === 0) {
    return { field: 'content', messageKey: 'contentRequired' };
  }
  if (length(content) > CONTENT_MAX) {
    return { field: 'content', messageKey: 'contentTooLong' };
  }
  if (hasForbiddenControl(content)) {
    return { field: 'content', messageKey: 'contentInvalid' };
  }
  if (countWords(content) < CONTENT_MIN_WORDS) {
    return { field: 'content', messageKey: 'contentTooShort' };
  }

  return null;
}
