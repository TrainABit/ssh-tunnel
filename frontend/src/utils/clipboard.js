/**
 * Copy text to clipboard.
 * Uses the modern Clipboard API when available (requires HTTPS),
 * falls back to execCommand for HTTP environments.
 */
export function copyToClipboard(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).catch(() => execCommandFallback(text));
  } else {
    execCommandFallback(text);
  }
}

function execCommandFallback(text) {
  const el = document.createElement('textarea');
  el.value = text;
  el.style.position = 'fixed';
  el.style.opacity = '0';
  document.body.appendChild(el);
  el.focus();
  el.select();
  try { document.execCommand('copy'); } catch {}
  document.body.removeChild(el);
}
