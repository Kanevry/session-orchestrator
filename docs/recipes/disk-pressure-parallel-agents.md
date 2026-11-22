# Recipe: Disk Pressure With Many Parallel Agent Sessions

> **Applies to:** any host that runs many agent sessions with one git worktree per task  
> **Source:** a measured case on a laptop sold with 512 GB of storage (494 GB usable in the APFS container) running 15 to 30 parallel sessions (2026-11)  
> **Related:** `.claude/rules/parallel-sessions.md`, `docs/recipes/quality-gate-container-pattern.md`

---

## 1. Problem

The disk of the session host fills up every day, although nobody stores large files on it. Sessions refuse to start, sweep jobs run and free almost nothing, and buying a bigger disk only moves the day it is full.

The measured case behind this recipe:

- 494 GB internal disk, 21 GB free.
- 259 worktrees present, about 75 new ones per day.
- A daily sweep job that removed between zero and four worktrees per run.
- A second host with a 2 TB disk that was 88 % full for the same reason.

## 2. First decide: stock or flow

Everything below depends on this one question.

| | Stock | Flow |
|---|---|---|
| What it is | Data that sits still: media, archives, old backups | Work leftovers that regrow: worktrees, build output, scratch, caches |
| Sign | Free space is stable between cleanups | Free space falls by a similar amount every day |
| Fix | Move it to an archive target | Fix the removal path; capacity is only headroom |

A larger disk solves a stock problem. It does not solve a flow problem: the larger disk fills at the same rate. Check this before spending money. If a second, larger host shows the same symptom, it is flow.

## 3. Measure before acting

1. **Trust `df`, locate with `du`.** `du` counts hardlinks and copy-on-write clones once per directory. In an earlier cleanup on a second host of the same operator (own measurement, 2026-09), 376 GB by `du` freed 66 GB by `df`. Record `df` before and after every removal and report that number.
2. **Count inflow against outflow.** How many worktrees were created in the last 24 hours, and how many were removed? In the measured case the answer was about 75 against at most four. Nothing else needs to be known to see that the backlog can only grow.
3. **Time the removal check per worktree.** A sweep job that ends at its time cap after two or three candidates has a slow check, not a slow schedule. Running it more often does not help.
4. **Read the refusal reasons.** Most refused removals in the measured case came from a few kilobytes of ignored leftovers (tool output, `tmp/`, CLI caches), from a recent check-in, or from a live session that mentioned the path.
5. **Check whether `node_modules` are clones.** On APFS, pnpm imports packages as clones when the store is on the same volume. A worktree then costs far less real space than `du` reports, and removing worktrees frees less than expected. Measure it: `df` before and after removing a handful.

## 4. Fix the flow

These are the proposed fixes that follow from the measurements. None of them had been implemented and measured in the source case when this recipe was written, so the order is a judgement, not a result:

