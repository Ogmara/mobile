/**
 * BotBadge — "this account says it is automated" marker (frontend spec §6.2).
 *
 * Sits BESIDE `VerifiedBadge` and is never merged with it, because the two say
 * different things:
 *
 *   VerifiedBadge — the wallet paid to register on-chain. A trust signal.
 *   BotBadge      — the account self-declared `is_bot`. Free, cosmetic.
 *
 * Shown for EVERY self-declared bot, verified or not. Restricting it to verified
 * bots would be backwards: an unverified bot is precisely the one a user most
 * needs labelled.
 *
 * Deliberately a neutral text chip rather than an icon — an icon reads as an
 * endorsement, and this is the opposite of one.
 */

import React from 'react';
import { Text, View } from 'react-native';
import { useTheme } from '../theme';
import { useTranslation } from 'react-i18next';

interface Props {
  isBot?: boolean | null;
}

export default function BotBadge({ isBot }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  if (!isBot) return null;
  return (
    <View
      style={{
        marginLeft: 4,
        paddingHorizontal: 5,
        paddingVertical: 1,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.bgTertiary,
      }}
      accessibilityLabel={t('bot_badge_tooltip')}
    >
      <Text style={{ fontSize: 10, fontWeight: '500', color: colors.textSecondary }}>
        {t('bot_badge')}
      </Text>
    </View>
  );
}
