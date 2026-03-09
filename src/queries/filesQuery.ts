import * as vscode from 'vscode';
import { PromptRequest } from '../types';

export function parseFilesAiQuery(triggerText: string, range: vscode.Range): PromptRequest | undefined {
	const filesMatch = triggerText.match(/^@ai\.files\s+([\s\S]*?)\s*\.\.$/);
	if (!filesMatch) {
		return undefined;
	}

	return {
		prompt: filesMatch[1].trim(),
		range,
		wholeFile: false,
		filesMode: true
	};
}

export async function enrichFilesPromptRequest(
	request: PromptRequest,
	setStep: (message: string) => void
): Promise<PromptRequest> {
	setStep('$(sync~spin) Searching for file...');
	const discoveredFiles = await discoverFilesFromPrompt(request.prompt);
	if (discoveredFiles.length === 0) {
		throw new Error('No matching files found for @ai.files query.');
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
	const fileUris = await vscode.workspace.findFiles(
		'**/*',
		'**/{node_modules,.git,out,dist,build,.vscode-test}/**',
		2000
	);
	const allPaths = fileUris
		.map((uri) => vscode.workspace.asRelativePath(uri, false))
		.filter((p) => p && !p.split('/').some((part) => part.startsWith('.')));

	const hints = new Set<string>();

	const explicitTaggedPaths = prompt.match(/(?:^|\s)@([A-Za-z0-9_./-]+)/g) ?? [];
	for (const match of explicitTaggedPaths) {
		const normalized = match.trim().substring(1).replace(/^[./]+/, '');
		if (normalized) {
			hints.add(normalized);
		}
	}

	const explicitPaths = prompt.match(/(?:^|\s)([A-Za-z0-9_./-]+\.[A-Za-z0-9_-]+)(?=\s|$)/g) ?? [];
	for (const match of explicitPaths) {
		if (match.trim().startsWith('@')) {
			continue;
		}

		const normalized = match.trim().replace(/^[./]+/, '');
		if (normalized) {
			hints.add(normalized);
		}
	}

	const fileNameHints = [...prompt.matchAll(/([A-Za-z0-9_.-]+)\s+file\b/gi)]
		.map((m) => m[1].trim())
		.filter(Boolean);
	for (const hint of fileNameHints) {
		hints.add(hint);
	}

	const folderHints = [...prompt.matchAll(/(?:in|on)\s+(?:the\s+)?([A-Za-z0-9_./-]+)\s+folder/gi)]
		.map((m) => m[1].replace(/^[./]+|\/+$/g, ''))
		.filter(Boolean);

	const resolved = new Set<string>();
	for (const hint of hints) {
		const exact = allPaths.find((p) => p === hint || p.endsWith(`/${hint}`));
		if (exact) {
			resolved.add(exact);
			continue;
		}

		const base = hint.split('/').pop() ?? hint;
		const byName = allPaths.filter((p) => p.endsWith(`/${base}`) || p === base);
		for (const candidate of byName) {
			resolved.add(candidate);
		}

		const byContains = allPaths.filter((p) => {
			const leaf = p.split('/').pop() ?? p;
			return leaf.toLowerCase().includes(base.toLowerCase());
		});
		for (const candidate of byContains) {
			resolved.add(candidate);
		}
	}

	if (folderHints.length > 0) {
		for (const folderHint of folderHints) {
			const normalizedFolder = folderHint.toLowerCase();
			for (const candidate of allPaths) {
				if (candidate.toLowerCase().includes(`/${normalizedFolder}/`) || candidate.toLowerCase().startsWith(`${normalizedFolder}/`)) {
					resolved.add(candidate);
				}
			}
		}
	}

	return [...resolved];
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
	const match = linePrefix.match(/^\s*@ai\.files\s+(?:.*[\s])?@([^\s]*)$/);
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
		items.push(item);
	}

	return items;
}
