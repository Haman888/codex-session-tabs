'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function externalTempParent({ temporary = os.tmpdir(), project = path.resolve(__dirname, '..') } = {}) {
  const relative = path.relative(project, path.resolve(temporary));
  if (!relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) {
    throw new Error('Test temporary files must be outside the project. Use the system TMPDIR.');
  }
  return temporary;
}

const makeTemp = prefix => fs.mkdtemp(path.join(externalTempParent(), prefix));
module.exports = { externalTempParent, makeTemp };
