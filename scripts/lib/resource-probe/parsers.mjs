/**
 * parsers.mjs — pure output-parser helpers for resource-probe signals.
 *
 * All functions are pure (no I/O) and exported for unit testability.
 * Consumed by probe-platform.mjs and re-exported from resource-probe.mjs.
 *
 * Part of v3.1.0 Epic #157 / Issue #163.
 * Extended in v3.2 Phase C-2 (#296): swap_used_mb + memory_pressure_pct_free parsers.
 * Split from resource-probe.mjs in #287 (hotspot 2/2).
 */

/**
 * Parse a `ps` etime field (`[[DD-]HH:]MM:SS`) into whole minutes.
 * Returns null when the format is unrecognised.
 * Pure function for unit testability.
 * @param {string} etime
 * @returns {number|null}
 */
export function parseEtimeToMinutes(etime) {
  if (typeof etime !== 'string') return null;
  const s = etime.trim();
  // Regex: optional "DD-", optional "HH:", then "MM:SS"
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s);
  if (!m) return null;
  const days = parseInt(m[1] ?? '0', 10);
  const hours = parseInt(m[2] ?? '0', 10);
  const mins = parseInt(m[3], 10);
  // seconds intentionally dropped (we only need minutes resolution)
  if ([days, hours, mins].some(Number.isNaN)) return null;
  return days * 24 * 60 + hours * 60 + mins;
}

/**
 * Parse the detailed ps output and count Claude/Node zombie candidates.
 * A zombie candidate is a process matching "claude" or "node" that:
 *   - has been running longer than `thresholdMin` minutes, AND
 *   - has CPU% at or below `maxCpuPct` (default 1.0 → idle).
 * Pure function for unit testability.
 * @param {string|null} psOutput — stdout from `ps -A -o pid,comm,etime,%cpu`
 * @param {number} thresholdMin — age threshold in minutes
 * @param {number} [maxCpuPct] — CPU% at-or-below which process is considered idle (default 1.0)
 * @returns {number|null} count, or null when psOutput is null
 */
export function countZombieProcesses(psOutput, thresholdMin, maxCpuPct = 1.0) {
  if (psOutput === null || psOutput === undefined) return null;
  const lines = String(psOutput).split(/\r?\n/);
  let count = 0;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed || /^\s*PID/i.test(trimmed)) continue; // skip header
    // Fields: PID COMM ELAPSED %CPU  (ELAPSED may contain '-' and ':')
    // Split on whitespace but preserve etime which has no spaces.
    const parts = trimmed.split(/\s+/);
    if (parts.length < 4) continue;
    // parts[0]=PID, parts[1]=COMM, parts[2]=ETIME, parts[3]=%CPU
    const comm = (parts[1] ?? '').toLowerCase();
    const etimeStr = parts[2] ?? '';
    const cpuStr = parts[3] ?? '';
    const isClaudeOrNode =
      /(^|[\s/])claude([\s]|$)/.test(comm) ||
      comm === 'claude' ||
      /(^|[\s/])node([\s]|$)/.test(comm) ||
      comm === 'node';
    if (!isClaudeOrNode) continue;
    const ageMin = parseEtimeToMinutes(etimeStr);
    if (ageMin === null || ageMin < thresholdMin) continue;
    const cpu = parseFloat(cpuStr);
    if (Number.isNaN(cpu) || cpu > maxCpuPct) continue;
    count++;
  }
  return count;
}

/**
 * Parse a raw process listing (ps or tasklist output) and count matches.
 * Pure function for unit testability.
 * @param {string|null} psOutput
 * @param {Array<{key: string, match: (line: string) => boolean}>} patterns
 * @returns {Record<string, number>|null}
 */
export function countProcessMatches(psOutput, patterns) {
  if (psOutput === null || psOutput === undefined) return null;
  const lines = String(psOutput).split(/\r?\n/);
  const counts = Object.fromEntries(patterns.map((p) => [p.key, 0]));
  for (const raw of lines) {
    const line = raw.toLowerCase();
    for (const p of patterns) {
      if (p.match(line)) counts[p.key] += 1;
    }
  }
  return counts;
}

