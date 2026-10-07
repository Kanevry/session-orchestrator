# Host-local owner privacy patterns

The owner-leakage scanner keeps host-specific usernames, endpoints, project names and allowed public contacts in a protected file outside every repository. The package ships generic rules and invented test fixtures. Public author and copyright attribution remain public; operational paths and private endpoints belong in local configuration.

## Configure a host

Create `owner-patterns.json` using your own private values. Do not commit it, copy it into a release tree, or print it into CI logs. Resolution follows this order:

1. `SO_OWNER_PATTERNS_FILE`: an explicit absolute filename.
2. `SO_CONFIG_HOME/owner-patterns.json`.
3. `XDG_CONFIG_HOME/session-orchestrator/owner-patterns.json`.
4. `~/.config/session-orchestrator/owner-patterns.json`.

Empty or whitespace-only environment values are unset. An explicit relative filename is unsafe. The file must be regular, owned by the current user, have exactly mode `0600` and a single hard link, and be outside any Git repository, including ignored directories. Its parent and user-owned ancestors must not be group/world writable. User-controlled symlink ancestors and a symlink file are rejected; root-owned operating-system aliases such as macOS `/tmp` are allowed above the protected parent.

For a new directory, use a private umask and create the file with mode `0600`. Choose the directory according to the resolution above; this example uses the default:

```sh
umask 077
mkdir -p "$HOME/.config/session-orchestrator"
# Create owner-patterns.json in that directory with a local editor.
chmod 600 "$HOME/.config/session-orchestrator/owner-patterns.json"
```

Existing directory permissions may remain `0755` if they meet the ownership/writability requirements. The file is limited to 64 KiB. Use a local protected file on each host that needs these checks; it is separate from [owner.yaml](owner-config-schema.md).

## Version 1 schema

The object has `version: 1` and these optional arrays of literal strings. Omitted arrays become empty; explicit `null`, unknown fields and invalid types fail validation. Strings are escaped as literals rather than interpreted as regular expressions. Each array permits at most 256 strings, each at most 256 UTF-16 code units, without leading/trailing whitespace or ASCII control characters below U+0020. At least one blocking array must be nonempty.

| Field | Purpose |
|---|---|
| `usernamePrefixes` | Personal home-path and bare username prefixes |
| `privateHosts` | Private service hosts |
| `eventsHosts` | Private events service hosts |
| `privateDomains` | Private domain catch-all |
| `packageScopes` | Private package scope names, **without** the leading `@` |
| `privateSlugs` | Private project/repository slugs |
| `vaultClearSlugs` | Members of `privateSlugs` allowed by the synchronous vault namespace consumer; case-insensitive subset |
| `personalNames` | Personal segments in home-relative `Projects` paths |
| `publicEmails` | Exact published email contacts permitted by occurrence |
| `publicUrls` | Exact public publication URLs permitted in designated attribution files |

This invented example demonstrates the schema; replace it locally rather than treating these values as protection for your host:

```json
{
  "version": 1,
  "usernamePrefixes": ["sampleg"],
  "privateHosts": ["gitlab.example.invalid"],
  "eventsHosts": ["events.example.invalid"],
  "privateDomains": ["example.invalid"],
  "packageScopes": ["example"],
  "privateSlugs": ["project-secret", "project-public"],
  "vaultClearSlugs": ["project-public"],
  "personalNames": ["SampleOwner"],
  "publicEmails": ["office@example.invalid"],
  "publicUrls": ["https://www.example.invalid", "www.example.invalid"]
}
```

Public contacts exempt only matching occurrences. A line that combines a published contact with a private host still fails. Public URL exceptions apply to designated publication files such as the root README, plugin manifests and site attribution pages. They do not grant every file permission to contain a private domain. Clearance affects the synchronous vault namespace consumer; the full scanner still checks private slugs.

## Scans and releases

An ordinary scan with no host file visibly warns that host-specific rules are unavailable. Generic rules and independently configured confidential-name checks continue. An unsafe or malformed source fails the scan. The synchronous namespace guard stays synchronous and conservatively redacts identities for an invalid/unsafe policy or an explicitly configured missing source.

Release checks require the source with `--require-owner-patterns`. Packed scans also read the actual contents listed in npm's JSON inventory:

```sh
node scripts/lib/validate/check-owner-leakage.mjs /absolute/extracted/package \
  --require-owner-patterns --packed-files /absolute/inventory.json
```

Use an inventory describing the actual extracted tarball and scan that extraction, not just a list of filenames. Packed mode checks all listed regular files and rejects unsafe paths, symlinks and unreadable entries. Ordinary test/file exclusions and CP8/CP10 filename exceptions do not exempt packed contents. Violation output keeps checkpoint IDs, counts and safe file/line locations, omits offending content, and replaces private filename segments; it does not publish configured policy values. This detects the configured patterns, not every possible unknown secret.

Confidential customer-name checking (CP11) remains separately configured through `SO_CONFIDENTIAL_NAMES_FILE` or `owner.yaml` `paths.confidential-names-file`. A configured unusable CP11 source fails closed; absence of that optional source does not disable the other rules.

## Migration and configured vault paths

Hosts upgrading from the previous embedded pattern lists must privately migrate the values they relied on to this version 1 file before strict release checks. Preserve blocking entries, narrowly justified public contacts/URLs and vault clearance; verify mode and a strict scan without printing the source. Do not substitute invented fixture values or remove protection to pass a release. New hosts opt in by creating their own protected policy.

Vault tools resolve the canonical vault from `SO_VAULT_DIR`, then `owner.yaml` `paths.vault-dir`. `vault-consolidate.mjs --canonical` overrides both; it retains the generic source default `~/Projects/vault`, and a source equal to the canonical real path is a no-op before backups or writes. Existing sources require a configured canonical destination. A missing source retains its harmless no-op behavior.

`migrate-vault-paths.mjs` replaces narrowly matched legacy `vault-dir` bases with the whole configured target, preserving suffixes, scalar quoting and comments. It skips the vault-target migration when unconfigured or invalid, without inserting a guessed personal segment; its separately configured username rewrite still applies. Historical and username-owned lines retain their existing protections. Preview either tool before applying it.
