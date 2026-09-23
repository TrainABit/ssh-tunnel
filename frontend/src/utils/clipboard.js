/**
 * Copy text to clipboard.
 * Uses the modern Clipboard API when available (secure contexts only),
 * falls back to execCommand for plain-HTTP deployments.
 */
export function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(() => execCommandFallback(text));
  } else {
    execCommandFallback(text);
  }
}

function execCommandFallback(text) {
  const el = document.createElement('textarea');
  el.value = text;
  el.setAttribute('readonly', '');
  el.style.position = 'fixed';
  el.style.opacity = '0';
  document.body.appendChild(el);
  el.focus();
  el.select();
  try {
    document.execCommand('copy');
  } catch {
    // Copying is best effort; the text stays visible for manual selection.
  }
  document.body.removeChild(el);
}
