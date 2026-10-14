/**
 * A link to a mod's page on windhawk.net: the page's address, and the mod a
 * link a readme carries names.
 */

// The site's host. The www one redirects to the bare one, as http does to
// https, so a link written either way lands on the same page.
const MOD_PAGE_HOST = 'windhawk.net';
const MOD_PAGE_HOSTS = [MOD_PAGE_HOST, `www.${MOD_PAGE_HOST}`];

// The page's path under the site: the mod's id, which is non-empty and drawn
// from 0-9, a-z and '-' (the grammar the windhawk:// links take too). A
// trailing slash is accepted; a query or a fragment is not part of the path
// and is ignored.
const MOD_PAGE_PATH = /^\/mods\/([0-9a-z-]+)\/?$/;

/**
 * The address of the mod's page on windhawk.net.
 */
export function getModPageUrl(modId: string): string {
  return `https://${MOD_PAGE_HOST}/mods/${modId}`;
}

/**
 * The id of the mod whose page on windhawk.net the href names, or undefined
 * for any other href.
 */
export function getModLinkId(href: string): string | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }

  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    !MOD_PAGE_HOSTS.includes(url.host)
  ) {
    return undefined;
  }

  return MOD_PAGE_PATH.exec(url.pathname)?.[1];
}
