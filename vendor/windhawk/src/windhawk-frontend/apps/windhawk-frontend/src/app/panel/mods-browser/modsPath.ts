// Use webpack constant for conditional compilation
declare const WEBPACK_IS_WEBSITE: boolean;

// The online mods browser's route; a mod's page under it is `${MODS_PATH}/${modId}`.
// The website serves it at /mods (mirroring https://windhawk.net/mods/<id>), the
// app build at /mods-browser.
export const MODS_PATH = WEBPACK_IS_WEBSITE ? '/mods' : '/mods-browser';

// The location state a mod's page is opened with from another page of the app
// - a link in a mod's readme - which is what tells its back arrow to go back
// through the history rather than to the list.
export const MOD_PAGE_FROM_APP_STATE = { fromApp: true };

export function isModPageFromApp(state: unknown): boolean {
  return (state as { fromApp?: unknown } | null)?.fromApp === true;
}
