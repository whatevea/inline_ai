import * as vscode from 'vscode';
import { parseNormalAiQuery } from './queries/normalQuery';
import { enrichFilesPromptRequest, parseFilesAiQuery, provideFilesCompletionItems } from './queries/filesQuery';
import { parseWholeFileAiQuery } from './queries/wholeFileQuery';
import { OpenRouterConfig, PromptRequest } from './types';

let isProcessing = false;
let activeAbortController: AbortController | undefined;

// Response cache: key is hash of (prompt + fileContext + wholeFile + filesMode), value is response
const responseCache = new Map<string, string>();
const CACHE_MAX_SIZE = 100;

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

// Store document version when starting a request
let activeDocumentUri: vscode.Uri | undefined;
let activeDocumentVersion: number | undefined;

export function activate(context: vscode.ExtensionContext) {
	console.log('Inline AI is now active!');

	const cancelRequestCommand = vscode.commands.registerCommand('ai-auto-responder.cancelRequest', () => {
		activeAbortController?.abort();
	});

	const disposable = vscode.workspace.onDidChangeTextDocument(async (event) => {
		if (isProcessing || event.contentChanges.length === 0) {
			return;
		}

		const editor = vscode.window.activeTextEditor;
		if (!editor || event.document !== editor.document) {
			return;
		}

		const enterPressed = event.contentChanges.some((change) => change.text.includes('\n') || change.text.includes('\r'));
		if (!enterPressed) {
			return;
		}

		// Store document info at the start of the request
		const documentVersionAtStart = event.document.version;
		const documentUriAtStart = event.document.uri.toString();

		const request = await getPromptRequest(event.document, editor.selection.active);
		if (!request) {
			return;
		}

		isProcessing = true;
		const abortController = new AbortController();
		activeAbortController = abortController;
		activeDocumentUri = event.document.uri;
		activeDocumentVersion = documentVersionAtStart;
		await vscode.commands.executeCommand('setContext', 'aiAutoResponder.requestInProgress', true);
		let statusBarMessage: vscode.Disposable | undefined;
		const setStep = (message: string): void => {
			statusBarMessage?.dispose();
			statusBarMessage = vscode.window.setStatusBarMessage(message);
		};

		try {
			setStep('$(sync~spin) Preparing request...');
			const requestWithContext = await enrichPromptRequest(request, setStep);

			// Check cache first
			const cacheKey = getCacheKey(
				requestWithContext.prompt,
				requestWithContext.wholeFile,
				requestWithContext.filesMode,
				requestWithContext.fileContext,
				requestWithContext.filesContext
			);
			const cachedResponse = getCachedResponse(cacheKey);
			if (cachedResponse) {
				setStep('$(check) Using cached response...');
				// Still verify document hasn't changed before editing
				const currentEditor = vscode.window.activeTextEditor;
				if (!currentEditor || currentEditor.document.uri.toString() !== documentUriAtStart) {
					throw new Error('Document changed during request. Aborting edit.');
				}
				if (currentEditor.document.version !== documentVersionAtStart) {
					throw new Error('Document version changed during request. Aborting edit.');
				}
				await currentEditor.edit((editBuilder) => {
					editBuilder.replace(request.range, cachedResponse);
				});
				return;
			}

			setStep('$(sync~spin) Sending request to AI...');
			const response = await queryAIModel(
				requestWithContext.prompt,
				requestWithContext.wholeFile,
				requestWithContext.filesMode,
				requestWithContext.fileContext,
				requestWithContext.filesContext,
				abortController.signal
			);

			// Cache the response
			setCachedResponse(cacheKey, response);

			// Error boundary: Check document hasn't changed before editing
			const currentEditor = vscode.window.activeTextEditor;
			if (!currentEditor || currentEditor.document.uri.toString() !== documentUriAtStart) {
				throw new Error('Document changed during request. Aborting edit.');
			}
			if (currentEditor.document.version !== documentVersionAtStart) {
				throw new Error('Document version changed during request. Aborting edit.');
			}

			await currentEditor.edit((editBuilder) => {
				editBuilder.replace(request.range, response);
			});
		} catch (error) {
			if (abortController.signal.aborted) {
				vscode.window.showInformationMessage('AI request cancelled.');
			} else if (error instanceof Error && error.message.includes('Document')) {
				// Don't show error for document change - it's expected behavior
				console.log('Inline AI:', error.message);
			} else {
				vscode.window.showErrorMessage('AI Error: ' + error);
			}
		} finally {
			isProcessing = false;
			if (activeAbortController === abortController) {
				activeAbortController = undefined;
			}
			activeDocumentUri = undefined;
			activeDocumentVersion = undefined;
			await vscode.commands.executeCommand('setContext', 'aiAutoResponder.requestInProgress', false);
			statusBarMessage?.dispose();
		}
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

	context.subscriptions.push(disposable);
	context.subscriptions.push(fileCompletionProvider);
	context.subscriptions.push(cancelRequestCommand);
}

async function getPromptRequest(document: vscode.TextDocument, cursorPosition: vscode.Position): Promise<PromptRequest | undefined> {
	// Support multiline queries: accumulate lines from trigger line going backwards
	// until we find a line that doesn't end with ..
	const lines: string[] = [];
	let triggerLineIndex = cursorPosition.line - 1;

	// Collect lines going backwards from the current line
	while (triggerLineIndex >= 0) {
		const line = document.lineAt(triggerLineIndex);
		const trimmedLine = normalizeTriggerText(line.text);

		if (lines.length === 0) {
			// First line must contain @ai trigger
			if (!trimmedLine.includes('@ai')) {
				return undefined;
			}
			lines.push(trimmedLine);
		} else {
			// Additional lines - check if this is a continuation (ends with \)
			const lineText = line.text.trim();
			lines.unshift(trimmedLine);

			// Stop if line doesn't end with continuation marker
			if (!lineText.endsWith('\\')) {
				break;
			}
		}

		// If the last collected line ends with ".." (end marker), stop
		const currentLineText = lines[lines.length - 1];
		if (currentLineText.endsWith('..')) {
			break;
		}

		triggerLineIndex--;
	}

	// If we only have one line and it's the trigger line, check if it ends with ..
	// Otherwise, we need more lines
	if (lines.length === 1 && !lines[0].endsWith('..')) {
		// Check if there's a line above that continues
		if (cursorPosition.line > 1) {
			const prevLine = document.lineAt(cursorPosition.line - 2);
			if (!prevLine.text.trim().endsWith('\\')) {
				return undefined;
			}
		}
		return undefined;
	}

	// Join all lines and try to parse
	const combinedText = lines.join('\n');
	const range = document.lineAt(triggerLineIndex + 1).range.union(
		document.lineAt(cursorPosition.line - 1).rangeIncludingLineBreak
	);

	// Try different parsers in order
	return parseWholeFileAiQuery(combinedText, range, document)
		?? parseFilesAiQuery(combinedText, range)
		?? parseNormalAiQuery(combinedText, range);
}

function normalizeTriggerText(rawLine: string): string {
	const trimmed = rawLine.trim();
	const commentPrefixes = [
		'//',
		'#',
		'/*',
		'*',
		'<!--',
		'--'
	];

	for (const prefix of commentPrefixes) {
		if (trimmed.startsWith(prefix)) {
			return trimmed.slice(prefix.length).trim();
		}
	}

	return trimmed;
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

function getOpenRouterConfig(): OpenRouterConfig {
	const config = vscode.workspace.getConfiguration('aiAutoResponder');

	return {
		apiKey: config.get<string>('openRouterApiKey', '').trim(),
		model: config.get<string>('openRouterModel', 'minimax/minimax-m2.5').trim(),
		rolePrompt: config.get<string>('rolePrompt', 'You are AI which gives short answer').trim(),
		wholeFileRolePrompt: config.get<string>('wholeFileRolePrompt', 'You are an expert coding assistant. Use the provided full file context and return the best code completion or edit response for the query.').trim(),
		filesRolePrompt: config.get<string>('filesRolePrompt', 'You are a coding assistant. Use the provided retrieved file contents as context and answer precisely.').trim(),
		enableReasoning: config.get<boolean>('enableReasoning', true),
		providerSort: config.get<string>('providerSort', 'price').trim()
	};
}

async function queryAIModel(
	prompt: string,
	wholeFile: boolean,
	filesMode: boolean,
	fileContext?: string,
	filesContext?: string,
	signal?: AbortSignal
): Promise<string> {
	const config = getOpenRouterConfig();
	if (!config.apiKey) {
		throw new Error('Missing OpenRouter API key. Set aiAutoResponder.openRouterApiKey in settings.');
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

	const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${config.apiKey}`,
			'Content-Type': 'application/json'
		},
		signal,
		body: JSON.stringify({
			model: config.model,
			messages: [
				{
					role: 'user',
					content
				}
			],
			reasoning: { enabled: config.enableReasoning },
			provider: { sort: config.providerSort }
		})
	});

	const data: any = await response.json();
	if (!response.ok) {
		const errorText = data?.error?.message || `HTTP ${response.status}`;
		throw new Error(errorText);
	}

	const aiText = data?.choices?.[0]?.message?.content;
	if (!aiText || typeof aiText !== 'string') {
		throw new Error('No text returned from OpenRouter model.');
	}

	return `\n${aiText}\n`;
}

export function deactivate() { }
