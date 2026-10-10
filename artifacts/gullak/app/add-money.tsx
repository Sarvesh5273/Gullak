import { useQueryClient } from '@tanstack/react-query';
import {
  getGetConfigQueryKey,
  getGetMyBalanceQueryKey,
  getListMyActivityQueryKey,
  useCreateDeposit,
  useGetConfig,
} from '@workspace/api-client-react';
import { AUSD_UNIT, LIMITS, formatUsd, parseUsd } from '@workspace/gullak-core';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { Button, ModalHeader, Notice, useBottomInset } from '@/components/ui';
import { fonts } from '@/constants/typography';
import { useColors } from '@/hooks/useColors';
import { apiErrorMessage, devDetail } from '@/lib/errors';

const PRESETS = [10, 25, 50, 100];

export default function AddMoneyScreen() {
  const c = useColors();
  const bottom = useBottomInset();
  const queryClient = useQueryClient();
  const [preset, setPreset] = useState<number | null>(25);
  const [custom, setCustom] = useState('');
  const config = useGetConfig({ query: { queryKey: getGetConfigQueryKey(), staleTime: 15_000 } });
  const deposit = useCreateDeposit();

  const amount = custom ? parseUsd(custom) : preset !== null ? BigInt(preset) * AUSD_UNIT : null;
  const overLimit = amount !== null && amount > LIMITS.maxDepositUnits;
  const sponsor = config.data?.sponsor;
  const deskReady = sponsor?.depositReady ?? true;

  const onAdd = () => {
    if (amount === null) return;
    deposit.mutate(
      { data: { amount: amount.toString() } },
      {
        onSuccess: (item) => {
          if (Platform.OS !== 'web') void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          void queryClient.invalidateQueries({ queryKey: getGetMyBalanceQueryKey() });
          void queryClient.invalidateQueries({ queryKey: getListMyActivityQueryKey() });
          router.replace({ pathname: '/receipt/[id]', params: { id: item.id } });
        },
      },
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ModalHeader title="Add money" onClose={() => router.back()} />
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={[styles.container, { paddingBottom: bottom + 24 }]}
        bottomOffset={24}
      >
        <View style={styles.grid}>
          {PRESETS.map((v) => {
            const selected = !custom && preset === v;
            return (
              <Pressable
                key={v}
                onPress={() => {
                  setPreset(v);
                  setCustom('');
                }}
                style={[
                  styles.preset,
                  {
                    backgroundColor: selected ? c.primary : c.card,
                    borderColor: selected ? c.primary : c.border,
                    borderRadius: c.radius,
                  },
                ]}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                testID={`preset-${v}`}
              >
                <Text style={[styles.presetText, { color: selected ? c.primaryForeground : c.foreground }]}>${v}</Text>
              </Pressable>
            );
          })}
        </View>

        <View style={{ gap: 8 }}>
          <Text style={[styles.label, { color: c.foreground }]}>Or another amount</Text>
          <View style={[styles.customWrap, { backgroundColor: c.card, borderColor: c.input, borderRadius: c.radius - 4 }]}>
            <Text style={[styles.dollar, { color: c.mutedForeground }]}>$</Text>
            <TextInput
              value={custom}
              onChangeText={(t) => {
                const cleaned = t.replace(/[^0-9.]/g, '');
                if (/^\d{0,4}(\.\d{0,2})?$/.test(cleaned)) setCustom(cleaned);
              }}
              placeholder="0.00"
              placeholderTextColor={c.mutedForeground}
              keyboardType="decimal-pad"
              inputMode="decimal"
              style={[styles.customInput, { color: c.foreground }]}
              accessibilityLabel="Custom amount in dollars"
              testID="input-deposit-amount"
            />
          </View>
          <Text style={[styles.hint, { color: overLimit ? c.destructive : c.mutedForeground }]}>
            Up to {formatUsd(LIMITS.maxDepositUnits)} at a time, {LIMITS.dailyDepositCount} times or{' '}
            {formatUsd(LIMITS.dailyDepositUnits)} a day.
          </Text>
        </View>

        <Notice tone="info" title="How this works on testnet">
          Gullak's desk swaps its test tokens for AUSD through Agora Instant Settlement and sends the AUSD straight to your
          Gullak. It usually lands in a couple of seconds.
        </Notice>

        {!deskReady ? (
          <Notice tone="warning" title="Add money is paused">
            {`The add-money desk is restocking. Try again in a little while.${devDetail(sponsor?.problem)}`}
          </Notice>
        ) : null}

        {deposit.error ? <Notice tone="error">{apiErrorMessage(deposit.error)}</Notice> : null}

        <Button
          title={amount !== null ? `Add ${formatUsd(amount)}` : 'Add money'}
          icon="plus"
          onPress={onAdd}
          loading={deposit.isPending}
          disabled={amount === null || overLimit || !deskReady}
          testID="button-confirm-deposit"
        />
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 20, gap: 22, maxWidth: 560, width: '100%', alignSelf: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  preset: { flexBasis: '46%', flexGrow: 1, minHeight: 72, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  presetText: { fontFamily: fonts.displayBold, fontSize: 28 },
  label: { fontFamily: fonts.semibold, fontSize: 14 },
  customWrap: { borderWidth: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, minHeight: 52 },
  dollar: { fontFamily: fonts.medium, fontSize: 17, marginRight: 4 },
  customInput: { flex: 1, fontFamily: fonts.regular, fontSize: 17, minHeight: 50 },
  hint: { fontFamily: fonts.regular, fontSize: 13 },
});
