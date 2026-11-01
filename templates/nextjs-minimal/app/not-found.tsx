import Link from 'next/link';

/**
 * Branded 404 for notFound() and unknown paths, with a real 404 status. An
 * invalid parameter (unknown id, wrong slug) belongs here, never in a 500.
 * With app/[locale]/, add a localized not-found.tsx there AND keep this one.
 */
export default function NotFound() {
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
      <h1>Page not found</h1>
      <p>This address does not exist (any more). The home page may help.</p>
      <Link href="/" style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44 }}>
        Back to the home page
      </Link>
    </main>
  );
}
