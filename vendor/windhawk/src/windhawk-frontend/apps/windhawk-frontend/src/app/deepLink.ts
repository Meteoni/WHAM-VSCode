// The route a windhawk:// link lands on. The shell parses the URL and hands the
// page the parsed link (tauriApi.ts); this is the one place that turns it into a
// path, so the cold-start seed (Panel.tsx) and the warm-path navigation
// (DeepLinkNavigator.tsx) agree.

import { MODS_PATH } from '@app/panel/mods-browser/modsPath';
import type { DeepLink } from '@app/tauriApi';

// A mod link opens the ONLINE browser's page for the mod whether or not it is
// installed: that page reflects the installed state, and it is what the website
// address the link mirrors means.
export function deepLinkToRoute(link: DeepLink): string {
  return `${MODS_PATH}/${link.modId}`;
}
