import * as vscode from 'vscode';
import { parseNormalAiQuery } from './queries/normalQuery';
import { enrichFilesPromptRequest, parseFilesAiQuery, provideFilesCompletionItems } from './queries/filesQuery';
import { parseWholeFileAiQuery } from './queries/wholeFileQuery';
import { AiProviderConfig, PromptRequest } from './types';

let isProcessing = false;
let activeAbortController: AbortController | undefined;

// Response cache: key is hash of (prompt + fileContext + wholeFile + filesMode), value is response
const responseCache = new Map<string, string>();
const CACHE_MAX_SIZE = 100;
const MAX_QUERY_LINES = 80;

function getCacheKey(prompt: string, wholeFile: boolean, filesMode: boolean, fileContext?: string, filesContext?: string): string {
	return JSON.stringify({ prompt, wholeFile, filesMode, fileContext, filesContext });
}

function getCachedResponse(key: string): string | undefined {
	return responseCache.get(key);
}

function setCachedResponse(key: string, response: string): void {
	// Simple cache eviction: clear oldest entries if cache is full
	if (responseCache.size >= CACHE_MAX_SIZE) {
		const firstKey = responseCache.keys().next().value;
		if (firstKey) {
			responseCache.delete(firstKey);
		}
	}
	responseCache.set(key, response);
}

export function activate(context: vscode.ExtensionContext) {
	console.log('Inline AI is now active!');

	const cancelRequestCommand = vscode.commands.registerCommand('ai-auto-responder.cancelRequest', () => {
		activeAbortController?.abort();
	});

	const runInlineQueriesCommand = vscode.commands.registerCommand('ai-auto-responder.runInlineQueries', async () => {
		await runInlineQueriesInActiveEditor();
	});

	const fileCompletionProvider = vscode.languages.registerCompletionItemProvider(
		[{ scheme: 'file' }, { scheme: 'untitled' }],
		{
			async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position) {
				return provideFilesCompletionItems(document, position);
			}
		},
		'@'
	);

	context.subscriptions.push(fileCompletionProvider);
	context.subscriptions.push(cancelRequestCommand);
	context.subscriptions.push(runInlineQueriesCommand);
}

async function runInlineQueriesInActiveEditor(): Promise<void> {
	if (isProcessing) {
		vscode.window.showInformationMessage('AI request already in progress.');
		return;
	}

	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return;
	}

	const document = editor.document;
	const documentVersionAtStart = document.version;
	const documentUriAtStart = document.uri.toString();
	const requests = collectPromptRequests(document);
	if (requests.length === 0) {
		return;
	}

	isProcessing = true;
	const abortController = new AbortController();
	activeAbortController = abortController;
	await vscode.commands.executeCommand('setContext', 'aiAutoResponder.requestInProgress', true);
	const statusBarMessage = vscode.window.setStatusBarMessage(`$(sync~spin) Processing ${requests.length} AI quer${requests.length === 1 ? 'y' : 'ies'}...`);

	try {
		const results = await Promise.allSettled(
			requests.map(async (request) => {
				const requestWithContext = await enrichPromptRequest(request, () => {
					// Keep status stable while processing all prompts in parallel.
				});

				const cacheKey = getCacheKey(
					requestWithContext.prompt,
					requestWithContext.wholeFile,
					requestWithContext.filesMode,
					requestWithContext.fileContext,
					requestWithContext.filesContext
				);
				const cachedResponse = getCachedResponse(cacheKey);
				if (cachedResponse) {
					return { request, response: cachedResponse };
				}

				const response = await queryAIModel(
					requestWithContext.prompt,
					requestWithContext.wholeFile,
					requestWithContext.filesMode,
					requestWithContext.fileContext,
					requestWithContext.filesContext,
					abortController.signal
				);
				setCachedResponse(cacheKey, response);
				return { request, response };
			})
		);

		if (abortController.signal.aborted) {
			vscode.window.showInformationMessage('AI request cancelled.');
			return;
		}

		const currentEditor = vscode.window.activeTextEditor;
		if (!currentEditor || currentEditor.document.uri.toString() !== documentUriAtStart) {
			throw new Error('Document changed during request. Aborting edit.');
		}
		if (currentEditor.document.version !== documentVersionAtStart) {
			throw new Error('Document version changed during request. Aborting edit.');
		}

		const successful = results
			.filter((result): result is PromiseFulfilledResult<{ request: PromptRequest; response: string }> => result.status === 'fulfilled')
			.map((result) => result.value);

		if (successful.length > 0) {
			successful.sort((a, b) => {
				if (a.request.range.start.line !== b.request.range.start.line) {
					return b.request.range.start.line - a.request.range.start.line;
				}
				return b.request.range.start.character - a.request.range.start.character;
			});

			await currentEditor.edit((editBuilder) => {
				for (const item of successful) {
					editBuilder.replace(item.request.range, item.response);
				}
			});
		}

		const failed = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
		if (failed.length > 0) {
			const message = failed[0].reason instanceof Error ? failed[0].reason.message : String(failed[0].reason);
			vscode.window.showErrorMessage(`Processed ${successful.length}/${requests.length} AI queries. First error: ${message}`);
		}
	} catch (error) {
		if (abortController.signal.aborted) {
			vscode.window.showInformationMessage('AI request cancelled.');
		} else if (error instanceof Error && error.message.includes('Document')) {
			console.log('Inline AI:', error.message);
		} else {
			vscode.window.showErrorMessage('AI Error: ' + error);
		}
	} finally {
		isProcessing = false;
		if (activeAbortController === abortController) {
			activeAbortController = undefined;
		}
		await vscode.commands.executeCommand('setContext', 'aiAutoResponder.requestInProgress', false);
		statusBarMessage.dispose();
	}
}

