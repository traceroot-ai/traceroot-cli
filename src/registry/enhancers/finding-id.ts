/**
 * Finding ids changed format: legacy findings carry hyphenated UUIDs
 * (8-4-4-4-12), new ones are bare 32-char hex. The API accepts both forms on
 * lookup, so the CLI presents and sends the canonical hyphen-less form.
 * Only the exact legacy UUID shape is rewritten — any other id passes through
 * untouched (ids from this backend are always lowercase, so the match is strict).
 */
const LEGACY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function sanitizeFindingId(id: string): string {
  return LEGACY_UUID.test(id) ? id.replaceAll("-", "") : id;
}
