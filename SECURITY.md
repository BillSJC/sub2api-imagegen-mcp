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
best-effort secret scan, but that scan is not a substitute for review.

## Runtime boundaries

- STDIO is the only MCP transport; the server does not open a listening port.
- Sub2API must use HTTPS, except for explicit loopback testing.
- Reference images must be absolute local paths, cannot be symbolic links, and
  are size- and format-checked before upload.
- The server never downloads a URL returned by Sub2API.
- Generated files use collision-safe names and private file permissions.
- Generation is intentionally not retried automatically because a retry can
  duplicate cost.

## Reporting a vulnerability

Do not include credentials, private images, or production response bodies in a
public issue. Use GitHub private vulnerability reporting if it is enabled for
this repository. Otherwise, contact the repository owner without attaching
sensitive material until a private channel is established.
