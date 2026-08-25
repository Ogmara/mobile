/**
 * PostImage — full-width inline image for news posts and comments.
 *
 * News attachments used to render into a fixed 180px-tall box with
 * `resizeMode="contain"`, which letterboxed them: a wide screenshot ended up as
 * a small strip floating in dead space, reading as a thumbnail rather than
 * content.
 *
 * This fills the available width and derives the height from the image's own
 * aspect ratio, measured with `Image.getSize`, so nothing is cropped and nothing
 * is letterboxed. Until the measurement lands the image occupies a 16:9 box,
 * which keeps the list from jumping around as rows settle.
 *
 * Very tall images are capped at `MAX_ASPECT` (taller than 4:5 portrait) so a
 * single screenshot cannot take over the whole feed; those are cropped rather
 * than shrunk, since the alternative is an unusable row.
 */

import React, { useEffect, useState } from 'react';
import { Image, StyleSheet, type StyleProp, type ImageStyle } from 'react-native';
import { radius } from '../theme';

/** Placeholder ratio before the real one is known. */
const DEFAULT_ASPECT = 16 / 9;
/** Narrowest (tallest) ratio we will render before cropping instead. */
const MAX_ASPECT = 4 / 5;

interface Props {
  uri: string;
  style?: StyleProp<ImageStyle>;
}

export default function PostImage({ uri, style }: Props) {
  const [aspect, setAspect] = useState(DEFAULT_ASPECT);

  useEffect(() => {
    let cancelled = false;
    Image.getSize(
      uri,
      (w, h) => {
        if (cancelled || !w || !h) return;
        setAspect(Math.max(w / h, MAX_ASPECT));
      },
      () => {
        // Unreachable/broken media — keep the placeholder ratio rather than
        // collapsing the row to zero height.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [uri]);

  return (
    <Image
      source={{ uri }}
      style={[styles.image, { aspectRatio: aspect }, style]}
      // `cover` only ever crops when the ratio was clamped by MAX_ASPECT;
      // otherwise the box matches the image exactly, so it behaves as `contain`
      // would but without the surrounding dead space.
      resizeMode="cover"
    />
  );
}

const styles = StyleSheet.create({
  image: {
    width: '100%',
    borderRadius: radius.md,
  },
});
