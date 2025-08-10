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

  useEffect(() => {
    try {
      const hash = window.location.hash.slice(1);
      const decodedHash = decodeURIComponent(atob(hash));
      const parsedData = JSON.parse(decodedHash);

      const dataWithToken = {
        ...parsedData,
        token: token,
      };

      const result = ZBaseEmbedAuthoringSchema.safeParse(dataWithToken);

      if (!result.success) {
        console.error('Schema validation failed:', result.error);
        return;
      }

      const { css, cssVars, darkModeDisabled, features } = result.data;

      if (darkModeDisabled) {
        document.documentElement.classList.add('dark-mode-disabled');
      }

      // Always apply the CSS regardless of plan
      if (css || cssVars) {
        injectCss({ css, cssVars });
      }
    } catch (error) {
      console.error(error);
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
