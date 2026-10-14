// Follows a windhawk:// link forwarded to the running app: the shell brings the
// window to the front and emits the link, and this navigates the router to it.
// It renders beside RouterProvider rather than under it, so it is handed the
// router itself; useNavigate is out of reach there.
//
// Rendered only in the Tauri build (the link comes from the native shell); see
// Panel.tsx.

import { useEffect } from 'react';
import type { RouterProviderProps } from 'react-router-dom';
import { deepLinkToRoute } from '@app/deepLink';
import { listenDeepLink, type UnlistenFn } from '@app/tauriApi';

function DeepLinkNavigator({
  router,
}: {
  router: RouterProviderProps['router'];
}) {
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;
    listenDeepLink((link) => {
      void router.navigate(deepLinkToRoute(link));
    })?.then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [router]);

  return null;
}

export default DeepLinkNavigator;
