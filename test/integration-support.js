'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');

function contained(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function privateDirectory(folder) {
  const stat = fs.lstatSync(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)
    || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error('Integration tests require a private directory owned by the current user.');
  }
  return fs.realpathSync(folder);
}

function integrationEnvironment(vscode, userData = process.env.CODEX_TABS_TEST_USER_DATA) {
  if (!userData || !path.isAbsolute(userData)) {
    throw new Error('Set CODEX_TABS_TEST_USER_DATA to a separate private --user-data-dir before running integration tests.');
  }
  const root = privateDirectory(userData);
  if (path.dirname(root) !== fs.realpathSync(os.tmpdir()) || !path.basename(root).startsWith('cst-integration-')) {
    throw new Error('Create a fresh cst-integration- profile in the system temporary directory.');
  }
  const project = fs.realpathSync(path.resolve(__dirname, '..'));
  if (contained(project, root) || contained(root, project) || vscode.workspace.workspaceFolders?.length) {
    throw new Error('Integration tests require a separate profile outside the project and an empty workspace.');
  }
  return root;
}

function integrationContext(vscode, context, userData) {
  // An environment label alone is insufficient: check the real active profile.
  if (context.extensionMode !== vscode.ExtensionMode.Test) {
    throw new Error('Integration tests refuse the working VS Code profile.');
  }
  const storageParent = fs.realpathSync(path.dirname(context.globalStorageUri.fsPath));
  if (!contained(userData, storageParent)) {
    throw new Error('Integration tests refuse the working VS Code profile.');
  }
}

function createOutput(userData) {
  const parent = privateDirectory(userData);
  const directory = fs.mkdtempSync(path.join(parent, 'codex-tabs-report-'));
  const allowed = new Set(['report.json', 'tab-icons.json', 'tab-icons.png']);
  return Object.freeze({
    directory,
    write(name, data) {
      if (!allowed.has(name)) throw new Error('Unexpected integration output filename.');
      privateDirectory(directory);
      const temporary = path.join(directory, randomUUID() + '.tmp');
      let handle;
      try {
        handle = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT
          | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(handle, data);
        fs.fsyncSync(handle);
        fs.closeSync(handle); handle = undefined;
        // Replace the directory entry itself; never follow a pre-existing leaf.
        fs.renameSync(temporary, path.join(directory, name));
      } finally {
        if (handle !== undefined) fs.closeSync(handle);
        fs.rmSync(temporary, { force: true });
      }
    },
  });
}

module.exports = { integrationEnvironment, integrationContext, createOutput };
