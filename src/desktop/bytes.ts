// Byte counts as text, shared by Quick Look, the size line under icons and the settings preview.

import { locale, t } from "../i18n";

const sizeFormat = new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 });

/** "512 bytes", "12,4 MB", "1,5 GB" (1024-based, like Explorer). */
export function formatBytes(n: number) {
  if (n < 1024) return t.ql.bytes(n);
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${sizeFormat.format(v)} ${units[i]}`;
}
