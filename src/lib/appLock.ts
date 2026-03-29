/**
 * App Lock — PIN code and biometric authentication.
 *
 * PIN-derived key (PBKDF2-SHA256, 600k iterations) encrypts the private
 * key via AES-256-GCM before storing in SecureStore.
 * Per spec 05-clients.md sections 5.6.1–5.6.3.
 */

import * as SecureStore from 'expo-secure-store';
import * as LocalAuthentication from 'expo-local-authentication';

const SALT_KEY = 'ogmara.app_lock.salt';
const PIN_VERIFY_KEY = 'ogmara.app_lock.pin_verify';
const LOCK_ENABLED_KEY = 'ogmara.app_lock.enabled';
const LOCK_TIMEOUT_KEY = 'ogmara.app_lock.timeout_seconds';
const FAILED_ATTEMPTS_KEY = 'ogmara.app_lock.failed_attempts';
const COOLDOWN_UNTIL_KEY = 'ogmara.app_lock.cooldown_until';
const BIOMETRIC_KEY = 'ogmara.app_lock.biometric_enabled';

const PBKDF2_ITERATIONS = 600_000;

// --- Crypto helpers using SubtleCrypto ---

/** Generate a random salt (16 bytes). */
function generateSalt(): Uint8Array {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return salt;
}

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
 * Derive an AES-256-GCM key from a PIN using PBKDF2-SHA256.
 * 600,000 iterations per OWASP recommendation.
 */
export async function deriveKeyFromPin(
  pin: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const pinBytes = encoder.encode(pin);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    pinBytes.buffer as ArrayBuffer,
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt.buffer as ArrayBuffer,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypt data with AES-256-GCM. Returns iv + ciphertext as hex. */
export async function encryptWithKey(
  key: CryptoKey,
  plaintext: string,
): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const encoder = new TextEncoder();
  const plaintextBytes = encoder.encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    key,
    plaintextBytes.buffer as ArrayBuffer,
  );
  // Format: ivHex:ciphertextHex
  return bytesToHex(iv) + ':' + bytesToHex(new Uint8Array(ciphertext));
}

/** Decrypt AES-256-GCM data. Input format: ivHex:ciphertextHex. */
export async function decryptWithKey(
  key: CryptoKey,
  encrypted: string,
): Promise<string> {
  const [ivHex, ctHex] = encrypted.split(':');
  const iv = hexToBytes(ivHex);
  const ciphertext = hexToBytes(ctHex);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    key,
    ciphertext.buffer as ArrayBuffer,
  );
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
 * Returns the derived CryptoKey for encrypting the private key.
 */
export async function setupPin(pin: string): Promise<CryptoKey> {
  if (!/^\d{6,}$/.test(pin)) throw new Error('PIN must be at least 6 digits');

  const salt = generateSalt();
  const key = await deriveKeyFromPin(pin, salt);

  // Encrypt a known token to verify PIN on unlock
  const verifyToken = await encryptWithKey(key, 'ogmara-pin-ok');

  await SecureStore.setItemAsync(SALT_KEY, bytesToHex(salt));
  await SecureStore.setItemAsync(PIN_VERIFY_KEY, verifyToken);
  await SecureStore.setItemAsync(LOCK_ENABLED_KEY, 'true');
  await SecureStore.setItemAsync(FAILED_ATTEMPTS_KEY, '0');

  return key;
}

/**
 * Verify the entered PIN. Returns the derived CryptoKey on success,
 * null on failure. The key can be used to decrypt the private key.
 */
