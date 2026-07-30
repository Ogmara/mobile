/**
 * ImageViewerModal — fullscreen image viewer with pinch-to-zoom, pan, and
 * save-to-device.
 *
 * Zoom: pinch (react-native-gesture-handler) or double-tap to toggle between
 * fit and 2.5x, both driven by Reanimated shared values so the gesture runs
 * on the UI thread. Pan is only active once zoomed in. `uri` may be a
 * `data:` URI (already-decrypted attachment), a remote `http(s)` CID URL, or
 * a local `file://` path — {@link saveImageToDevice} handles all three.
 */
import React, { useCallback, useState } from 'react';
import { Modal, View, StyleSheet, TouchableOpacity, Text, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { GestureDetector, Gesture, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import * as MediaLibrary from 'expo-media-library';
import { File, Paths } from 'expo-file-system';
import { base64ToBytes } from '../lib/mediaCrypto';
import { sanitizeFilename } from '../lib/sanitize';
import InfoModal from './InfoModal';

const MIN_SCALE = 1;
const MAX_SCALE = 6;
const DBLTAP_SCALE = 2.5;

/** Save `uri` (data:/http(s)/file:// ) to the device's photo library. Returns
 *  whether it succeeded (false on permission denial or a network/write error).
 *  Unlike {@link shareFileFromUri}, `saveToLibraryAsync` only resolves once the
 *  OS has made its own copy in the media library, so it's safe to delete our
 *  temp cache file right after — no race with a receiving app. */
export async function saveImageToDevice(uri: string): Promise<boolean> {
  const perm = await MediaLibrary.requestPermissionsAsync(true);
  if (!perm.granted) return false;

  let localUri = uri;
  let tempFile: File | null = null;
  try {
    if (uri.startsWith('data:')) {
      const commaIdx = uri.indexOf(',');
      const meta = uri.slice(5, commaIdx); // e.g. "image/png;base64" — mime is peer-controlled
      const ext = meta.split(';')[0].split('/')[1] || 'jpg';
      const bytes = base64ToBytes(uri.slice(commaIdx + 1));
      tempFile = new File(Paths.cache, sanitizeFilename(`ogmara-${Date.now()}.${ext}`));
      tempFile.write(bytes);
      localUri = tempFile.uri;
    } else if (uri.startsWith('http')) {
      const resp = await fetch(uri);
      if (!resp.ok) return false;
      const buf = new Uint8Array(await resp.arrayBuffer());
      const ext = (resp.headers.get('content-type') || '').split('/')[1]?.split(';')[0] || 'jpg';
      tempFile = new File(Paths.cache, sanitizeFilename(`ogmara-${Date.now()}.${ext}`));
      tempFile.write(buf);
      localUri = tempFile.uri;
    }
    await MediaLibrary.saveToLibraryAsync(localUri);
    return true;
  } catch {
    return false;
  } finally {
    try { tempFile?.delete(); } catch { /* best-effort cleanup */ }
  }
}

export function ImageViewerModal({ uri, onClose }: { uri: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { width, height } = useWindowDimensions();
  const [saving, setSaving] = useState(false);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);

  const resetZoom = useCallback(() => {
    scale.value = withSpring(MIN_SCALE);
    translateX.value = withSpring(0);
    translateY.value = withSpring(0);
    savedScale.value = MIN_SCALE;
    savedTranslateX.value = 0;
    savedTranslateY.value = 0;
  }, [scale, savedScale, translateX, translateY, savedTranslateX, savedTranslateY]);

  const handleClose = useCallback(() => {
    resetZoom();
    onClose();
  }, [resetZoom, onClose]);

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      scale.value = Math.min(MAX_SCALE, Math.max(MIN_SCALE, savedScale.value * e.scale));
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      if (scale.value <= MIN_SCALE) {
        scale.value = withSpring(MIN_SCALE);
        translateX.value = withSpring(0);
        translateY.value = withSpring(0);
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
      }
    });

  const pan = Gesture.Pan()
    .onUpdate((e) => {
      if (savedScale.value > MIN_SCALE) {
        translateX.value = savedTranslateX.value + e.translationX;
        translateY.value = savedTranslateY.value + e.translationY;
      }
    })
    .onEnd(() => {
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd((e) => {
      if (savedScale.value > MIN_SCALE) {
        scale.value = withSpring(MIN_SCALE);
        translateX.value = withSpring(0);
        translateY.value = withSpring(0);
        savedScale.value = MIN_SCALE;
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
      } else {
        // width/height come from useWindowDimensions() in the component body —
        // captured as plain numbers, NOT a Dimensions.get() module call, which
        // isn't reachable from inside this worklet (UI thread).
        const dx = (width / 2 - e.x) * (DBLTAP_SCALE - 1);
        const dy = (height / 2 - e.y) * (DBLTAP_SCALE - 1);
        scale.value = withSpring(DBLTAP_SCALE);
        translateX.value = withSpring(dx);
        translateY.value = withSpring(dy);
        savedScale.value = DBLTAP_SCALE;
        savedTranslateX.value = dx;
        savedTranslateY.value = dy;
      }
    });

  const composed = Gesture.Simultaneous(pinch, pan, doubleTap);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  const handleSave = useCallback(async () => {
    if (!uri || saving) return;
    setSaving(true);
    try {
      const ok = await saveImageToDevice(uri);
      setInfoMsg(ok ? t('media_download_saved') : t('media_download_failed'));
    } finally {
      setSaving(false);
    }
  }, [uri, saving, t]);

  if (!uri) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={handleClose}>
      {/* RN's Modal renders its content in a separate native window/Activity
          on Android, outside the app's main view hierarchy — the top-level
          GestureHandlerRootView in App.tsx doesn't cover it, so gestures
          (pinch/pan/double-tap) silently do nothing without a second one
          scoped to the modal's own content. */}
      <GestureHandlerRootView style={styles.overlay}>
        <GestureDetector gesture={composed}>
          <Animated.Image source={{ uri }} style={[styles.image, animatedStyle]} resizeMode="contain" />
        </GestureDetector>
        <View style={styles.toolbar}>
          <TouchableOpacity style={styles.btn} onPress={handleSave} disabled={saving}>
            <Text style={styles.btnText}>{saving ? '…' : '⬇'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.btn} onPress={handleClose}>
            <Text style={styles.btnText}>✕</Text>
          </TouchableOpacity>
        </View>
      </GestureHandlerRootView>
      <InfoModal visible={!!infoMsg} message={infoMsg || ''} onClose={() => setInfoMsg(null)} />
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  toolbar: {
    position: 'absolute',
    top: 48,
    right: 16,
    flexDirection: 'row',
    gap: 10,
  },
  btn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnText: {
    color: '#fff',
    fontSize: 18,
  },
});
