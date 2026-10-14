import {
  faArrowUpRightFromSquare,
  faCheck,
  faShareNodes,
} from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Button, Tooltip } from 'antd';
import { useTranslation } from 'react-i18next';
import styled from 'styled-components';
import { useCopyToClipboard } from '@app/panel/shared/useCopyToClipboard';
import { getModPageUrl } from './modLinkId';

const ModPageButtonsWrapper = styled.div`
  display: flex;
`;

const PageButton = styled(Button)`
  color: var(--whui-text-secondary);
`;

interface Props {
  modId: string;
  // What a share names the page by.
  modName: string;
  // Whether the page is offered in the browser, which a page drawn in one is
  // not.
  openInBrowser: boolean;
}

/**
 * The mod's page on windhawk.net, as the two things the header does with it:
 * open it in the browser, and share it.
 *
 * A share hands the page to the browser's share sheet where the browser says
 * it will take it, and otherwise copies the address, saying so for a moment.
 * Asked rather than checked for: Electron, which hosts the VSCode webview,
 * defines the API and answers no.
 */
export function ModPageButtons({ modId, modName, openInBrowser }: Props) {
  const { t } = useTranslation();

  const url = getModPageUrl(modId);

  const { copied, copy } = useCopyToClipboard();

  const share = () => {
    if (navigator.canShare?.({ url })) {
      // Rejected when the sheet is dismissed, which is nothing to report.
      navigator.share({ title: modName, url }).catch(() => undefined);
      return;
    }
    copy(url);
  };

  return (
    <ModPageButtonsWrapper>
      {openInBrowser && (
        <Tooltip title={t('modDetails.modLink.openInBrowser')} placement="bottom">
          <PageButton
            type="text"
            size="small"
            icon={<FontAwesomeIcon icon={faArrowUpRightFromSquare} />}
            href={url}
            target="_blank"
            aria-label={t('modDetails.modLink.openInBrowser')}
            data-testid="mod-details-open-in-browser"
          />
        </Tooltip>
      )}
      <Tooltip
        title={
          copied
            ? t('modDetails.modLink.linkCopied')
            : t('modDetails.modLink.share')
        }
        placement="bottom"
      >
        <PageButton
          type="text"
          size="small"
          icon={<FontAwesomeIcon icon={copied ? faCheck : faShareNodes} />}
          aria-label={t('modDetails.modLink.share')}
          data-testid="mod-details-share"
          onClick={share}
        />
      </Tooltip>
    </ModPageButtonsWrapper>
  );
}

export default ModPageButtons;
