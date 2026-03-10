# Change Log

All notable changes to the "ai-auto-responder" extension will be documented in this file.

## [Unreleased]

### Changed

- Refactored query handling into dedicated modules by query type without changing runtime behavior:
  - `@ai` logic moved to `src/queries/normalQuery.ts`
  - `@ai.file` logic moved to `src/queries/wholeFileQuery.ts`
  - `@ai.files` logic moved to `src/queries/filesQuery.ts`
- Kept extension orchestration in `src/extension.ts` and introduced shared interfaces in `src/types.ts`.
- Preserved existing OpenRouter request flow, file-context enrichment behavior, and `@ai.files` autocomplete behavior.
- Added an in-flight request kill switch: pressing `Esc` now cancels active AI calls immediately via abort signal.
- Added comment-aware trigger parsing so queries also work in linted code files (for example `// @ai ... ..` in `.js/.jsx/.ts/.tsx`).

### Documentation

- Rewrote `README.md` with setup, query-mode usage, settings, and refactored architecture details.
