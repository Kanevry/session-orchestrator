'use client';

import { useEffect } from 'react';

/**
 * Last resort for errors in the root layout. It REPLACES the layout: own
 * <html>/<body>, no providers, so texts are hard-coded and styles inline.
 * Errors outside the React tree never reach it; they get Next's static 500.
 * Do not add pages/500.tsx: next to app/ it makes usePathname, useSearchParams
 * and useParams nullable project-wide.
 */

const PRODUCT_NAME = '{{PROJECT_TITLE}}';

export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    // Report it: swap in your error tracker here, e.g. Sentry.captureException(error).
    console.error(error);
  }, [error]);

  return (
    <html lang="en" style={{ colorScheme: 'light dark' }}>
      <body
        style={{
          margin: 0,
          background: 'Canvas',
          color: 'CanvasText',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <main
          style={{
            minHeight: '100vh',
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '1rem',
            padding: '2rem 1.25rem',
            textAlign: 'center',
          }}
        >
          <p style={{ margin: 0, fontWeight: 700 }}>{PRODUCT_NAME}</p>
          <h1 style={{ margin: 0, fontSize: '1.5rem' }}>Something went wrong</h1>
          <p style={{ margin: 0, maxWidth: '28rem' }}>
            The page could not be loaded. Trying again usually helps.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', justifyContent: 'center' }}>
            <button
              type="button"
              onClick={retry}
              style={{
                minHeight: 44,
                padding: '0 1.5rem',
                border: 0,
                borderRadius: 8,
                background: 'CanvasText',
                color: 'Canvas',
                cursor: 'pointer',
              }}
            >
              Try again
            </button>
            {/* A hard navigation on purpose: a full page load rebuilds the broken state. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- see the line above */}
            <a href="/" style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44, color: 'CanvasText' }}>
              Back to the home page
            </a>
          </div>
          {error.digest ? (
            <p style={{ margin: 0, fontSize: '0.75rem' }}>Error reference: {error.digest}</p>
          ) : null}
        </main>
      </body>
    </html>
  );
}
