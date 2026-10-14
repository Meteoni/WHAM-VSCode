import { useCallback, useEffect, useRef, useState } from 'react';

// How long a launch gets to take the foreground before it is judged not to have
// happened. A starting point rather than a defended constant: a longer window
// trades a slow machine's false "not installed" against a longer wait for the
// real one.
export const LAUNCH_WINDOW_MS = 2500;

/**
 * The website's "Open in Windhawk": the windhawk://mods/<id> link for the mod,
 * and what watching a click on it makes of the launch.
 *
 * No browser API says whether a scheme has a handler, so the click is watched
 * instead. The link is the anchor's own `href`, followed by the browser as the
 * click's default action, which the hook leaves alone (an external scheme
 * leaves the document in place). `open`, called from that click, arms a window
 * in which losing the foreground - to the app, or to the browser's own "Open
 * Windhawk?" prompt - means the launch happened, and nothing more is said. Only
 * the window running out sets `notInstalled`; `pending` is up in between. A
 * later click starts over.
 */
export function useOpenInWindhawk(modId: string) {
  const [pending, setPending] = useState(false);
  const [notInstalled, setNotInstalled] = useState(false);
  // Takes down the watch of the click in flight, if there is one.
  const settle = useRef<(() => void) | null>(null);

  useEffect(() => () => settle.current?.(), []);

  const open = useCallback(() => {
    settle.current?.();

    const stop = () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('blur', stop);
      window.removeEventListener('pagehide', stop);
      settle.current = null;
      setPending(false);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        stop();
      }
    };
    const timer = window.setTimeout(() => {
      stop();
      setNotInstalled(true);
    }, LAUNCH_WINDOW_MS);

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('blur', stop);
    window.addEventListener('pagehide', stop);
    settle.current = stop;
    setNotInstalled(false);
    setPending(true);
  }, []);

  return { href: `windhawk://mods/${modId}`, open, pending, notInstalled };
}

export default useOpenInWindhawk;
