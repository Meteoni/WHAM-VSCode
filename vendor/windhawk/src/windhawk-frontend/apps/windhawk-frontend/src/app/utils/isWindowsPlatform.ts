// What the platform check reads off the browser. `userAgentData` is Chromium's
// client hints API, which the DOM typings leave out and Firefox and Safari do
// not have.
export type PlatformNavigator = {
  userAgent: string;
  userAgentData?: { platform?: string };
};

/**
 * Whether the page is being viewed on Windows: the client hint where the
 * browser gives one, the user-agent string's "Windows NT" otherwise.
 */
export function isWindowsPlatform(nav: PlatformNavigator = navigator): boolean {
  return (
    nav.userAgentData?.platform === 'Windows' || /Windows NT/.test(nav.userAgent)
  );
}
