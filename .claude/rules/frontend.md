---
globs:
  - src/**/*.tsx
  - src/**/*.css
  - src/**/*.module.css
  - "**/components/**/*.{ts,tsx}"
---
# Frontend Rules (Path-scoped)

## React & Next.js

- Use Server Components by default. Add `"use client"` only when state, effects, or browser APIs are required.
- Co-locate component styles using CSS Modules (`*.module.css`). Never use global class names for component-scoped styles.
- File naming: PascalCase for component files (`UserCard.tsx`), kebab-case for utility files (`format-date.ts`).
- One component per file. Export named, not default, unless the file is a Next.js page/layout.
- Never import server-only modules (`fs`, `crypto`, `database`) in client components.

## Component Design

- Prefer composition over props drilling. Use Context or Zustand for shared state that spans more than 2 component levels.
- Keep components small and focused. If a component renders more than ~150 lines, extract sub-components.
- Separate data-fetching from presentation: fetch in Server Components or custom hooks, render in presentation components.
- Avoid `useEffect` for data fetching — use Server Components or SWR/React Query.

## Styling

- Tailwind CSS for utility classes. CSS Modules for component-scoped styles that would require many utility classes.
- Never use `!important`. If needed, refactor the specificity instead.
- Dark mode: use the `dark:` Tailwind variant. Never hardcode `#000` / `#fff` — use semantic tokens.
- Responsive design: mobile-first. Base styles target mobile, `md:` and `lg:` progressively enhance.

## Accessibility

- Every interactive element must be keyboard-accessible and have an accessible label.
- Use semantic HTML elements (`<button>`, `<nav>`, `<main>`, `<header>`) over generic `<div>` with ARIA roles.
- Images: always include `alt` text. Decorative images use `alt=""`.
- Colour contrast: minimum WCAG 2.1 AA (4.5:1 for normal text, 3:1 for large text).
- Test with VoiceOver (macOS/iOS) or NVDA (Windows) for screen-reader flows.

## Performance

- Lazy-load below-the-fold components with `next/dynamic` (`{ loading: () => <Skeleton /> }`).
- Optimise images with `next/image`. Never use raw `<img>` for content images.
- Avoid large bundle additions: check `next build` output and `@next/bundle-analyzer` before merging heavy dependencies.
- Prefer server-side data fetching (React Server Components) over client-side fetches to reduce waterfall round-trips.

## Forms

- Use `react-hook-form` + Zod resolver for all forms with validation.
- Bind Server Actions with `useTransition` + `startTransition` for progressive enhancement.
- Show field-level validation errors inline. Never show raw Zod error strings to users.
- Disable the submit button while `isPending` to prevent double-submission.

## Anti-Patterns

- `useEffect` for business logic — move to event handlers or server actions.
- Passing raw `any` typed props — always declare typed interfaces.
- Nesting Server and Client Components incorrectly — read the Next.js docs on composition patterns.
- `dangerouslySetInnerHTML` without DOMPurify sanitization.

## See Also
development.md · security.md · security-web.md · testing.md · test-quality.md · backend.md · backend-data.md · mvp-scope.md · parallel-sessions.md · ai-agent.md
