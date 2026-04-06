import * as vscode from 'vscode';
import { PromptRequest } from '../types';

export async function enrichFilesPromptRequest(
	request: PromptRequest,
	setStep: (message: string) => void
): Promise<PromptRequest> {
	setStep('$(sync~spin) Searching for file...');
	const discoveredFiles = await discoverFilesFromPrompt(request.prompt);
	if (discoveredFiles.length === 0) {
		return request;
	}

	setStep(`$(check) Found file(s): ${discoveredFiles.length}`);
	setStep('$(sync~spin) Reading files...');
	const filesContext = await getFilesContext(discoveredFiles);

	return {
		...request,
		filesContext
	};
}

export async function discoverFilesFromPrompt(prompt: string): Promise<string[]> {
	if (!vscode.workspace.workspaceFolders?.length) {
		return [];
	}

	const taggedPaths = [...prompt.matchAll(/(?:^|\s)@([A-Za-z0-9_./-]+)/g)]
		.map((m) => m[1].trim().replace(/^[./]+/, '').replace(/\/+$/g, ''))
		.filter(Boolean);

	if (taggedPaths.length === 0) {
		return [];
	}

	const unique = [...new Set(taggedPaths)];
	const existing: string[] = [];

	for (const relPath of unique) {
		let found = false;
		for (const folder of vscode.workspace.workspaceFolders) {
			const candidate = vscode.Uri.joinPath(folder.uri, relPath);
			try {
				await vscode.workspace.fs.stat(candidate);
				existing.push(vscode.workspace.asRelativePath(candidate, false));
				found = true;
				break;
			} catch {
				// Try next workspace folder.
			}
		}

		if (!found) {
			throw new Error(`Referenced file not found: @${relPath}`);
		}
	}

	return existing;
}

export async function getFilesContext(filePaths: string[]): Promise<string> {
	if (filePaths.length === 0 || !vscode.workspace.workspaceFolders?.length) {
		return '';
	}

	const decoder = new TextDecoder('utf-8');
	const sections: string[] = [];

	for (const filePath of filePaths) {
		const cleanPath = filePath.replace(/^[./]+/, '');
		let content: string | undefined;
		let resolvedPath = filePath;

		for (const folder of vscode.workspace.workspaceFolders) {
			const candidate = vscode.Uri.joinPath(folder.uri, cleanPath);
			try {
				const bytes = await vscode.workspace.fs.readFile(candidate);
				if (bytes.length > 100_000) {
					content = `[Skipped: file too large (${bytes.length} bytes)]`;
				} else {
					content = decoder.decode(bytes);
				}
				resolvedPath = vscode.workspace.asRelativePath(candidate, false);
				break;
			} catch {
				// Try next workspace folder.
			}
		}

		if (!content) {
			sections.push(`File: ${filePath}\n[Could not read file]`);
			continue;
		}

		sections.push(`File: ${resolvedPath}\n${content}`);
	}

	if (sections.length === 0) {
		return '';
	}

	return `Referenced files context:\n\n${sections.join('\n\n')}`;
}

export async function provideFilesCompletionItems(
	document: vscode.TextDocument,
	position: vscode.Position
): Promise<vscode.CompletionItem[] | undefined> {
	const linePrefix = document.lineAt(position).text.slice(0, position.character);
	const match = linePrefix.match(/^\s*(?:(?:\/\/|#|;|\/\*|\*|<!--|--|>)\s*)?@ai\.file\s+(?:.*[\s])?@([^\s]*)$/);
	if (!match) {
		return undefined;
	}

	const fileUris = await vscode.workspace.findFiles(
		'**/*',
		'**/{node_modules,.git,out,dist,build,.vscode-test}/**',
		2000
	);

	const items: vscode.CompletionItem[] = [];
	for (const uri of fileUris) {
		const relPath = vscode.workspace.asRelativePath(uri, false);
		const item = new vscode.CompletionItem(relPath, vscode.CompletionItemKind.File);
		const wordStart = position.character - match[1].length;

		item.range = new vscode.Range(position.line, wordStart, position.line, position.character);
		item.detail = 'Workspace File (AI Context)';

		// THE MAGIC SAUCE:
		// '\0' forces VS Code to place your completion items at the absolute top of the autocomplete window.
		// Built-in JavaScript/TypeScript MDN definitions will be pushed safely to the bottom.
		item.sortText = '\0' + relPath;

		// Automatically highlights the first matched file so you can just press 'Enter'
		item.preselect = true;

		items.push(item);
	}

	return items;
}
