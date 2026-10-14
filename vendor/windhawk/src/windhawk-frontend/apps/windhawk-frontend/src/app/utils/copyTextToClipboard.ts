/**
 * Copies text to the clipboard through the document's copy command, run over
 * a text box that exists for the length of the call. The command is what works
 * in every host: the VSCode webview refuses navigator.clipboard. Like the
 * command, it has to be called from a user gesture. Returns whether the command
 * reported success.
 */
// https://stackoverflow.com/a/30810322
export function copyTextToClipboard(text: string): boolean {
  const textArea = document.createElement('textarea');
  textArea.value = text;

  // Avoid scrolling to bottom.
  textArea.style.top = '0';
  textArea.style.insetInlineStart = '0';
  textArea.style.position = 'fixed';

  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();

  try {
    return document.execCommand('copy');
  } catch (err) {
    console.error('Unable to copy to the clipboard', err);
    return false;
  } finally {
    document.body.removeChild(textArea);
  }
}
