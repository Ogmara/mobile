/**
 * Gradient — a pure-JS vertical (top→bottom) gradient, no native dependency.
 *
 * Renders a stack of flex:1 colour bands behind the children. Because each band
 * is flex:1, the gradient fills any height without measuring. Colours are linearly
 * interpolated across the provided stops. Put `borderRadius` + `overflow:'hidden'`
 * on `style` to clip the bands to a rounded card.
 */

import React, { useMemo } from 'react';
import { View, StyleSheet, type ViewStyle, type StyleProp } from 'react-native';

interface Props {
  /** 2+ hex colours, top → bottom. */
  colors: string[];
  /** Number of interpolation bands (more = smoother). */
  bands?: number;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Colour at position t∈[0,1] across the stops. */
function sampleStops(stops: [number, number, number][], t: number): string {
  if (stops.length === 1) return `rgb(${stops[0].join(',')})`;
  const seg = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(seg));
  const f = seg - i;
  const a = stops[i];
  const b = stops[i + 1];
  const r = Math.round(a[0] + (b[0] - a[0]) * f);
  const g = Math.round(a[1] + (b[1] - a[1]) * f);
  const bl = Math.round(a[2] + (b[2] - a[2]) * f);
  return `rgb(${r},${g},${bl})`;
}

export default function Gradient({ colors, bands = 28, style, children }: Props) {
  const bandColors = useMemo(() => {
    const stops = colors.map(hexToRgb);
    const out: string[] = [];
    for (let i = 0; i < bands; i++) out.push(sampleStops(stops, bands === 1 ? 0 : i / (bands - 1)));
    return out;
  }, [colors, bands]);

  return (
    <View style={style}>
      <View style={StyleSheet.absoluteFill}>
        {bandColors.map((c, i) => (
          <View key={i} style={{ flex: 1, backgroundColor: c }} />
        ))}
      </View>
      {children}
    </View>
  );
}
