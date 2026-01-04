/**
 * Parse a semicolon-separated list of emails.
 *
 * Examples:
 * - "a@b.com" -> ["a@b.com"]
 * - "a@b.com;c@d.com" -> ["a@b.com", "c@d.com"]
 * - "a@b.com; c@d.com" -> ["a@b.com", "c@d.com"]
 */
export const parseSemicolonSeparatedEmails = (emails?: string | null): string[] => {
  if (!emails) {
    return [];
  }

  const parts = emails
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

  // Dedupe while preserving order.
  return [...new Set(parts)];
};

