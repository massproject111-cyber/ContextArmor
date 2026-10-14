import * as vscode from 'vscode';
import { extractSuggestedPin } from './diagnosticMapper.js';

export class QuickFixProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
    token: vscode.CancellationToken
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source === 'ContextArmor') {
        const line = document.lineAt(diagnostic.range.start.line);
        const suggestedPin = extractSuggestedPin(diagnostic.message);

        // 1. Quick Fix: Pin to suggested version (if available in ASK text)
        if (suggestedPin) {
          const pinFix = new vscode.CodeAction(
            `Pin to suggested safe version (${suggestedPin})`,
            vscode.CodeActionKind.QuickFix
          );
          pinFix.edit = new vscode.WorkspaceEdit();
          pinFix.diagnostics = [diagnostic];
          pinFix.isPreferred = true;

          let updatedText = line.text;
          if (document.fileName.endsWith('package.json')) {
            // Replace ": "^x.y.z"" or ": "x.y.z"" with ": "${suggestedPin}""
            updatedText = line.text.replace(/:\s*["'][^"']+["']/, `: "${suggestedPin}"`);
          } else if (document.fileName.endsWith('requirements.txt')) {
            // Replace pkg==ver or pkg>=ver with pkg==${suggestedPin}
            updatedText = line.text.replace(/([a-zA-Z0-9_\-\.]+)(?:[=><~!]=*[^#\s]+)?/, `$1==${suggestedPin}`);
          }

          pinFix.edit.replace(document.uri, line.range, updatedText);
          actions.push(pinFix);
        }

        // 2. Quick Fix: Add weights_only=True to torch.load
        if (diagnostic.message.includes('torch.load')) {
          const torchFix = new vscode.CodeAction(
            'Add weights_only=True to torch.load',
            vscode.CodeActionKind.QuickFix
          );
          torchFix.edit = new vscode.WorkspaceEdit();
          torchFix.diagnostics = [diagnostic];
          torchFix.isPreferred = true;
          const updated = line.text.replace(/torch\.load\(([^)]+)\)/, 'torch.load($1, weights_only=True)');
          torchFix.edit.replace(document.uri, line.range, updated);
          actions.push(torchFix);
        }

        // 3. Quick Fix: Remove dependency line
        const removeFix = new vscode.CodeAction(
          'Remove dependency line',
          vscode.CodeActionKind.QuickFix
        );
        removeFix.edit = new vscode.WorkspaceEdit();
        removeFix.diagnostics = [diagnostic];
        if (!suggestedPin) {
          removeFix.isPreferred = true;
        }

        const lineRange = document.lineAt(diagnostic.range.start.line).rangeIncludingLineBreak;
        removeFix.edit.delete(document.uri, lineRange);
        actions.push(removeFix);
      }
    }

    return actions;
  }
}
