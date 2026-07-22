package com.todograph.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "SecureSession")
public class SecureSessionPlugin extends Plugin {
    private static final String ANDROID_KEY_STORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "todograph_session_v1";
    private static final String PREFERENCES = "todograph_secure_session";
    private static final String CIPHER_TEXT = "cipher_text";
    private static final String INITIALIZATION_VECTOR = "initialization_vector";

    @PluginMethod
    public void read(PluginCall call) {
        JSObject result = new JSObject();
        SharedPreferences preferences = preferences();
        String cipherText = preferences.getString(CIPHER_TEXT, null);
        String initializationVector = preferences.getString(INITIALIZATION_VECTOR, null);
        if (cipherText == null || initializationVector == null) {
            result.put("value", JSObject.NULL);
            call.resolve(result);
            return;
        }

        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(
                Cipher.DECRYPT_MODE,
                getOrCreateKey(),
                new GCMParameterSpec(128, Base64.decode(initializationVector, Base64.NO_WRAP))
            );
            byte[] plainText = cipher.doFinal(Base64.decode(cipherText, Base64.NO_WRAP));
            result.put("value", new String(plainText, StandardCharsets.UTF_8));
            call.resolve(result);
        } catch (Exception error) {
            // A restored or invalid ciphertext must never leave the app in a broken auth loop.
            preferences.edit().clear().commit();
            result.put("value", JSObject.NULL);
            call.resolve(result);
        }
    }

    @PluginMethod
    public void write(PluginCall call) {
        String value = call.getString("value");
        if (value == null || value.isEmpty()) {
            call.reject("A non-empty session value is required");
            return;
        }

        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
            byte[] cipherText = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            boolean stored = preferences()
                .edit()
                .putString(CIPHER_TEXT, Base64.encodeToString(cipherText, Base64.NO_WRAP))
                .putString(INITIALIZATION_VECTOR, Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
                .commit();
            if (!stored) {
                call.reject("Unable to store the secure session");
                return;
            }
            call.resolve();
        } catch (Exception error) {
            call.reject("Unable to store the secure session", error);
        }
    }

    @PluginMethod
    public void clear(PluginCall call) {
        try {
            if (!preferences().edit().clear().commit()) {
                call.reject("Unable to clear the secure session");
                return;
            }
            KeyStore keyStore = KeyStore.getInstance(ANDROID_KEY_STORE);
            keyStore.load(null);
            if (keyStore.containsAlias(KEY_ALIAS)) {
                keyStore.deleteEntry(KEY_ALIAS);
            }
            call.resolve();
        } catch (Exception error) {
            call.reject("Unable to clear the secure session", error);
        }
    }

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    private SecretKey getOrCreateKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(ANDROID_KEY_STORE);
        keyStore.load(null);
        SecretKey existingKey = (SecretKey) keyStore.getKey(KEY_ALIAS, null);
        if (existingKey != null) return existingKey;

        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE);
        generator.init(
            new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build()
        );
        return generator.generateKey();
    }
}
