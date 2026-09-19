# Changelog

All notable changes to `@execuro-sw-ecosystem/sw-tender-discovery-tool`.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- A filesystem watch error (for example `EMFILE` under file-descriptor
  pressure) no longer crashes the server process: the dead watcher is dropped,
  the page is told that edits made outside it are not picked up, and the watch
  is retried three times with a short backoff before it gives up.

### Added

- First packaged release. Previously an internal tool inside a Shopware
  agentic harness; now a standalone repository and npm package.
- `skills/sw-tender-discovery-tool/SKILL.md` — the stub skill, shipped in the
  package and installed into a host by
  `sw-tender-discovery-tool install-skill`. The tender *method* stays in the
  harness's own `sw-discover-tender` skill; this one only drives the page.
- `lib/paths.mjs` — project-root resolution by walk-up from the document, so the
  CLI no longer depends on the caller's working directory.
- MIT `LICENSE`, `THIRD-PARTY-NOTICES.md`, consumer `README.md`.
- Tag-driven release: pushing `v<version>` publishes to npm from GitHub Actions
  with `--provenance`, authenticated by OIDC trusted publishing. No npm token
  is stored in this repository.
- `scripts/check-version.mjs` — refuses a release whose shipped skill pins a
  different CLI version than `package.json` declares.
- `test/conformance.test.mjs` — the shared editor-CLI contract, vendored
  byte-for-byte from the sibling package apart from its command list.

### Fixed

- `poll` printed `batch_file` as a project-relative path. The agent resolves it
  against *its own* working directory, which need not be the one the CLI ran in,
  so a batch polled from a subdirectory named a file that was not there. It is
  now absolute, with `batch_file_rel` alongside it for logs; the batch payload
  gained `root`, `fileAbs`, `contextAbs`, `analysisAbs` and `sourceAbs` twins.
  The relative fields the page reads are unchanged.
- `start` now refuses a document outside the project root with a usage error
  instead of opening a session whose state lands where nothing will look for it.

[Unreleased]: https://github.com/execuro/sw-tender-discovery-tool/compare/v0.1.0...HEAD
