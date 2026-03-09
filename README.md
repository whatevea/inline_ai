# AI Auto Responder

VS Code extension that listens for inline `@ai` query lines and replaces them with model output from OpenRouter.

## Query Modes

- `@ai <query> ..`
  - Runs a normal query with no extra file context.
- `@ai.wholefile <query> ..`
  - Sends the current full editor file content plus your query.
- `@ai.files <query> ..`
  - Resolves file hints from your query, reads matched workspace files, and sends that context.

Comment-friendly variants are also supported (useful for strict linters in `.js/.jsx/.ts/.tsx`):

- `// @ai <query> ..`
- `# @ai <query> ..`
- `/* @ai <query> .. */` (single-line style)
- `* @ai <query> ..` (block comment body line)

Press Enter on the next line after writing a query line to trigger replacement.

## Kill Switch (Esc)

While an AI request is running, press `Esc` to cancel immediately.  
This aborts the in-flight OpenRouter call and keeps your text unchanged.

## File Autocomplete in `@ai.files`

Inside an `@ai.files` query, type `@` to get workspace file suggestions.

Example:

```text
@ai.files explain this @src/extension.ts and @README.md ..
```

## Settings

Configure under `aiAutoResponder.*`:

- `openRouterApiKey`: OpenRouter API key (required)
- `openRouterModel`: model id (default `minimax/minimax-m2.5`)
- `rolePrompt`: role prompt for `@ai`
- `wholeFileRolePrompt`: role prompt for `@ai.wholefile`
- `filesRolePrompt`: role prompt for `@ai.files`
- `enableReasoning`: send reasoning flag
- `providerSort`: provider sort strategy (`price`, `latency`, etc.)

## Refactored Structure

Query handling is split by mode to keep logic isolated and maintainable:

- `src/queries/normalQuery.ts`: `@ai` parsing
- `src/queries/wholeFileQuery.ts`: `@ai.wholefile` parsing + file context capture
- `src/queries/filesQuery.ts`: `@ai.files` parsing, file discovery/context, file completion suggestions
- `src/extension.ts`: orchestration, editor event flow, OpenRouter request
- `src/types.ts`: shared request/config types

## Notes

- Hidden folders and large generated folders are skipped during file discovery.
- Large files over 100KB are not fully inlined in `@ai.files` context.
