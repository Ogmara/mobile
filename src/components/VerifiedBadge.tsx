/**
 * VerifiedBadge — "this wallet is registered on-chain" marker shown next to a
 * user's name/handle. The web/desktop clients render a small `✓`; mobile uses
 * an Ionicons `checkmark-circle` in the accent colour to distinguish it from
 * `AnchorBadge` (green — that one is about *node* anchoring, not user identity).
 *
 * "Verified" mirrors the web derivation: the connected node reports the profile
 * carries a non-empty on-chain `public_key` (see `useUserDisplay`). It is only
 * as trustworthy as the node you're connected to — advisory, not a security
 * boundary — so the label says "registered on-chain", not "verified identity".
 */

import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme';

interface Props {
  verified?: boolean;
  size?: number;
}

export default function VerifiedBadge({ verified, size = 14 }: Props) {
  const { colors } = useTheme();
  if (!verified) return null;
  return (
    <Ionicons
      name="checkmark-circle"
      size={size}
      color={colors.accentPrimary}
      accessibilityLabel="Registered on-chain"
      style={{ marginLeft: 3 }}
    />
  );
}
