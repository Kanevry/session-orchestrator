'use client';

import Link from 'next/link';
import { useEffect } from 'react';

/**
 * Error boundary below the root layout: the layout and its styles stay. With
 * route groups, add one error.tsx per group. Never show `error.message` or a
 * stack; the digest is the reference a user can give to support.
 * `retry()` re-fetches the segment; `reset()` only re-renders the client tree.
 */
export default function ErrorBoundary({
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
    <main
      style={{
        maxWidth: '28rem',
        margin: '0 auto',
        padding: '4rem 1.25rem',
        textAlign: 'center',
      }}
    >
      <p style={{ fontWeight: 600 }}>{{PROJECT_TITLE}}</p>
      <h1>Something went wrong</h1>
      <p>This part of the page could not be loaded. Trying again usually helps.</p>
      <p style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', justifyContent: 'center' }}>
        <button type="button" onClick={retry} style={{ minHeight: 44, padding: '0 1.5rem' }}>
          Try again
        </button>
        <Link href="/" style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44 }}>
          Back to the home page
        </Link>
      </p>
      {error.digest ? <p style={{ fontSize: '0.75rem' }}>Error reference: {error.digest}</p> : null}
    </main>
  );
}
