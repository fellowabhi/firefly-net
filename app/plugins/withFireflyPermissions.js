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
    m['uses-feature'] = [...(m['uses-feature'] || []), { $: { 'android:name': 'android.hardware.bluetooth_le', 'android:required': 'true' } }];
    return cfg;
  });
};
