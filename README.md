# AI Auto Responder

VS Code extension that listens for inline `@ai` query lines and replaces them with model output from a configurable provider.

## Query Modes

- `@ai <query> ..`
  - Runs a normal query with no extra file context.
- `@ai.file <query> ..`
  - Sends the current full editor file content plus your query.
  - You can also include extra workspace files with inline `@path` tags (for example `@src/extension.ts`).

Comment-friendly variants are also supported (useful for strict linters in `.js/.jsx/.ts/.tsx`):

- `// @ai <query> ..`
- `# @ai <query> ..`
- `/* @ai <query> .. */` (single-line style)
- `* @ai <query> ..` (block comment body line)

Press `Ctrl+Enter` (or `Cmd+Enter` on macOS) to run queries.
The command scans the whole active file for completed `@ai... ..` blocks, processes them in parallel, and replaces each block in place.
You can remap this in `keybindings.json` by changing `ai-auto-responder.runInlineQueries`.

## Kill Switch (Esc)

While an AI request is running, press `Esc` to cancel immediately.  
This aborts the in-flight AI call and keeps your text unchanged.

## File Autocomplete in `@ai.file`

Inside an `@ai.file` query, type a second `@` to get workspace file suggestions.

Example:

```text
@ai.file explain this @src/extension.ts and @README.md ..
```

## Settings

Configure under `aiAutoResponder.*`:

- `provider`: `openRouter` or `openAiCompatible`
- `openRouterApiKey`: OpenRouter API key (required when provider is `openRouter`)
- `openRouterModel`: OpenRouter model id (default `minimax/minimax-m2.5`)
- `openAiBaseUrl`: OpenAI-compatible base URL (required when provider is `openAiCompatible`, for example `https://api.groq.com/openai/v1`)
- `openAiApiKey`: OpenAI-compatible API key (required when provider is `openAiCompatible`)
- `openAiModel`: OpenAI-compatible model id (required when provider is `openAiCompatible`)
- `rolePrompt`: role prompt for `@ai`
- `wholeFileRolePrompt`: role prompt for `@ai.file`
- `enableReasoning`: send reasoning flag (OpenRouter only)
- `providerSort`: provider sort strategy (`price`, `latency`, etc., OpenRouter only)

## Refactored Structure

Query handling is split by mode to keep logic isolated and maintainable:

- `src/queries/normalQuery.ts`: `@ai` parsing
- `src/queries/wholeFileQuery.ts`: `@ai.file` parsing + file context capture
- `src/queries/filesQuery.ts`: `@ai.file` referenced-file discovery/context + file completion suggestions
- `src/extension.ts`: orchestration, editor event flow, provider request
- `src/types.ts`: shared request/config types

## Notes

- Hidden folders and large generated folders are skipped during file discovery.
- Large files over 100KB are not fully inlined when referenced via `@path` in `@ai.file` context.
