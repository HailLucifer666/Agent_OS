'use strict';
module.exports = async context => {
  if (context.electronPlatformName !== 'win32') return;
  require('../mythos/scripts/build-browser-native-host').buildBrowserNativeHost();
};
