/**
 * Shared date formatting utilities
 * Can be used on both server and client
 */

export const APP_TIME_ZONE = 'Asia/Taipei';

/**
 * Normalizes Intl output so SSR and CSR render byte-identical strings.
 *
 * Node and the browser ship different ICU/CLDR versions, and newer CLDR releases
 * separate the date and time parts with a thin space (U+2009) instead of a plain
 * space. The two look identical but break React hydration, so all fixed-width
 * spaces are collapsed to U+0020 and directional marks are stripped.
 */
function normalizeIntlOutput(value: string): string {
  return value
    .replace(/[\u200E\u200F]/g, '') // LRM / RLM directional marks
    .replace(/[\u00A0\u2007\u2009\u202F]/g, ' '); // nbsp / figure / thin / narrow-nbsp -> plain space
}

function formatInTimeZone(date: Date | string, locale: string, options: Intl.DateTimeFormatOptions): string {
  const dateObj = typeof date === 'string' ? new Date(date) : date;
  return normalizeIntlOutput(new Intl.DateTimeFormat(locale, options).format(dateObj));
}

export function formatDateForDisplay(date: Date | string): string {
  try {
    return formatDateOnlyInTimeZone(date);
  } catch (error) {
    console.error('Date formatting error:', error);
    return 'Invalid Date';
  }
}

export function formatDatetime(date: Date | string): string {
  try {
    return formatDateTimeInTimeZone(date, 'en-CA').replace(',', '');
  } catch (error) {
    console.error('Datetime formatting error:', error);
    return 'Invalid Datetime';
  }
}

export function formatRelativeDate(date: Date | string): string {
  try {
    const dateObj = typeof date === 'string' ? new Date(date) : date;
    const now = new Date();
    const diffTime = now.getTime() - dateObj.getTime();
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;

    return formatDateForDisplay(dateObj);
  } catch (error) {
    console.error('Relative date formatting error:', error);
    return 'Unknown';
  }
}

export function parseDateOnlyToUTCDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    const fallback = new Date(trimmed);
    return Number.isNaN(fallback.getTime()) ? undefined : fallback;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
}

export function formatDateOnlyInTimeZone(date: Date | string, timeZone: string = APP_TIME_ZONE): string {
  return formatInTimeZone(date, 'en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

export function formatTimeInTimeZone(date: Date | string, timeZone: string = APP_TIME_ZONE): string {
  return formatInTimeZone(date, 'en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

export function formatDateTimeInTimeZone(
  date: Date | string,
  locale: string = 'zh-TW',
  timeZone: string = APP_TIME_ZONE
): string {
  return formatInTimeZone(date, locale, {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

export function parseTaipeiDateTimeToUTC(
  dateValue: string | null | undefined,
  timeValue: string | null | undefined
): Date | null | undefined {
  if (!dateValue || dateValue.trim() === '') {
    return null;
  }

  const dateMatch = dateValue.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateMatch) return undefined;

  const time = timeValue && timeValue.trim() !== '' ? timeValue : '18:00';
  const timeMatch = time.match(/^(\d{2}):(\d{2})$/);
  if (!timeMatch) return undefined;

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hours = Number(timeMatch[1]);
  const minutes = Number(timeMatch[2]);

  if (month < 1 || month > 12 || day < 1 || day > 31 || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return undefined;
  }

  const utcDateCheck = new Date(Date.UTC(year, month - 1, day));
  if (
    utcDateCheck.getUTCFullYear() !== year ||
    utcDateCheck.getUTCMonth() !== month - 1 ||
    utcDateCheck.getUTCDate() !== day
  ) {
    return undefined;
  }

  const taiwanISO = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}T${timeMatch[1]}:${timeMatch[2]}:00+08:00`;
  const parsed = new Date(taiwanISO);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