function collectPromptRequests(document: vscode.TextDocument): PromptRequest[] {
	const requests: PromptRequest[] = [];
	for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex++) {
		const normalizedLine = normalizeTriggerText(document.lineAt(lineIndex).text);
		if (!/^@ai(?:\.wholefile|\.files)?\b/.test(normalizedLine)) {
			continue;
		}

		const maxEndLine = Math.min(document.lineCount - 1, lineIndex + MAX_QUERY_LINES - 1);
		let queryEndLine = -1;
		for (let endLine = lineIndex; endLine <= maxEndLine; endLine++) {
			const normalizedEndLine = normalizeTriggerText(document.lineAt(endLine).text);
			if (normalizedEndLine.endsWith('..')) {
				queryEndLine = endLine;
				break;
			}
		}

		if (queryEndLine === -1) {
			continue;
		}

		const lines: string[] = [];
		for (let current = lineIndex; current <= queryEndLine; current++) {
			lines.push(normalizeTriggerText(document.lineAt(current).text));
		}

		const combinedText = lines.join('\n');
		const range = new vscode.Range(
			document.lineAt(lineIndex).range.start,
			document.lineAt(queryEndLine).rangeIncludingLineBreak.end
		);

		const request = parseWholeFileAiQuery(combinedText, range, document)
			?? parseFilesAiQuery(combinedText, range)
			?? parseNormalAiQuery(combinedText, range);
		if (request) {
			requests.push(request);
			lineIndex = queryEndLine;
		}
	}

	return requests;
}

function normalizeTriggerText(rawLine: string): string {
	const trimmed = rawLine.trim();
	const commentPrefixes = [
		'//',
		'#',
		';',
		'/*',
		'*',
		'<!--',
		'--',
		'>'
	];

	for (const prefix of commentPrefixes) {
		if (trimmed.startsWith(prefix)) {
			return trimmed.slice(prefix.length).trim();
		}
	}

	return trimmed;
}

function sanitizeModelText(rawText: string): string {
	let cleaned = rawText.trim();
	const fencedBlockMatch = cleaned.match(/^```(?:[A-Za-z0-9_+-]+)?\s*\n([\s\S]*?)\n```$/);
	if (fencedBlockMatch) {
		cleaned = fencedBlockMatch[1].trim();
	}
	return cleaned;
}

async function enrichPromptRequest(
	request: PromptRequest,
	setStep: (message: string) => void
): Promise<PromptRequest> {
	if (!request.filesMode) {
		return request;
	}

	return enrichFilesPromptRequest(request, setStep);
}

