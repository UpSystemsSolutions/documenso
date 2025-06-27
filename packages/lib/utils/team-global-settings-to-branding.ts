import type { TeamGlobalSettings, DocumentMeta } from '@prisma/client';

import { NEXT_PUBLIC_WEBAPP_URL } from '../constants/app';

export const teamGlobalSettingsToBranding = (
  teamGlobalSettings: TeamGlobalSettings,
  documentMeta?: DocumentMeta | null,
) => {
  const brandingEnabled = teamGlobalSettings.brandingEnabled ?? false;

  // Get logo from customMailIdentity if available, otherwise use team logo
  const logoUrl =
    documentMeta?.emailSettings?.customMailIdentity?.logo ||
    (teamGlobalSettings.brandingLogo
      ? `${NEXT_PUBLIC_WEBAPP_URL()}/api/branding/logo/team/${teamGlobalSettings.teamId}`
      : '');

  return {
    ...teamGlobalSettings,
    brandingLogo: brandingEnabled ? logoUrl : '',
  };
};
