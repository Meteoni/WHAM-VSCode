import { copyTextToClipboard } from '@app/utils';
import { useCallback, useEffect, useState } from 'react';

// How long a copy is said to have happened for.
export const COPIED_FEEDBACK_MS = 1500;

/**
 * A copy to the clipboard that says so for a moment: `copied` is up for
 * COPIED_FEEDBACK_MS after a copy the command reported done, for the control
 * that ran it to show. Like the command, `copy` has to be called from a user
 * gesture.
 */
export function useCopyToClipboard() {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = window.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = useCallback((text: string) => {
    if (copyTextToClipboard(text)) {
      setCopied(true);
    }
  }, []);

  return { copied, copy };
}

export default useCopyToClipboard;
