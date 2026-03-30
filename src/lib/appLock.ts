/**
 * App Lock — PIN code and biometric authentication.
 *
 * PIN-derived key (PBKDF2-SHA256, 600k iterations) encrypts the private
 * key via AES-256-GCM before storing in SecureStore.
 * Per spec 05-clients.md sections 5.6.1–5.6.3.
 *
 * Uses @noble/hashes and @noble/ciphers (pure JS, React Native compatible)
 * instead of crypto.subtle which is NOT available in Hermes.
 */

import * as SecureStore from 'expo-secure-store';
import * as LocalAuthentication from 'expo-local-authentication';
import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha256';
import { gcm } from '@noble/ciphers/aes';

const SALT_KEY = 'ogmara.app_lock.salt';
const PIN_VERIFY_KEY = 'ogmara.app_lock.pin_verify';
const LOCK_ENABLED_KEY = 'ogmara.app_lock.enabled';
const LOCK_TIMEOUT_KEY = 'ogmara.app_lock.timeout_seconds';
const FAILED_ATTEMPTS_KEY = 'ogmara.app_lock.failed_attempts';
const COOLDOWN_UNTIL_KEY = 'ogmara.app_lock.cooldown_until';
const BIOMETRIC_KEY = 'ogmara.app_lock.biometric_enabled';

const PBKDF2_ITERATIONS = 600_000;

// --- Crypto helpers (pure JS, works in Hermes) ---

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Derive a 32-byte AES key from a PIN using PBKDF2-SHA256.
 * Runs in a setTimeout to avoid blocking the UI thread.
 * 600k iterations takes ~2-5s on mobile — UI stays responsive.
 */
export function deriveKeyFromPin(pin: string, salt: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve) => {
    // Yield to UI thread before starting heavy computation
    setTimeout(() => {
      const encoder = new TextEncoder();
      const key = pbkdf2(sha256, encoder.encode(pin), salt, {
        c: PBKDF2_ITERATIONS,
        dkLen: 32,
      });
      resolve(key);
    }, 50);
  });
}

/** Encrypt data with AES-256-GCM. Returns "ivHex:ciphertextHex". */
export function encryptWithKey(key: Uint8Array, plaintext: string): string {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const encoder = new TextEncoder();
  const aes = gcm(key, iv);
  const ciphertext = aes.encrypt(encoder.encode(plaintext));
  return bytesToHex(iv) + ':' + bytesToHex(ciphertext);
}

/** Decrypt AES-256-GCM data. Input format: "ivHex:ciphertextHex". */
export function decryptWithKey(key: Uint8Array, encrypted: string): string {
  const parts = encrypted.split(':');
  if (parts.length !== 2) throw new Error('Invalid encrypted format');
  const iv = hexToBytes(parts[0]);
  const ciphertext = hexToBytes(parts[1]);
  const aes = gcm(key, iv);
  const plaintext = aes.decrypt(ciphertext);
  return new TextDecoder().decode(plaintext);
}

// --- PIN Management ---

/** Check if app lock (PIN) is enabled. */
export async function isLockEnabled(): Promise<boolean> {
  const val = await SecureStore.getItemAsync(LOCK_ENABLED_KEY).catch(() => null);
  return val === 'true';
}

/** Check if a PIN has been set up. */
export async function hasPinSetup(): Promise<boolean> {
  const verify = await SecureStore.getItemAsync(PIN_VERIFY_KEY).catch(() => null);
  return !!verify;
}

/**
 * Set up a new PIN. Stores a verification token and the salt.
 * Returns the derived key bytes for encrypting the private key.
 */
export async function setupPin(pin: string): Promise<Uint8Array> {
  if (!/^\d{6,}$/.test(pin)) throw new Error('PIN must be at least 6 digits');

  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const key = await deriveKeyFromPin(pin, salt);

  // Encrypt a known token to verify PIN on unlock
  const verifyToken = encryptWithKey(key, 'ogmara-pin-ok');

  await SecureStore.setItemAsync(SALT_KEY, bytesToHex(salt));
  await SecureStore.setItemAsync(PIN_VERIFY_KEY, verifyToken);
  await SecureStore.setItemAsync(LOCK_ENABLED_KEY, 'true');
  await SecureStore.setItemAsync(FAILED_ATTEMPTS_KEY, '0');

  return key;
}

