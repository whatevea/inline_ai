import * as vscode from 'vscode';
import { PromptRequest } from '../types';

export function parseNormalAiQuery(triggerText: string, range: vscode.Range): PromptRequest | undefined {
	const normalMatch = triggerText.match(/^@ai\s+([\s\S]*?)\s*\.\.$/);
	if (!normalMatch) {
		return undefined;
	}

	return {
		prompt: normalMatch[1].trim(),
		range,
		wholeFile: false,
		filesMode: false
	};
}
