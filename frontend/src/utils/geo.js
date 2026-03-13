/**
 * Convert a 2-letter ISO country code to a flag emoji.
 * Returns '' if code is invalid.
 */
export function countryFlag(code) {
  if (!code || code.length !== 2) return '';
  const upper = code.toUpperCase();
  // Regional indicator letters start at U+1F1E6 (= 0x1F1E6), offset from 'A' = 0x41
  const a = upper.charCodeAt(0) - 0x41 + 0x1F1E6;
  const b = upper.charCodeAt(1) - 0x41 + 0x1F1E6;
  if (a < 0x1F1E6 || a > 0x1F1FF || b < 0x1F1E6 || b > 0x1F1FF) return '';
  return String.fromCodePoint(a) + String.fromCodePoint(b);
}

/**
 * Format geo location as "🇩🇪 Berlin" or just "🇩🇪" or "Berlin" or "–"
 */
export function formatGeo(country_code, city) {
  const flag = countryFlag(country_code);
  const parts = [flag, city].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : null;
}
