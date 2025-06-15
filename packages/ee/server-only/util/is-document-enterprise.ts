export type IsUserEnterpriseOptions = {
  userId: number;
  teamId?: number;
};

/**
 * Whether the user is enterprise, or has permission to use enterprise features on
 * behalf of their team.
 *
 * Short circuit to always return true
 */
export const isUserEnterprise = async ({
  userId,
  teamId,
}: IsUserEnterpriseOptions): Promise<boolean> => {
  return true
};
