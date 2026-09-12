<!-- source: session-orchestrator plugin (canonical: templates/_shared/ux-manifest.template.md) -->
---
# ux-grill manifest — copy to `.orchestrator/ux-manifest.md` in the target repo.
#
# Every value below is a PLACEHOLDER. Replace them; never paste a credential,
# a token or a production host into this file — it is tracked by git.

# REQUIRED. Must be loopback (127.0.0.1 / localhost / [::1]). A non-loopback
# base-url aborts the mechanical run with "base-url must be loopback".
base-url: http://127.0.0.1:3100

# REQUIRED. `dev` or `prod`. A dev build is not a geometry measurement basis,
# so target-size findings from it are marked `provisional: true`.
build: dev

# Filename (relative to the target repo root) of the GITIGNORED env file that
# holds the VALUES for every env NAME named below. Omit it if no run needs
# credentials or guarded endpoints.
env-file: .env.e2e.local

# Env NAMES whose values must point at loopback. Use this for every endpoint
# the app talks to (API base, database URL, storage) so a stray production
# value cannot be written to by a seed or a journey. The value is checked but
# never printed.
guarded-url-envs:
  - APP_API_BASE_URL
  - APP_DATABASE_URL

# Optional command that seeds deterministic test data before the run.
seed-command: npm run seed:e2e

# Evaluation personas. Credentials are env NAMES only — the values live in
# `env-file`. Use `personas: []` for an app that needs no login.
personas:
  - name: solo-operator
    login-env-email: LOGIN_EMAIL_SOLO
    login-env-password: LOGIN_PASSWORD_SOLO
    goal: Get from the dashboard to a finished document without help.
  - name: accountant
    login-env-email: LOGIN_EMAIL_ACCOUNTANT
    login-env-password: LOGIN_PASSWORD_ACCOUNTANT
    goal: Review a client's numbers and export them.

# Routes to measure. `title-pattern` is a regular expression matched against
# the page title. `frame` is optional and only used by the Pencil coverage
# step (`desktop` | `mobile` | `both` | `none`).
routes:
  - path: /dashboard
    title-pattern: ^Dashboard
    persona: solo-operator
    frame: both
  - path: /documents/new
    title-pattern: ^New document
    persona: solo-operator

# Journeys are replayed verbatim: every entry of `steps` is one agent-browser
# command line, so the mechanical stage can count them without judging them.
#
# TRUST: each step line is split into an argv array and handed to the
# `agent-browser` binary (never to a shell) — but NOT verbatim: the first token
# must be one of the ALLOWLISTED UI verbs below, anything else aborts the run
# with `step-verb-not-allowed`.
#
#   back  check  click  dblclick  drag  fill  find  focus  forward  get
#   hover  is  keyboard  open  press  reload  scroll  scrollintoview
#   select  snapshot  type  uncheck  wait
#
# The denied half of the CLI is what the allowlist exists for: `upload` and
# `cookies set --curl` read arbitrary HOST FILES into the page, `download` and
# `pdf` write arbitrary host paths, `eval` can exfiltrate off-origin, `connect`
# retargets a foreign browser, and `close --all` kills every other agent's
# session on the machine. So the trust model is "allowlisted UI verbs", not
# "anything the CLI accepts" — whoever can commit this file can drive the
# BROWSER, not the host.
#
# An `open` step must resolve to the same origin as `base-url`, else
# `step-open-off-origin`. A step may not carry `--session`: the run owns its
# session, and a step that retargets it aborts with `step-session-override`.
#
# `start` must resolve to the SAME ORIGIN as `base-url` (a path is the normal
# form). An off-origin `start` aborts with `journey-start-off-origin` — with a
# persona attached, an absolute foreign URL would type real credentials into a
# foreign page. The same rule holds for every `routes[].path`.
journeys:
  - name: create-first-document
    persona: solo-operator
    start: /dashboard
    steps:
      - click "New document"
      - type "#title" "Placeholder title"
      - click "Save"
    success: /documents/
    max-steps: 6

# Viewports. Defaults to exactly these two when the key is absent.
#
# Every viewport is VERIFIED after it is applied: `window.innerWidth` must equal
# the expectation, else the viewport is skipped as `device-mismatch` rather than
# captured under a wrong label. The expectation is the `viewport:` width, the
# built-in width of a known `device:` name (iPhone 15/16 393, iPhone 16 Pro 402,
# iPhone 17 402, iPad 820, iPad Pro 1024, Pixel 9 412, Galaxy S25 360 — measured
# against agent-browser 0.37.1), or an explicit `expected-width:`. A `device:`
# outside that list NEEDS `expected-width:`, otherwise the viewport is skipped:
# an unknown device name leaves the previous device in place, so an unverified
# width is exactly how desktop captures end up labelled `mobile`.
viewports:
  - name: desktop
    viewport: 1440x900
  - name: mobile
    device: iPhone 15

# Optional design-coverage source.
pencil:
  file: design/app.pen
---

# UX Manifest — <REPO NAME>

> Per-repo UX truth: what a real user walks through, and what the mechanical
> stage is allowed to touch. Last verified: <YYYY-MM-DD> by <operator>

## Notes

Free-form notes below the frontmatter. They are preserved verbatim and are not
parsed — use them for context the fields cannot carry.

**Credentials never go in this file.** The frontmatter names env VARIABLES
(`login-env-email`, `login-env-password`, `guarded-url-envs`); their values are
read at run time from the gitignored file named by `env-file`. A value pasted
here is a secret in a tracked file, and the run itself will never print one:
guarded-env and persona errors name the variable, never its content. `env-file`
must resolve INSIDE the repo (`env-file-outside-repo` otherwise) — it names a
file of this repo, never a host-wide secrets file.

**Run artefacts can carry a credential even though findings cannot.** Three
classes: journey step screenshots (one is taken after EVERY step, including the
one right after `fill #pw ${LOGIN_PASSWORD}`), the text of `errors --json`, and
the `html` snippets inside axe JSON. They all live under
`.orchestrator/metrics/ux-grill/`, which `/ux-grill` adds to this repo's
`.gitignore` on bootstrap — keep that line, and never commit a run directory.

## Known exceptions

Findings that are known and deliberately accepted — with the reason and a
revisit trigger, so they are not re-filed every run.

| Finding | Why accepted | Revisit trigger |
|---------|--------------|-----------------|
| <…> | <…> | <…> |
