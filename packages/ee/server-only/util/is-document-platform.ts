export type IsDocumentPlatformOptions = {
  userId: number;
  teamId?: number | null;  // Modified to accept both undefined and null
};

/**
 * Whether the user is platform, or has permission to use platform features on
 * behalf of their team.
 *
 * Short circuit to always return true
 */
export const isDocumentPlatform = async ({
  userId,
  teamId,
}: IsDocumentPlatformOptions): Promise<boolean> => {
  return true;
};