function getProviderConfig(): AiProviderConfig {
	const config = vscode.workspace.getConfiguration('aiAutoResponder');
	const provider = config.get<'openRouter' | 'openAiCompatible'>('provider', 'openRouter');

	return {
		provider,
		apiKey: provider === 'openAiCompatible'
			? config.get<string>('openAiApiKey', '').trim()
			: config.get<string>('openRouterApiKey', '').trim(),
		model: provider === 'openAiCompatible'
			? config.get<string>('openAiModel', '').trim()
			: config.get<string>('openRouterModel', 'minimax/minimax-m2.5').trim(),
		baseUrl: config.get<string>('openAiBaseUrl', '').trim(),
		rolePrompt: config.get<string>('rolePrompt', 'You are AI which gives short answer').trim(),
		wholeFileRolePrompt: config.get<string>('wholeFileRolePrompt', 'You are an expert coding assistant. Use the provided full file context and return the best code completion or edit response for the query.').trim(),
		filesRolePrompt: config.get<string>('filesRolePrompt', 'You are a coding assistant. Use the provided retrieved file contents as context and answer precisely.').trim(),
		enableReasoning: config.get<boolean>('enableReasoning', true),
		providerSort: config.get<string>('providerSort', 'price').trim()
	};
}

function buildOpenAiCompatibleUrl(baseUrl: string): string {
	const trimmed = baseUrl.replace(/\/+$/, '');
	if (trimmed.endsWith('/chat/completions')) {
		return trimmed;
	}
	if (trimmed.endsWith('/v1')) {
		return `${trimmed}/chat/completions`;
	}
	return `${trimmed}/v1/chat/completions`;
}

async function queryAIModel(
	prompt: string,
	wholeFile: boolean,
	filesMode: boolean,
	fileContext?: string,
	filesContext?: string,
	signal?: AbortSignal
): Promise<string> {
	const config = getProviderConfig();

	if (!config.apiKey) {
		throw new Error(
			config.provider === 'openAiCompatible'
				? 'Missing OpenAI compatible API key. Set aiAutoResponder.openAiApiKey in settings.'
				: 'Missing OpenRouter API key. Set aiAutoResponder.openRouterApiKey in settings.'
		);
	}
	if (!config.model) {
		throw new Error(
			config.provider === 'openAiCompatible'
				? 'Missing OpenAI compatible model. Set aiAutoResponder.openAiModel in settings.'
				: 'Missing OpenRouter model. Set aiAutoResponder.openRouterModel in settings.'
		);
	}
	if (config.provider === 'openAiCompatible' && !config.baseUrl) {
		throw new Error('Missing OpenAI compatible base URL. Set aiAutoResponder.openAiBaseUrl in settings.');
	}

	const finalPrompt = wholeFile
		? `Full file context:\n\n${fileContext ?? ''}\n\nUser request:\n${prompt}`
		: prompt;
	const withFilesContext = filesContext ? `${filesContext}\n\nUser request:\n${finalPrompt}` : finalPrompt;
	const selectedRolePrompt = wholeFile
		? config.wholeFileRolePrompt
		: filesMode
			? config.filesRolePrompt
			: config.rolePrompt;
	const content = selectedRolePrompt ? `${selectedRolePrompt}\n\n${withFilesContext}` : withFilesContext;

	const endpoint = config.provider === 'openAiCompatible'
		? buildOpenAiCompatibleUrl(config.baseUrl)
		: 'https://openrouter.ai/api/v1/chat/completions';

	const requestBody: Record<string, unknown> = {
		model: config.model,
		messages: [
			{
				role: 'user',
				content
			}
		]
	};

	if (config.provider === 'openRouter') {
		requestBody.reasoning = { enabled: config.enableReasoning };
		requestBody.provider = { sort: config.providerSort };
	}

	const response = await fetch(endpoint, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${config.apiKey}`,
			'Content-Type': 'application/json'
		},
		signal,
		body: JSON.stringify(requestBody)
	});

	const data: any = await response.json();
	if (!response.ok) {
		const errorText = data?.error?.message || `HTTP ${response.status}`;
		throw new Error(errorText);
	}

	const aiText = data?.choices?.[0]?.message?.content;
	if (!aiText || typeof aiText !== 'string') {
		throw new Error(
			config.provider === 'openAiCompatible'
				? 'No text returned from OpenAI compatible model.'
				: 'No text returned from OpenRouter model.'
		);
	}

	return sanitizeModelText(aiText);
}

export function deactivate() { }
