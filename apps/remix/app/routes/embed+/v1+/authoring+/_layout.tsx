import { useEffect } from 'react';

import { Outlet, useLoaderData } from 'react-router';

import { verifyEmbeddingPresignToken } from '@documenso/lib/server-only/embedding-presign/verify-embedding-presign-token';
import { TrpcProvider } from '@documenso/trpc/react';

import { ZBaseEmbedAuthoringSchema } from '~/types/embed-authoring-base-schema';
import { injectCss } from '~/utils/css-vars';

import type { Route } from './+types/_layout';

export const loader = async ({ request }: Route.LoaderArgs) => {
  const url = new URL(request.url);

  const token = url.searchParams.get('token');

  if (!token) {
    return {
      hasValidToken: false,
      token,
    };
  }

  const result = await verifyEmbeddingPresignToken({ token }).catch(() => null);

  return {
    hasValidToken: !!result,
    token,
  };
};

export default function AuthoringLayout() {
  const { hasValidToken, token } = useLoaderData<typeof loader>();

  useEffect(() => { // Changed from useLayoutEffect
    if (typeof window === 'undefined') return; // Add this check for SSR


    try {
      const hash = window.location.hash.slice(1);

      console.log('Raw hash:', hash);

      const decodedHash = decodeURIComponent(atob(hash));
      console.log('Decoded hash:', decodedHash);

      const parsedData = JSON.parse(decodedHash);
      console.log('Parsed data:', parsedData);

      const dataWithToken = {
        ...parsedData,
        token: token,
      };
      console.log('Data with token:', dataWithToken);

      const result = ZBaseEmbedAuthoringSchema.safeParse(dataWithToken);
      console.log('Schema parse result:', result);

      if (!result.success) {
        console.error('Schema validation failed:', result.error);
        return;
      }

      const { css, cssVars, darkModeDisabled, features } = result.data;
      console.log('Extracted config:', { css, cssVars, darkModeDisabled, features });

      // Apply dark mode class immediately if disabled
      if (darkModeDisabled) {
        console.log('Attempting to disable dark mode');
        document.documentElement.classList.add('dark-mode-disabled');
      }

      // Always apply the CSS regardless of plan
      if (css || cssVars) {
        console.log('Applying CSS customizations');
        injectCss({ css, cssVars });
      }

    } catch (error) {
      console.error('Error in layout effect:', error);
    }
  }, []);

  if (!hasValidToken) {
    return <div>Invalid embedding presign token provided</div>;
  }

  return (
      <TrpcProvider headers={{ authorization: `Bearer ${token}` }}>
        <Outlet context={{ token }} />
      </TrpcProvider>
  );
}
