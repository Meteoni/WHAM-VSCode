/// #if WEBSITE
import { ModDetailsWebsite } from './ModDetails.Website';
/// #else
import { ModDetailsApp } from './ModDetails.App';
/// #endif
// The app variant owns the props both variants are given: it is the one
// that reads all of them. A type import brings no module with it, so the website
// build carries none of its code.
import type { ModDetailsAppProps, RepositoryModDetails } from './ModDetails.App';

interface Props {
  modId: string;
  repositoryModDetails?: RepositoryModDetails;
  // Absent for an owner that shows the mod as the whole of its screen, leaving
  // nowhere for the way back to lead.
  goBack?: () => void;

  // App-specific props (all grouped together)
  appProps?: ModDetailsAppProps;
}

declare const WEBPACK_IS_WEBSITE: boolean;

function ModDetails(props: Props) {
  return WEBPACK_IS_WEBSITE
    ? <ModDetailsWebsite {...props} />
    : <ModDetailsApp {...props} />;
}

export default ModDetails;
