# Security policy

## Credential handling

This repository must never contain API keys, exported credentials, private
keys, cookies, or production request/response captures.

The server reads a Sub2API key at runtime from exactly one source:

- `SUB2API_API_KEY`, inherited by the local MCP process; or
- `SUB2API_API_KEY_FILE`, an absolute path to a non-symlink regular file with
  mode `0600` on POSIX systems.

The key is used only in the outbound `Authorization` header. It is omitted from
configuration diagnostics, MCP results, and expected logs. CI also runs a
best-effort scan across current files and all reachable Git history objects;
CI uses a full-history checkout for this purpose. That scan is not a substitute
for review.

Deleting a credential in a later commit does not remove it from public Git
history. If a real secret is ever committed, revoke or rotate it immediately,
then follow GitHub's documented history-rewrite and cache-removal process.

The one-click installer does not accept a key as a command-line option. In
interactive mode it reads the key without terminal echo and stores it outside
the repository in a mode-`0600` regular file. For unattended use, an existing
private key file is preferred over `SUB2API_API_KEY`. The installer removes an
inherited inline key from its environment before starting build, Git, Codex, or
MCP subprocesses.

Before changing Codex MCP registration, the installer creates a private
timestamped backup of `config.toml`. A registration failure restores the
original configuration. The backup contains the same data as the user's
existing Codex config, so it must remain private as well.

## Runtime boundaries

- STDIO is the only MCP transport; the server does not open a listening port.
- Sub2API must use HTTPS, except for explicit loopback testing.
- Reference images must be absolute local paths, cannot be symbolic links, and
  are size- and format-checked before upload.
- The server never downloads a URL returned by Sub2API.
- Generated files use collision-safe names and private file permissions.
- Generation is intentionally not retried automatically because a retry can
  duplicate cost.
- A local timeout does not prove that the upstream job was cancelled. The MCP
  tells the host not to retry without explicit user confirmation; operators
  should check Sub2API request and billing state first.

Piping a remote installer directly to a shell trusts the current default branch
of this repository. Review a downloaded copy first when the environment
requires a stronger software-supply-chain boundary.

## Reporting a vulnerability

Do not include credentials, private images, or production response bodies in a
public issue. Use GitHub private vulnerability reporting if it is enabled for
this repository. Otherwise, contact the repository owner without attaching
sensitive material until a private channel is established.
