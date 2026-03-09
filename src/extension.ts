import * as vscode from 'vscode';
import { parseNormalAiQuery } from './queries/normalQuery';
import { enrichFilesPromptRequest, parseFilesAiQuery, provideFilesCompletionItems } from './queries/filesQuery';
import { parseWholeFileAiQuery } from './queries/wholeFileQuery';
import { OpenRouterConfig, PromptRequest } from './types';

let isProcessing = false;
let activeAbortController: AbortController | undefined;

export function activate(context: vscode.ExtensionContext) {
	console.log('AI Auto-Responder is now active!');

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

		const request = await getPromptRequest(event.document, editor.selection.active);
		if (!request) {
			return;
		}

		isProcessing = true;
		const abortController = new AbortController();
		activeAbortController = abortController;
		await vscode.commands.executeCommand('setContext', 'aiAutoResponder.requestInProgress', true);
		let statusBarMessage: vscode.Disposable | undefined;
		const setStep = (message: string): void => {
			statusBarMessage?.dispose();
			statusBarMessage = vscode.window.setStatusBarMessage(message);
		};

		try {
			setStep('$(sync~spin) Preparing request...');
			const requestWithContext = await enrichPromptRequest(request, setStep);
			setStep('$(sync~spin) Sending request to AI...');
			const response = await queryAIModel(
				requestWithContext.prompt,
				requestWithContext.wholeFile,
				requestWithContext.filesMode,
				requestWithContext.fileContext,
				requestWithContext.filesContext,
				abortController.signal
			);

			await editor.edit((editBuilder) => {
				editBuilder.replace(request.range, response);
			});
		} catch (error) {
			if (abortController.signal.aborted) {
				vscode.window.showInformationMessage('AI request cancelled.');
			} else {
				vscode.window.showErrorMessage('AI Error: ' + error);
			}
		} finally {
			isProcessing = false;
			if (activeAbortController === abortController) {
				activeAbortController = undefined;
			}
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
	if (cursorPosition.line === 0) {
		return undefined;
	}

	const triggerLineIndex = cursorPosition.line - 1;
	const triggerLine = document.lineAt(triggerLineIndex);
	const triggerText = normalizeTriggerText(triggerLine.text);
	const range = triggerLine.rangeIncludingLineBreak;

	return parseWholeFileAiQuery(triggerText, range, document)
		?? parseFilesAiQuery(triggerText, range)
		?? parseNormalAiQuery(triggerText, range);
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
