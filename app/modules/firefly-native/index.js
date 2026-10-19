// JS facade for the local Kotlin module (BLE advert sync channel + experimental audio chirps + clock).
import { requireNativeModule } from 'expo-modules-core';
const M = requireNativeModule('FireflyNative');
export default M;
