/**
 * Sparkline — a tiny 7-day price trend chart rendered with plain Views (no
 * native chart dependency). Normalizes the series to the given height and draws
 * thin vertical bars; greens/reds by overall trend.
 */

import React, { useMemo } from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme';

interface Props {
  data: number[];
  width?: number;
  height?: number;
}

export default function Sparkline({ data, width = 64, height = 24 }: Props) {
  const { colors } = useTheme();
  const bars = useMemo(() => {
    if (!data || data.length < 2) return [];
    // Downsample to at most ~20 bars for a clean look.
    const max = Math.max(...data);
    const min = Math.min(...data);
    const range = max - min || 1;
    const step = Math.max(1, Math.floor(data.length / 20));
    const sampled: number[] = [];
    for (let i = 0; i < data.length; i += step) sampled.push(data[i]);
    if (sampled[sampled.length - 1] !== data[data.length - 1]) sampled.push(data[data.length - 1]);
    return sampled.map((v) => Math.max(2, ((v - min) / range) * height));
  }, [data, height]);

  if (bars.length === 0) return <View style={{ width, height }} />;
  const up = data[data.length - 1] >= data[0];
  const color = up ? colors.success : colors.error;
  const barW = Math.max(1, width / bars.length - 1);

  return (
    <View style={{ width, height, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
      {bars.map((h, i) => (
        <View key={i} style={{ width: barW, height: h, backgroundColor: color, borderRadius: 1, opacity: 0.85 }} />
      ))}
    </View>
  );
}