1. **Remove the worktree in the step that merges it.** A worktree whose merge request is merged and whose tree is clean has no further use. Removing it there needs no list and no sweep.
2. **Give the removal a standing permission for known throwaway leftovers.** Name the classes (for example test output of UI audits, `.orchestrator/tmp`, CLI temp directories). Without it, a removal fails on four kilobytes and a human is asked every time.
3. **Keep a sweep job as the safety net, and make it finish.** Oldest first, resume where the last run stopped, and report "checked x, open y" instead of ending silently at a time cap. Collect expensive facts (process list, session registry, paths named in transcripts) once per run, not once per worktree.
4. **Cap the number of worktrees per host.** Other tools do the same: the Codex app keeps the 15 most recent managed worktrees ([docs](https://learn.chatgpt.com/docs/environments/git-worktrees)), Cursor defaults to 25 per machine ([docs](https://cursor.com/docs/configuration/worktrees)). A cap turns a slow leak into a visible stop.
5. **Put scratch under a per-run directory and remove it with a `trap`.** Free-form paths under `/tmp` are never attributed to an owner and pile up.

Do not use "the remote branch is gone" as the removal signal. It also matches a branch that was never pushed, and in the measured case most merged branches still existed on the remote. Use the merge request state, or `HEAD` contained in the default branch together with a clean tree.

## 5. Add headroom with an external SSD (optional)

If the host has an external SSD attached anyway, it can carry the worktrees. Two facts decide whether this works:

- **exFAT does not.** It has no symlinks, so package installs fail, and small-file operations are slow.
- **An APFS disk image on the same exFAT disk does.** Nothing on the disk has to be erased, and the step can be undone by deleting one file.

Measured on an Apple Silicon laptop with a USB 10 Gb/s SSD, 20,000 files of 4 KiB each:

| Target | write | read | delete |
|---|---|---|---|
| Internal disk | 1.8 s | 0.4 s | 1.2 s |
| APFS image (ASIF) on the SSD | 1.5 s | 0.4 s | 0.9 s |
| SSD directly (exFAT) | 24.3 s | 13.8 s | 16.7 s |

The test set is only 80 MB and runs largely from memory. It shows the order of magnitude, not sustained use.

With a real repository on the image: typecheck 12 s against 13 s internally. Package install took 13 s on the first, cold run and 2 s once the cache was warm, the same as on the internal disk.

Create and mount the image (tested on macOS 27.2):

```bash
diskutil image create blank --fs APFS --format ASIF --size 800G \
  --volumeName Work /Volumes/<ssd>/work/work.asif
diskutil image attach --mountOptions owners /Volumes/<ssd>/work/work.asif
```

What to know before moving worktrees there:

- **Mount with `--mountOptions owners`.** Without it, file ownership is disabled on the volume. Create the top-level folders once while mounted without the option, because the volume root belongs to root.
- **A missing volume makes worktrees look prunable.** While the image is not mounted, `git worktree list` marks its worktrees as `prunable`. A `git worktree prune` in that window deletes their registration. No sweep may prune while the volume is absent.
- **pnpm copies instead of cloning across volumes.** The store stays on the internal disk and packages are copied to the image. That costs space on the SSD, not internally. Install time was the same once caches were warm.
- **A background service cannot mount it without a privacy grant.** A launchd agent that runs `diskutil image attach` on a removable volume fails with "Operation not permitted" until the operator grants access in the system settings.
- **It is one file on a filesystem without a journal.** Every worktree lives inside it. Treat the image as a trial setup; an SSD formatted natively as APFS is the durable form.
- **The image returns freed space only after it is detached.** In a test, 1 GiB written and deleted left the image at 1.01 GB while attached and at 0.01 GB after detaching. Whether space returns with a delay while attached was not measured.
- **Unplugging the SSD removes every worktree on it at once.** Use this only on a host where the disk stays attached, and make session start check that the volume is present.

Not measured: unplugging under load, long-running use with many sessions, and how much internal space the move frees. Where packages are clones on the internal disk, a worktree occupies little real space there, so measure the gain with `df` on a handful of worktrees before changing tooling.

## 6. What does not help

| Option | Why not |
|---|---|
| NAS or any network share as the work volume | Every file operation is a network round trip. A [published comparison](https://techenclave.com/t/performance-gains-after-switching-from-smb-to-nfs-for-truenas/439197) measured about 25 minutes over SMB against under 4 seconds locally for a tree walk of 336,000 files. Fine for backup, not for `node_modules`. |
| Object storage or a storage box mounted as a volume | Same reason. In the source case a connection to the nearest region took 20 to 34 ms. |
| Upgrading the internal disk of a recent Apple laptop | The storage is soldered. |
| A second machine | It is a second disk that fills at the same rate until the flow is fixed. |
| Running the sweep job more often | Only if the per-worktree check is fast. Measure step 3 in section 3 first. |

## 7. Checklist

- [ ] Stock or flow decided from `df` over several days.
- [ ] Inflow and outflow of worktrees counted for 24 hours.
- [ ] Removal check timed per worktree; refusal reasons listed.
- [ ] Removal happens in the merge step; sweep job reports what it left open.
- [ ] Standing permission for throwaway leftovers recorded where the removal tool reads it.
- [ ] Worktree cap per host set from the measured real cost per worktree.
- [ ] Optional: APFS image on an attached SSD, with the volume check in session start.
