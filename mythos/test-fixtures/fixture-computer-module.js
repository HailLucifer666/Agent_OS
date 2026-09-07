'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Run actual guard code with a fixture project root. Project-local TEMP is
// otherwise inside the production module's always-allowed checkout root.
module.exports = function fixtureComputerModule(projectRoot) {
  const filename = require.resolve('../src/core/effectors/from-computer');
  const module = { exports: {} };
  const source = fs.readFileSync(filename, 'utf8');
  const wrapper = vm.runInThisContext('(function(require,module,exports,__dirname,__filename){\n' + source + '\n})', { filename });
  wrapper(createRequire(filename), module, module.exports,
    path.join(projectRoot, 'mythos', 'src', 'core', 'effectors'), filename);
  return module.exports;
};
