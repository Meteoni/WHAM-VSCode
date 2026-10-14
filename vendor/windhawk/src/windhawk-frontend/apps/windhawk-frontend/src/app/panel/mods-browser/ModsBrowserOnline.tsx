/// #if WEBSITE
import { ModsBrowserOnlineWebsite } from './ModsBrowserOnline.Website';
/// #else
import { ModsBrowserOnlineApp } from './ModsBrowserOnline.App';
/// #endif

interface Props {
  ContentWrapper: React.ComponentType<
    React.ComponentPropsWithoutRef<'div'> & { $hidden?: boolean }
  >;
}

declare const WEBPACK_IS_WEBSITE: boolean;

function ModsBrowserOnline(props: Props) {
  return WEBPACK_IS_WEBSITE
    ? <ModsBrowserOnlineWebsite {...props} />
    : <ModsBrowserOnlineApp {...props} />;
}

export default ModsBrowserOnline;