/**
 * Parse `sysctl vm.swapusage` output (macOS) and return used MB as integer.
 * Pure function for unit testability.
 * @param {string} text
 * @returns {number|null}
 */
export function parseSwapUsageOutput(text) {
  if (text === null || text === undefined) return null;
  // Sample: "vm.swapusage: total = 4096.00M  used = 1234.50M  free = 2861.50M"
  const match = /used\s*=\s*([\d.]+)M/i.exec(String(text));
  if (!match) return null;
  const mb = parseFloat(match[1]);
  if (Number.isNaN(mb)) return null;
  return Math.round(mb);
}

/**
 * Parse `memory_pressure` output (macOS) and return the free percentage as integer.
 * Pure function for unit testability.
 * @param {string} text
 * @returns {number|null}
 */
export function parseMemoryPressureOutput(text) {
  if (text === null || text === undefined) return null;
  // Sample: "System-wide memory free percentage: 42%"
  const match = /System-wide memory free percentage:\s*(\d+)%/i.exec(String(text));
  if (!match) return null;
  const pct = parseInt(match[1], 10);
  if (Number.isNaN(pct)) return null;
  return pct;
}

/**
 * Parse `vm_stat` output (macOS) and compute AVAILABLE RAM in GB.
 *
 * macOS treats most physical RAM as reclaimable cache, so `os.freemem()` (which
 * reflects only `Pages free`) regularly reads sub-1 GB on a machine with 100+ GB
 * of genuinely reclaimable headroom. The correct "how much can a new process
 * actually claim?" estimate is:
 *
 *   available = (free + inactive + speculative + purgeable) × page_size
 *
 * - `Pages free`        — immediately allocatable.
 * - `Pages inactive`    — clean/dirty pages on the inactive queue, reclaimable
 *                          under pressure (the macOS file/anon cache).
 * - `Pages speculative` — read-ahead pages, dropped first under pressure.
 * - `Pages purgeable`   — volatile pages the kernel may discard on demand.
 *
 * `File-backed pages` overlaps the inactive queue, so it is intentionally NOT
 * added (would double-count). This mirrors how Activity Monitor derives "free"
 * memory and matches the formula in the issue spec (#667).
 *
 * Pure function for unit testability.
 * @param {string} text — stdout from `vm_stat`
 * @returns {number|null} available GB rounded to 1 decimal, or null on parse failure
 */
export function parseVmStatAvailableGb(text) {
  if (text === null || text === undefined) return null;
  const str = String(text);
  // Page size is reported in the header: "page size of 16384 bytes".
  const psMatch = /page size of (\d+) bytes/i.exec(str);
  if (!psMatch) return null;
  const pageSize = parseInt(psMatch[1], 10);
  if (Number.isNaN(pageSize) || pageSize <= 0) return null;

  // Each line looks like "Pages free:    10794." — value followed by a period.
  const pagesFor = (label) => {
    const re = new RegExp(`${label}:\\s+(\\d+)\\.`, 'i');
    const m = re.exec(str);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return Number.isNaN(n) ? null : n;
  };

  const free = pagesFor('Pages free');
  const inactive = pagesFor('Pages inactive');
  // `Pages free` and `Pages inactive` are the load-bearing terms; if either is
  // absent the output is not recognisable vm_stat and we bail.
  if (free === null || inactive === null) return null;

  // speculative + purgeable are smaller reclaimable buckets; treat absent as 0.
  const speculative = pagesFor('Pages speculative') ?? 0;
  const purgeable = pagesFor('Pages purgeable') ?? 0;

  const availablePages = free + inactive + speculative + purgeable;
  const availableGb = (availablePages * pageSize) / 1024 ** 3;
  return Math.round(availableGb * 10) / 10;
}
