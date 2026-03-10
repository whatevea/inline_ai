import * as vscode from 'vscode';

export type AiProvider = 'openRouter' | 'openAiCompatible';

export interface AiProviderConfig {
	provider: AiProvider;
	apiKey: string;
	model: string;
	baseUrl: string;
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
