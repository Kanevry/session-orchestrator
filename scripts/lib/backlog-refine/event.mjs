/**
 * The one event a backlog-refinement run leaves behind. The CLI
 * (`scripts/backlog-refine.mjs`) emits it, the `maintenance-due` probe
 * (`scripts/lib/maintenance-due-banner.mjs`) looks for it. Both import the name
 * from here: two literals that drift apart would leave the due signal on forever.
 *
 * Zero imports on purpose, so the probe's import closure does not grow.
 */
export const BACKLOG_REFINE_EVENT = 'orchestrator.backlog.refine_completed';
