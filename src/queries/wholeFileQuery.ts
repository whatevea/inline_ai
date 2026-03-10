import * as vscode from 'vscode';
import { PromptRequest } from '../types';

export function parseWholeFileAiQuery(
	triggerText: string,
	range: vscode.Range,
	document: vscode.TextDocument
): PromptRequest | undefined {
	const wholeFileMatch = triggerText.match(/^@ai\.file\s+([\s\S]*?)\s*\.\.$/);
	if (!wholeFileMatch) {
		return undefined;
	}

	return {
		prompt: wholeFileMatch[1].trim(),
		range,
		wholeFile: true,
		filesMode: false,
		fileContext: document.getText()
	};
}
