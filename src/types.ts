import * as vscode from 'vscode';

export interface OpenRouterConfig {
	apiKey: string;
	model: string;
	rolePrompt: string;
	wholeFileRolePrompt: string;
	filesRolePrompt: string;
	enableReasoning: boolean;
	providerSort: string;
}

export interface PromptRequest {
	prompt: string;
	range: vscode.Range;
	wholeFile: boolean;
	filesMode: boolean;
	fileContext?: string;
	filesContext?: string;
}