export async function verifyPin(pin: string): Promise<CryptoKey | null> {
  const saltHex = await SecureStore.getItemAsync(SALT_KEY);
  const verifyToken = await SecureStore.getItemAsync(PIN_VERIFY_KEY);
  if (!saltHex || !verifyToken) return null;

  const salt = hexToBytes(saltHex);
  const key = await deriveKeyFromPin(pin, salt);

  try {
    const decrypted = await decryptWithKey(key, verifyToken);
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

/** Remove PIN and disable app lock. */
export async function removePin(currentPin: string): Promise<boolean> {
  const key = await verifyPin(currentPin);
  if (!key) return false;

  await SecureStore.deleteItemAsync(SALT_KEY);
  await SecureStore.deleteItemAsync(PIN_VERIFY_KEY);
  await SecureStore.setItemAsync(LOCK_ENABLED_KEY, 'false');
  await SecureStore.setItemAsync(BIOMETRIC_KEY, 'false');
  return true;
}

// --- Failed Attempts & Cooldown ---

/** Get the number of consecutive failed PIN attempts. */
export async function getFailedAttempts(): Promise<number> {
  const val = await SecureStore.getItemAsync(FAILED_ATTEMPTS_KEY).catch(() => null);
  return val ? parseInt(val, 10) || 0 : 0;
}

async function incrementFailedAttempts(): Promise<void> {
  const current = await getFailedAttempts();
  const next = current + 1;
  await SecureStore.setItemAsync(FAILED_ATTEMPTS_KEY, next.toString());

  // Set cooldown timestamp after 5 failures
  const cd = getCooldownSeconds(next);
  if (cd > 0) {
    const until = Date.now() + cd * 1000;
    await SecureStore.setItemAsync(COOLDOWN_UNTIL_KEY, until.toString());
  }
}

/** Get cooldown seconds based on failed attempts (5+ failures trigger cooldown). */
export function getCooldownSeconds(failedAttempts: number): number {
  if (failedAttempts < 5) return 0;
  const cooldowns = [30, 60, 120, 300, 600];
  const idx = Math.min(failedAttempts - 5, cooldowns.length - 1);
  return cooldowns[idx];
}

/** Get remaining cooldown seconds (0 if no cooldown active). */
export async function getRemainingCooldown(): Promise<number> {
  const until = await SecureStore.getItemAsync(COOLDOWN_UNTIL_KEY).catch(() => null);
  if (!until) return 0;
  const remaining = Math.ceil((parseInt(until, 10) - Date.now()) / 1000);
  return Math.max(0, remaining);
}

// --- Biometric ---

/** Check if biometric hardware is available on this device. */
export async function isBiometricAvailable(): Promise<boolean> {
  const compatible = await LocalAuthentication.hasHardwareAsync();
  if (!compatible) return false;
  return LocalAuthentication.isEnrolledAsync();
}

/** Get the available biometric type name (for UI display). */
export async function getBiometricType(): Promise<string | null> {
  const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
  if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) return 'Face ID';
  if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) return 'Fingerprint';
  if (types.includes(LocalAuthentication.AuthenticationType.IRIS)) return 'Iris';
  return null;
}

/** Check if biometric unlock is enabled. */
export async function isBiometricEnabled(): Promise<boolean> {
  const val = await SecureStore.getItemAsync(BIOMETRIC_KEY).catch(() => null);
  return val === 'true';
}

/** Enable or disable biometric unlock. */
export async function setBiometricEnabled(enabled: boolean): Promise<void> {
  await SecureStore.setItemAsync(BIOMETRIC_KEY, enabled ? 'true' : 'false');
}

/** Attempt biometric authentication. Returns true on success. */
export async function authenticateBiometric(prompt: string): Promise<boolean> {
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: prompt,
    cancelLabel: 'Use PIN',
    disableDeviceFallback: true,
  });
  return result.success;
}

// --- Auto-Lock ---

/** Get the auto-lock timeout in seconds (default: 300 = 5 minutes). */
export async function getLockTimeout(): Promise<number> {
  const val = await SecureStore.getItemAsync(LOCK_TIMEOUT_KEY).catch(() => null);
  return val ? parseInt(val, 10) || 300 : 300;
}

/** Set the auto-lock timeout in seconds. */
export async function setLockTimeout(seconds: number): Promise<void> {
  await SecureStore.setItemAsync(LOCK_TIMEOUT_KEY, seconds.toString());
}
