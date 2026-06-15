/**
 * QrCode — renders a QR code as a grid of Views using the pure-JS
 * `qrcode-generator` encoder. No native dependency (no react-native-svg /
 * camera), so it bundles cleanly on Hermes.
 *
 * Cells are INTEGER-sized to avoid sub-pixel overlap (fractional widths make
 * adjacent black/white cells bleed into each other and the code unscannable).
 * The module grid is centered on a solid background, leaving a white quiet zone.
 */

import React, { useMemo } from 'react';
import { View } from 'react-native';
// eslint-disable-next-line @typescript-eslint/no-var-requires
import qrcode from 'qrcode-generator';

interface Props {
  value: string;
  /** Target pixel size (square). Actual size is rounded down to a whole number of cells. */
  size?: number;
  color?: string;
  background?: string;
}

export default function QrCode({ value, size = 240, color = '#000000', background = '#FFFFFF' }: Props) {
  const matrix = useMemo(() => {
    try {
      const qr = qrcode(0, 'M'); // type 0 = auto-size, error-correction M
      qr.addData(value);
      qr.make();
      const count = qr.getModuleCount();
      const rows: boolean[][] = [];
      for (let r = 0; r < count; r++) {
        const row: boolean[] = [];
        for (let c = 0; c < count; c++) row.push(qr.isDark(r, c));
        rows.push(row);
      }
      return rows;
    } catch {
      return [] as boolean[][];
    }
  }, [value]);

  const count = matrix.length;
  if (count === 0) {
    return <View style={{ width: size, height: size, backgroundColor: background }} />;
  }

  const quiet = 4; // quiet-zone modules (QR spec recommends 4)
  // Integer cell size so cells tile exactly with no sub-pixel overlap.
  const cell = Math.max(2, Math.floor(size / (count + quiet * 2)));
  const grid = cell * count;
  const frame = grid + cell * quiet * 2;

  return (
    <View style={{ width: frame, height: frame, backgroundColor: background, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ width: grid, height: grid }}>
        {matrix.map((row, r) => (
          <View key={r} style={{ flexDirection: 'row', height: cell }}>
            {row.map((dark, c) => (
              <View key={c} style={{ width: cell, height: cell, backgroundColor: dark ? color : background }} />
            ))}
          </View>
        ))}
      </View>
    </View>
  );
}
