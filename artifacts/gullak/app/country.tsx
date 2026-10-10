import Feather from '@expo/vector-icons/Feather';
import { useQueryClient } from '@tanstack/react-query';
import { getGetMeQueryKey, useUpdateMe } from '@workspace/api-client-react';
import { COUNTRIES, flagEmoji } from '@workspace/gullak-core';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import React from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Card, ModalHeader, Notice, useBottomInset } from '@/components/ui';
import { fonts } from '@/constants/typography';
import { useWallet } from '@/contexts/WalletContext';
import { useColors } from '@/hooks/useColors';
import { apiErrorMessage } from '@/lib/errors';

/** Picks the country whose currency Gullak shows next to dollar amounts. */
export default function CountryScreen() {
  const c = useColors();
  const bottom = useBottomInset();
  const queryClient = useQueryClient();
  const { member } = useWallet();
  const update = useUpdateMe({
    mutation: {
      onSuccess: (updated) => {
        queryClient.setQueryData(getGetMeQueryKey(), updated);
        if (Platform.OS !== 'web') void Haptics.selectionAsync();
        router.back();
      },
    },
  });

  const selected = update.isPending ? update.variables?.data.country : member?.country;

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ModalHeader title="Your country" onClose={() => router.back()} />
      <ScrollView contentContainerStyle={[styles.container, { paddingBottom: bottom + 24 }]}>
        <Text style={[styles.body, { color: c.mutedForeground }]}>
          Your money stays in digital dollars. Gullak also shows roughly what it's worth in your local currency, and family
          sending to you see it too.
        </Text>

        {update.error ? <Notice tone="error">{apiErrorMessage(update.error)}</Notice> : null}

        <Card style={{ paddingVertical: 4 }}>
          {COUNTRIES.map((country, i) => {
            const isSelected = country.code === selected;
            return (
              <Pressable
                key={country.code}
                onPress={() => {
                  if (country.code === member?.country) router.back();
                  else update.mutate({ data: { country: country.code } });
                }}
                disabled={update.isPending}
                style={({ pressed }) => [
                  styles.row,
                  i < COUNTRIES.length - 1 && { borderBottomColor: c.border, borderBottomWidth: StyleSheet.hairlineWidth },
                  { opacity: pressed ? 0.7 : 1 },
                ]}
                accessibilityRole="radio"
                accessibilityState={{ selected: isSelected, disabled: update.isPending }}
                accessibilityLabel={`${country.name}, ${country.currency}`}
                testID={`country-${country.code}`}
              >
                <Text style={styles.flag}>{flagEmoji(country.code)}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.name, { color: c.foreground }]}>{country.name}</Text>
                  <Text style={[styles.currency, { color: c.mutedForeground }]}>{country.currency}</Text>
                </View>
                {isSelected ? (
                  update.isPending ? (
                    <ActivityIndicator color={c.primary} />
                  ) : (
                    <Feather name="check" size={20} color={c.primary} />
                  )
                ) : null}
              </Pressable>
            );
          })}
        </Card>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 20, gap: 16, maxWidth: 560, width: '100%', alignSelf: 'center' },
  body: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 12, minHeight: 56 },
  flag: { fontSize: 26 },
  name: { fontFamily: fonts.medium, fontSize: 16 },
  currency: { fontFamily: fonts.regular, fontSize: 13 },
});