/**
 * Verify the entered PIN. Returns the derived key on success,
 * null on failure. The key can be used to decrypt the private key.
 */
export async function verifyPin(pin: string): Promise<Uint8Array | null> {
  const saltHex = await SecureStore.getItemAsync(SALT_KEY);
  const verifyToken = await SecureStore.getItemAsync(PIN_VERIFY_KEY);
  if (!saltHex || !verifyToken) return null;

  const salt = hexToBytes(saltHex);
  const key = await deriveKeyFromPin(pin, salt);

  try {
    const decrypted = decryptWithKey(key, verifyToken);
    if (decrypted === 'ogmara-pin-ok') {
      await SecureStore.setItemAsync(FAILED_ATTEMPTS_KEY, '0');
      return key;
    }
  } catch {
    // Decryption failed = wrong PIN
  }

  await incrementFailedAttempts();
  return null;
}

/** Remove PIN and disable app lock (requires current PIN). */
export async function removePin(currentPin: string): Promise<boolean> {
  const key = await verifyPin(currentPin);
  if (!key) return false;

  await SecureStore.deleteItemAsync(SALT_KEY);
  await SecureStore.deleteItemAsync(PIN_VERIFY_KEY);
  await SecureStore.setItemAsync(LOCK_ENABLED_KEY, 'false');
  await SecureStore.setItemAsync(BIOMETRIC_KEY, 'false');
  await SecureStore.deleteItemAsync(FAILED_ATTEMPTS_KEY).catch(() => {});
  await SecureStore.deleteItemAsync(COOLDOWN_UNTIL_KEY).catch(() => {});
  return true;
}

// --- Failed Attempts & Cooldown ---

export async function getFailedAttempts(): Promise<number> {
  const val = await SecureStore.getItemAsync(FAILED_ATTEMPTS_KEY).catch(() => null);
  return val ? parseInt(val, 10) || 0 : 0;
}

async function incrementFailedAttempts(): Promise<void> {
  const current = await getFailedAttempts();
  const next = current + 1;
  await SecureStore.setItemAsync(FAILED_ATTEMPTS_KEY, next.toString());

  const cd = getCooldownSeconds(next);
  if (cd > 0) {
    const until = Date.now() + cd * 1000;
    await SecureStore.setItemAsync(COOLDOWN_UNTIL_KEY, until.toString());
  }
}

export function getCooldownSeconds(failedAttempts: number): number {
  if (failedAttempts < 5) return 0;
  const cooldowns = [30, 60, 120, 300, 600];
  const idx = Math.min(failedAttempts - 5, cooldowns.length - 1);
  return cooldowns[idx];
}

export async function getRemainingCooldown(): Promise<number> {
  const until = await SecureStore.getItemAsync(COOLDOWN_UNTIL_KEY).catch(() => null);
  if (!until) return 0;
  const remaining = Math.ceil((parseInt(until, 10) - Date.now()) / 1000);
  return Math.max(0, remaining);
}

// --- Biometric ---

export async function isBiometricAvailable(): Promise<boolean> {
  const compatible = await LocalAuthentication.hasHardwareAsync();
  if (!compatible) return false;
  return LocalAuthentication.isEnrolledAsync();
}

export async function getBiometricType(): Promise<string | null> {
  const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
  if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) return 'Face ID';
  if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) return 'Fingerprint';
  if (types.includes(LocalAuthentication.AuthenticationType.IRIS)) return 'Iris';
  return null;
}

export async function isBiometricEnabled(): Promise<boolean> {
  const val = await SecureStore.getItemAsync(BIOMETRIC_KEY).catch(() => null);
  return val === 'true';
}

export async function setBiometricEnabled(enabled: boolean): Promise<void> {
  await SecureStore.setItemAsync(BIOMETRIC_KEY, enabled ? 'true' : 'false');
}

export async function authenticateBiometric(prompt: string): Promise<boolean> {
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: prompt,
    cancelLabel: 'Use PIN',
    disableDeviceFallback: true,
  });
  return result.success;
}

// --- Auto-Lock ---

export async function getLockTimeout(): Promise<number> {
  const val = await SecureStore.getItemAsync(LOCK_TIMEOUT_KEY).catch(() => null);
  return val ? parseInt(val, 10) || 300 : 300;
}

export async function setLockTimeout(seconds: number): Promise<void> {
  await SecureStore.setItemAsync(LOCK_TIMEOUT_KEY, seconds.toString());
}
