/**
 * Search — find channels, users, and posts.
 *
 * Search input with results filtered by type (channels, users, posts).
 */

import React, { useState } from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, fontSize, radius } from '../theme';

export default function SearchScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [query, setQuery] = useState('');

  return (
    <View style={[styles.container, { backgroundColor: colors.bgPrimary }]}>
      <View style={[styles.searchBar, { backgroundColor: colors.bgTertiary }]}>
        <TextInput
          style={[styles.input, { color: colors.textPrimary }]}
          placeholder={t('search_placeholder')}
          placeholderTextColor={colors.textSecondary}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          maxLength={256}
        />
      </View>
      {!query && (
        <View style={styles.empty}>
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
            {t('search_placeholder')}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  searchBar: {
    margin: spacing.md,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
  },
  input: { height: 44, fontSize: fontSize.md },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyText: { fontSize: fontSize.md },
});
