<!-- source: session-orchestrator plugin (canonical: rules/opt-in-stack/frontend.md) -->
---
globs:
  - src/**/*.tsx
  - src/**/*.css
  - src/**/*.module.css
  - "**/components/**/*.{ts,tsx}"
tier: wave-only
---
# Frontend Rules (Path-scoped)

## React & Next.js

- Use Server Components by default. Add `"use client"` only when state, effects, or browser APIs are required.
- Co-locate component styles using CSS Modules (`*.module.css`). Never use global class names for component-scoped styles.
- File naming: PascalCase for component files (`UserCard.tsx`), kebab-case for utility files (`format-date.ts`).
- One component per file. Export named, not default, unless the file is a Next.js page/layout.
- Never import server-only modules (`fs`, `crypto`, `database`) in client components.
- `next.config` `redirects()` with identical `source` and `destination` does NOT short-circuit — it emits a real 307 and loops to `ERR_TOO_MANY_REDIRECTS`. Exclude the matched path with a negative-lookahead in `source` (e.g. `/admin/:path((?!auth(?:/.*)?$).*)`), and validate every rule with `path-to-regexp` (Next.js' own routing lib) before shipping.

## Component Design

- Prefer composition over props drilling. Use Context or Zustand for shared state that spans more than 2 component levels.
- Keep components small and focused. If a component renders more than ~150 lines, extract sub-components.
- Separate data-fetching from presentation: fetch in Server Components or custom hooks, render in presentation components.
- Avoid `useEffect` for data fetching — use Server Components or SWR/React Query.
- Shared/reusable components MUST explicitly accept and forward `data-testid` (and spread rest props) to their root element. A closed prop list silently drops it — the testid never reaches the DOM, yet mock-based unit tests stay green over a broken product (test-the-mock; see `testing.md`).

## Styling

- Tailwind CSS for utility classes. CSS Modules for component-scoped styles that would require many utility classes.
- Never use `!important`. If needed, refactor the specificity instead.
- Dark mode: use the `dark:` Tailwind variant. Never hardcode `#000` / `#fff` — use semantic tokens.
- Responsive design: mobile-first. Base styles target mobile, `md:` and `lg:` progressively enhance.
<!-- rule:pure-black-ink -->
- Never pure black text (`color:#000` / `black` / `rgb(0,0,0)`). Tint toward the brand hue (very dark, slightly-hued ink) — pure black reads harsh on screen.

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

## Next.js Server Actions

- After a `useActionState` action, do NOT call `router.refresh()` — it REPLAYS the action (duplicate DB writes + a re-fired success effect that bounces the redirect). The action's `revalidatePath` already handles freshness; guard the success effect with a `useRef` idempotency flag.
- Never call `router.push()` INSIDE `startTransition` — `isPending` stays true until navigation AND all server revalidations settle, so the submit button hangs under load. Capture a success flag inside the transition, then navigate from a SEPARATE `useEffect` guarded by a `hasNavigatedRef`.
- These bugs surface only in live (local-Docker) E2E — unit tests and static review pass them green. Smoke the create/edit flow against a running server before claiming done.

## Anti-Patterns

- `useEffect` for business logic — move to event handlers or server actions.
- Passing raw `any` typed props — always declare typed interfaces.
- Nesting Server and Client Components incorrectly — read the Next.js docs on composition patterns.
- `dangerouslySetInnerHTML` without DOMPurify sanitization.
- `eslint-disable-next-line react-hooks/exhaustive-deps` — under the React Compiler it triggers a `react-compiler/react-compiler` warning that blocks commits at `max-warnings 0`. Restructure (drop the `useEffect`, or include all deps) instead of disabling.

## Absolute Bans

<!-- rule:gradient-text -->
- Never gradient text (`background-clip:text` + gradient, or Tailwind `bg-clip-text`). Decorative, never meaningful — use a solid color; carry emphasis with weight/size.
<!-- rule:side-stripe-border -->
- Never a side-stripe accent border (colored `border-left/right` ≥ 2px, incl. `border-l-4`). Use full borders, a background tint, a leading icon/number, or nothing.
<!-- rule:overused-font -->
- Avoid overused primary fonts (Inter / Roboto / Arial / Helvetica as the FIRST family). Pick a font with a point of view; keep these only as deeper fallbacks. (also referenced by development.md)
<!-- rule:ai-purple-gradient -->
- No purple/indigo "AI" gradient (purple→blue ramp or two-purple gradient) — the single most recognizable AI tell. If purple is genuinely the brand, keep it flat; else pick a committed strategy. (fpRisk: high — brand-purple is the honest exception.)

## Motion

<!-- rule:bounce-easing -->
- No bounce/elastic/overshoot easing (`bounce`/`elastic`/`spring` keywords, or `cubic-bezier` with a control point > 1 or < 0). Ease out with exponential curves (ease-out-quart/quint/expo).
<!-- rule:layout-property-transition -->
- Don't animate layout properties (`width`/`height`/`top`/`margin`/`padding` in a `transition`). Animate `transform`/`opacity` instead — layout animation thrashes the main thread.

## Layout

<!-- rule:arbitrary-z-index -->
- No arbitrary z-index (`z-index: 999 / 9999`). Build a semantic z-index scale (dropdown → sticky → modal → toast → tooltip); never magic numbers.

## See Also
development.md · security.md · security-web.md · testing.md · backend.md · backend-data.md · mvp-scope.md · parallel-sessions.md
