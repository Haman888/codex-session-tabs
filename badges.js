'use strict';

const vscode = require('vscode');

async function prepareBadges(context) {
  const codex = vscode.extensions.getExtension('openai.chatgpt');
  const destination = vscode.Uri.joinPath(context.globalStorageUri, 'status-icons');
  await vscode.workspace.fs.createDirectory(destination);
  const icons = {};
  for (const [theme, file, border] of [
    ['light', 'blossom-black.svg', '#ffffff'], ['dark', 'blossom-white.svg', '#202020'],
  ]) {
    const source = vscode.Uri.joinPath(codex.extensionUri, 'resources', file);
    let svg = Buffer.from(await vscode.workspace.fs.readFile(source)).toString('utf8');
    // Derive the installed editor's own icon at runtime; no OpenAI artwork is
    // distributed in this companion's source or VSIX.
    svg = svg.replace('</svg>', `<circle cx="19.5" cy="4.5" r="4" fill="#f59a38" stroke="${border}" stroke-width="1.4"/></svg>`);
    const uri = vscode.Uri.joinPath(destination, `ready-${theme}.svg`);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(svg));
    // globalStorageUri uses the virtual vscode-userdata scheme. The renderer
    // needs a real file URI for a tab icon; otherwise it silently shows no icon.
    icons[theme] = vscode.Uri.file(uri.fsPath);
  }
  return icons;
}

module.exports = { prepareBadges };
