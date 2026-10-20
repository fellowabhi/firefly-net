// Config plugin: BLE permissions for Android 12+ (scan with neverForLocation) and legacy (<=30) + mic.
const { withAndroidManifest } = require('expo/config-plugins');
module.exports = function withFireflyPermissions(config) {
  return withAndroidManifest(config, (cfg) => {
    const m = cfg.modResults.manifest; m.$['xmlns:tools'] = 'http://schemas.android.com/tools';
    const perms = (m['uses-permission'] = (m['uses-permission'] || []).filter(p => !/BLUETOOTH|LOCATION|RECORD_AUDIO/.test(p.$['android:name'])));
    const add = (name, extra = {}) => perms.push({ $: { 'android:name': name, ...extra } });
    add('android.permission.BLUETOOTH', { 'android:maxSdkVersion': '30' });
    add('android.permission.BLUETOOTH_ADMIN', { 'android:maxSdkVersion': '30' });
    add('android.permission.ACCESS_FINE_LOCATION', { 'android:maxSdkVersion': '30' });
    add('android.permission.BLUETOOTH_SCAN', { 'android:usesPermissionFlags': 'neverForLocation', 'tools:targetApi': 's' });
    add('android.permission.BLUETOOTH_ADVERTISE');
    add('android.permission.BLUETOOTH_CONNECT');
    add('android.permission.RECORD_AUDIO');
    // foldables (e.g. Tecno Phantom V Fold): handle fold/unfold, density and display changes in-place
    // instead of recreating the Activity (which re-inits camera + native module mid-run)
    for (const app of m.application || []) for (const act of app.activity || []) if (act.$['android:name'] === '.MainActivity') {
      const cur = new Set((act.$['android:configChanges'] || '').split('|').filter(Boolean));
      ['keyboard', 'keyboardHidden', 'orientation', 'screenSize', 'screenLayout', 'uiMode', 'smallestScreenSize', 'density', 'fontScale', 'layoutDirection', 'navigation', 'colorMode'].forEach(x => cur.add(x));
      act.$['android:configChanges'] = [...cur].join('|'); act.$['android:resizeableActivity'] = 'true';
    }
    m['uses-feature'] = [...(m['uses-feature'] || []), { $: { 'android:name': 'android.hardware.bluetooth_le', 'android:required': 'false' } }];
    return cfg;
  });
};
