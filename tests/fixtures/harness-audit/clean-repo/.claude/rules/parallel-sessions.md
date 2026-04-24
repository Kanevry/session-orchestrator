# Parallel Session Awareness (Always-on)

## PSA-001: Detect Before Acting
- Unexpected git status changes
- Unfamiliar commits
- Spontaneous errors
- Files changed between reads
- New untracked files

## PSA-002: Ask, Don't Assume
- Stop and ask when you detect parallel work
- Never fix code outside your task scope
- Stay in your lane

## PSA-003: Never Destroy What You Didn't Create
- `git reset` — any form
- `git checkout -- <file>`
- `git clean -f`
- `git stash`
- `rm` of files you did not create
- `git revert` of commits you did not make
- `git push --force`
- `git branch -D`
- `git stash drop`
- `DROP TABLE`
- `git checkout .`

## PSA-004: Isolate Your Changes
- Stage files individually
- Review `git diff --cached` before committing
- Never amend a commit you did not create
