import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('native platform security sources', () => {
  it('registers an Android secure-session plugin backed by Keystore with backup disabled', async () => {
    const [activity, plugin, manifest] = await Promise.all([
      readFile('android/app/src/main/java/com/todograph/app/MainActivity.java', 'utf8'),
      readFile('android/app/src/main/java/com/todograph/app/SecureSessionPlugin.java', 'utf8'),
      readFile('android/app/src/main/AndroidManifest.xml', 'utf8'),
    ]);
    expect(activity).toContain('registerPlugin(SecureSessionPlugin.class)');
    expect(plugin).toContain('@CapacitorPlugin(name = "SecureSession")');
    expect(plugin).toContain('AndroidKeyStore');
    expect(plugin).toContain('AES/GCM/NoPadding');
    expect(manifest).toContain('android:allowBackup="false"');
  });

  it('registers an iOS secure-session plugin using device-only Keychain storage', async () => {
    const [plugin, storyboard, project] = await Promise.all([
      readFile('ios/App/App/SecureSessionPlugin.swift', 'utf8'),
      readFile('ios/App/App/Base.lproj/Main.storyboard', 'utf8'),
      readFile('ios/App/App.xcodeproj/project.pbxproj', 'utf8'),
    ]);
    expect(plugin).toContain('registerPluginInstance(SecureSessionPlugin())');
    expect(plugin).toContain('kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly');
    expect(storyboard).toContain('customClass="AppBridgeViewController"');
    expect(project).toContain('SecureSessionPlugin.swift in Sources');
  });
});
