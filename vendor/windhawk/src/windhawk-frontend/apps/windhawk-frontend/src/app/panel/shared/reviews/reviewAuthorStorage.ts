import { readStoredValue, writeStoredValue } from '@app/utils';

// The name and email the user last posted a review under, kept in the
// webview's own storage so a second post does not retype them. Best effort:
// storage closed to the app reads as nothing remembered.
const COMMENT_AUTHOR_KEY = 'windhawk-review-author';

export type ReviewAuthor = { name: string; email: string };

export function readReviewAuthor(): ReviewAuthor | null {
  const stored = readStoredValue(COMMENT_AUTHOR_KEY);
  if (!stored) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(stored);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as ReviewAuthor).name === 'string' &&
      typeof (parsed as ReviewAuthor).email === 'string'
    ) {
      const { name, email } = parsed as ReviewAuthor;
      return { name, email };
    }
  } catch {
    // Text that is not the author is nothing remembered.
  }
  return null;
}

export function writeReviewAuthor(author: ReviewAuthor): void {
  writeStoredValue(COMMENT_AUTHOR_KEY, JSON.stringify(author));
}
