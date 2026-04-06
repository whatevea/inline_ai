import * as vscode from 'vscode';

export class SettingsSidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'inline-ai.settingsView';

    constructor(private readonly _extensionUri: vscode.Uri) { }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview();

        // Send initial config to the webview
        this._sendConfigToWebview(webviewView.webview);

        // Listen for config changes made outside the webview (e.g., manual settings.json edits)
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('aiAutoResponder')) {
                this._sendConfigToWebview(webviewView.webview);
            }
        });

        // Listen for messages from the webview
        webviewView.webview.onDidReceiveMessage(async (data) => {
            if (data.type === 'saveSettings') {
                const config = vscode.workspace.getConfiguration('aiAutoResponder');

                try {
                    await config.update('provider', data.settings.provider, vscode.ConfigurationTarget.Global);
                    await config.update('openRouterApiKey', data.settings.openRouterApiKey, vscode.ConfigurationTarget.Global);
                    await config.update('openRouterModel', data.settings.openRouterModel, vscode.ConfigurationTarget.Global);
                    await config.update('openAiBaseUrl', data.settings.openAiBaseUrl, vscode.ConfigurationTarget.Global);
                    await config.update('openAiApiKey', data.settings.openAiApiKey, vscode.ConfigurationTarget.Global);
                    await config.update('openAiModel', data.settings.openAiModel, vscode.ConfigurationTarget.Global);
                    await config.update('rolePrompt', data.settings.rolePrompt, vscode.ConfigurationTarget.Global);
                    await config.update('wholeFileRolePrompt', data.settings.wholeFileRolePrompt, vscode.ConfigurationTarget.Global);

                    vscode.window.showInformationMessage('Inline AI settings saved successfully!');
                } catch (error) {
                    vscode.window.showErrorMessage('Failed to save settings: ' + error);
                }
            }
        });
    }

    private _sendConfigToWebview(webview: vscode.Webview) {
        const config = vscode.workspace.getConfiguration('aiAutoResponder');
        webview.postMessage({
            type: 'loadSettings',
            settings: {
                provider: config.get('provider', 'openRouter'),
                openRouterApiKey: config.get('openRouterApiKey', ''),
                openRouterModel: config.get('openRouterModel', 'minimax/minimax-m2.5'),
                openAiBaseUrl: config.get('openAiBaseUrl', ''),
                openAiApiKey: config.get('openAiApiKey', ''),
                openAiModel: config.get('openAiModel', ''),
                rolePrompt: config.get('rolePrompt', ''),
                wholeFileRolePrompt: config.get('wholeFileRolePrompt', '')
            }
        });
    }

    private _getHtmlForWebview() {
        return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>Inline AI Settings</title>
				<style>
					body {
						font-family: var(--vscode-font-family);
						padding: 10px;
						color: var(--vscode-foreground);
						background-color: var(--vscode-sideBar-background);
					}
					.form-group {
						margin-bottom: 15px;
					}
					label {
						display: block;
						margin-bottom: 5px;
						font-weight: 600;
						font-size: 12px;
					}
					input, select, textarea {
						width: 100%;
						box-sizing: border-box;
						padding: 6px;
						background-color: var(--vscode-input-background);
						color: var(--vscode-input-foreground);
						border: 1px solid var(--vscode-input-border);
						border-radius: 2px;
						font-family: var(--vscode-font-family);
					}
					textarea {
						resize: vertical;
						min-height: 80px;
					}
					button {
						width: 100%;
						padding: 8px;
						background-color: var(--vscode-button-background);
						color: var(--vscode-button-foreground);
						border: none;
						border-radius: 2px;
						cursor: pointer;
						font-weight: bold;
						margin-top: 10px;
					}
					button:hover {
						background-color: var(--vscode-button-hoverBackground);
					}
					.section-title {
						margin-top: 20px;
						margin-bottom: 10px;
						font-size: 14px;
						border-bottom: 1px solid var(--vscode-panel-border);
						padding-bottom: 4px;
					}
					.hidden {
						display: none;
					}
				</style>
			</head>
			<body>
				<div class="form-group">
					<label for="provider">AI Provider</label>
					<select id="provider">
						<option value="openRouter">OpenRouter</option>
						<option value="openAiCompatible">OpenAI Compatible</option>
					</select>
				</div>

				<!-- OpenRouter Settings -->
				<div id="openRouterSection">
					<div class="section-title">OpenRouter Settings</div>
					<div class="form-group">
						<label for="openRouterApiKey">API Key</label>
						<input type="password" id="openRouterApiKey" placeholder="sk-or-v1-..." />
					</div>
					<div class="form-group">
						<label for="openRouterModel">Model</label>
						<input type="text" id="openRouterModel" placeholder="minimax/minimax-m2.5" />
					</div>
				</div>

				<!-- OpenAI Compatible Settings -->
				<div id="openAiSection" class="hidden">
					<div class="section-title">OpenAI Compatible Settings</div>
					<div class="form-group">
						<label for="openAiBaseUrl">Base URL</label>
						<input type="text" id="openAiBaseUrl" placeholder="https://api.groq.com/openai/v1" />
					</div>
					<div class="form-group">
						<label for="openAiApiKey">API Key</label>
						<input type="password" id="openAiApiKey" placeholder="sk-..." />
					</div>
					<div class="form-group">
						<label for="openAiModel">Model</label>
						<input type="text" id="openAiModel" placeholder="llama-3-8b-8192" />
					</div>
				</div>

				<!-- Prompts -->
				<div class="section-title">Role Prompts</div>
				<div class="form-group">
					<label for="rolePrompt">Standard Role Prompt (@ai)</label>
					<textarea id="rolePrompt"></textarea>
				</div>
				<div class="form-group">
					<label for="wholeFileRolePrompt">File Prompt (@ai.file)</label>
					<textarea id="wholeFileRolePrompt"></textarea>
				</div>

				<button id="saveBtn">Save Settings</button>

				<script>
					const vscode = acquireVsCodeApi();

					const providerSelect = document.getElementById('provider');
					const openRouterSection = document.getElementById('openRouterSection');
					const openAiSection = document.getElementById('openAiSection');

					// Handle provider toggle
					providerSelect.addEventListener('change', (e) => {
						if (e.target.value === 'openRouter') {
							openRouterSection.classList.remove('hidden');
							openAiSection.classList.add('hidden');
						} else {
							openRouterSection.classList.add('hidden');
							openAiSection.classList.remove('hidden');
						}
					});

					// Receive config from extension
					window.addEventListener('message', event => {
						const message = event.data;
						if (message.type === 'loadSettings') {
							const settings = message.settings;
							
							document.getElementById('provider').value = settings.provider;
							document.getElementById('openRouterApiKey').value = settings.openRouterApiKey;
							document.getElementById('openRouterModel').value = settings.openRouterModel;
							document.getElementById('openAiBaseUrl').value = settings.openAiBaseUrl;
							document.getElementById('openAiApiKey').value = settings.openAiApiKey;
							document.getElementById('openAiModel').value = settings.openAiModel;
							document.getElementById('rolePrompt').value = settings.rolePrompt;
							document.getElementById('wholeFileRolePrompt').value = settings.wholeFileRolePrompt;

							// Trigger change event to update UI visibility
							providerSelect.dispatchEvent(new Event('change'));
						}
					});

					// Save button click
					document.getElementById('saveBtn').addEventListener('click', () => {
						const btn = document.getElementById('saveBtn');
						btn.innerText = 'Saving...';

						vscode.postMessage({
							type: 'saveSettings',
							settings: {
								provider: document.getElementById('provider').value,
								openRouterApiKey: document.getElementById('openRouterApiKey').value,
								openRouterModel: document.getElementById('openRouterModel').value,
								openAiBaseUrl: document.getElementById('openAiBaseUrl').value,
								openAiApiKey: document.getElementById('openAiApiKey').value,
								openAiModel: document.getElementById('openAiModel').value,
								rolePrompt: document.getElementById('rolePrompt').value,
								wholeFileRolePrompt: document.getElementById('wholeFileRolePrompt').value
							}
						});

						setTimeout(() => btn.innerText = 'Save Settings', 800);
					});
				</script>
			</body>
			</html>`;
    }
}
