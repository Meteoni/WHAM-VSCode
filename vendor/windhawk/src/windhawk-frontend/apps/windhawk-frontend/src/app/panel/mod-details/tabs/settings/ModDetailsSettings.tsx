import { type InitialSettings } from '@app/webviewIPCMessages';
/// #if WEBSITE
import { ModDetailsSettingsWebsite } from './ModDetailsSettings.Website';
/// #else
import { ModDetailsSettingsApp } from './ModDetailsSettings.App';
/// #endif

interface Props {
  modId: string;
  initialSettings: InitialSettings;
  readOnly?: boolean;
  onCanNavigateAwayChange?: (canNavigateAway: () => Promise<boolean>) => void;
}

declare const WEBPACK_IS_WEBSITE: boolean;

function ModDetailsSettings(props: Props) {
  return WEBPACK_IS_WEBSITE
    ? <ModDetailsSettingsWebsite {...props} />
    : <ModDetailsSettingsApp {...props} />;
}

export default ModDetailsSettings;
