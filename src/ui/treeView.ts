import * as vscode from 'vscode';

export interface ThreatItem {
  title: string;
  desc: string;
  severity: 'CRITICAL' | 'WARNING' | 'SAFE';
  file?: string;
  line?: number;
}

export class ContextArmorTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> =
    new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> =
    this._onDidChangeTreeData.event;

  private findings: ThreatItem[] = [];

  constructor() {
    this.refresh();
  }

  public setFindings(items: ThreatItem[]) {
    this.findings = items;
    this._onDidChangeTreeData.fire();
  }

  public refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
    if (element) {
      return Promise.resolve([]);
    }

    if (this.findings.length === 0) {
      const activeItem = new vscode.TreeItem(
        'Shield Active: All dependencies clean',
        vscode.TreeItemCollapsibleState.None
      );
      activeItem.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'));
      activeItem.tooltip = 'No malicious dependencies or unregistered hallucinations detected';
      return Promise.resolve([activeItem]);
    }

    const items = this.findings.map((f) => {
      const item = new vscode.TreeItem(f.title, vscode.TreeItemCollapsibleState.None);
      item.description = f.desc;
      item.tooltip = `${f.title}\n${f.desc}`;
      if (f.severity === 'CRITICAL') {
        item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
      } else if (f.severity === 'WARNING') {
        item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
      } else {
        item.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
      }

      if (f.file && f.line !== undefined) {
        item.command = {
          command: 'vscode.open',
          title: 'Open File',
          arguments: [
            vscode.Uri.file(f.file),
            { selection: new vscode.Range(f.line, 0, f.line, 0) },
          ],
        };
      }
      return item;
    });

    return Promise.resolve(items);
  }
}
