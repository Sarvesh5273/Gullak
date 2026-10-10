import Feather from '@expo/vector-icons/Feather';
import { isMeraError } from '@category-labs/mera';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetMemberQueryKey,
  getGetMyBalanceQueryKey,
  getListMyActivityQueryKey,
  useCreateTransfer,
  useGetMember,
  useGetMyBalance,
} from '@workspace/api-client-react';
import { LIMITS, currencyForCountry, formatUsd, handleProblem, normalizeHandle, parseUsd } from '@workspace/gullak-core';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Address } from 'viem';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { Avatar, Button, Card, ModalHeader, Notice, useBottomInset } from '@/components/ui';
import { fonts } from '@/constants/typography';
import { useWallet } from '@/contexts/WalletContext';
import { useColors } from '@/hooks/useColors';
import { useDebounced } from '@/hooks/useDebounced';
import { useFx } from '@/hooks/useFx';
import { useHeldAuthorization } from '@/hooks/useHeldAuthorization';
import { RatesCredit } from '@/components/RatesCredit';
import {
  UNCERTAIN_EARLIER_PAYMENT,
  apiErrorMessage,
  apiErrorStatus,
  passkeyErrorMessage,
  paymentFailureMessage,
} from '@/lib/errors';

const QUICK_AMOUNTS = [10, 25, 50, 100];

function sanitizeAmount(text: string): string | null {
  const cleaned = text.replace(/[^0-9.]/g, '');
  return /^\d{0,7}(\.\d{0,2})?$/.test(cleaned) ? cleaned : null;
}

export default function SendScreen() {
  const c = useColors();
  const bottom = useBottomInset();
  const queryClient = useQueryClient();
  const params = useLocalSearchParams<{ to?: string }>();
  const { member: me, needsStepUp } = useWallet();
  const held = useHeldAuthorization();

  const [handleInput, setHandleInput] = useState(params.to ?? '');
  const [amountInput, setAmountInput] = useState('');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handle = normalizeHandle(handleInput);
  const debounced = useDebounced(handle, 300);
  const isSelf = !!debounced && debounced === me?.handle;
  const lookupEnabled = !!debounced && !handleProblem(debounced) && !isSelf;
  const recipient = useGetMember(debounced, {
    query: { queryKey: getGetMemberQueryKey(debounced), enabled: lookupEnabled, retry: false, staleTime: 60_000 },
  });
  const balance = useGetMyBalance({ query: { queryKey: getGetMyBalanceQueryKey() } });
  const createTransfer = useCreateTransfer();
  const { localFor, rates } = useFx();

  const target = handle === debounced && recipient.data && recipient.data.handle === debounced ? recipient.data : null;
  const amount = parseUsd(amountInput);
  const available = balance.data ? BigInt(balance.data.amount) : null;
  const overBalance = amount !== null && available !== null && amount > available;
  const overLimit = amount !== null && amount > LIMITS.maxSendUnits;
  const stepUp = amount !== null && needsStepUp(amount);
  const canSend = !!target && amount !== null && !overBalance && !overLimit && !sending;
  const recipientLocal =
    target && amount !== null && amount > 0n && !overLimit
      ? localFor(amount, currencyForCountry(target.country))
      : null;

  let recipientLine: React.ReactNode = null;
  if (handle && handleProblem(handle)) recipientLine = handleProblem(handle);
  else if (handle && handle === me?.handle) recipientLine = "That's you.";
  else if (handle && (handle !== debounced || recipient.isFetching)) recipientLine = 'Looking up…';
  else if (recipient.error) {
    recipientLine = apiErrorStatus(recipient.error) === 404 ? `No one is called @${debounced}.` : apiErrorMessage(recipient.error);
  }

  const intent = target && amount !== null ? `send|${target.address}|${amount}` : null;
  const warnUncertain = !!held.uncertainIntent && held.uncertainIntent !== intent;

  const onSend = async () => {
    if (!target || amount === null || !intent) return;
    setError(null);
    setSending(true);
    let input;
    try {
      input = await held.authorize(target.address as Address, amount, intent);
    } catch (err) {
      setError(isMeraError(err) ? passkeyErrorMessage(err) : apiErrorMessage(err, err instanceof Error ? err.message : undefined));
      setSending(false);
      return;
    }
    try {
      const trimmed = note.trim();
      const item = await createTransfer.mutateAsync({
        data: { ...input, ...(trimmed ? { note: trimmed } : {}) },
      });
      held.accepted();
      if (Platform.OS !== 'web') void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      void queryClient.invalidateQueries({ queryKey: getGetMyBalanceQueryKey() });
      void queryClient.invalidateQueries({ queryKey: getListMyActivityQueryKey() });
      router.replace({ pathname: '/receipt/[id]', params: { id: item.id } });
    } catch (err) {
      held.failed(err);
      void queryClient.invalidateQueries({ queryKey: getListMyActivityQueryKey() });
      setError(paymentFailureMessage(err));
      setSending(false);
    }
  };

  const amountColor = overBalance || overLimit ? c.destructive : c.foreground;

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ModalHeader title="Send money" onClose={() => router.back()} />
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={[styles.container, { paddingBottom: bottom + 24 }]}
        bottomOffset={24}
      >
        <View style={{ gap: 8 }}>
          <Text style={[styles.label, { color: c.foreground }]}>To</Text>
          <View style={[styles.handleWrap, { backgroundColor: c.card, borderColor: c.input, borderRadius: c.radius - 4 }]}>
            <Text style={[styles.at, { color: c.mutedForeground }]}>@</Text>
            <TextInput
              value={handleInput}
              onChangeText={(t) => setHandleInput(t.replace(/^@/, ''))}
              placeholder="their handle"
              placeholderTextColor={c.mutedForeground}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus={!params.to}
              maxLength={20}
              style={[styles.handleInput, { color: c.foreground }]}
              accessibilityLabel="Recipient handle"
              testID="input-recipient"
            />
            {recipient.isFetching ? <ActivityIndicator color={c.mutedForeground} /> : null}
          </View>
          {target ? (
            <Card style={styles.recipient}>
              <Avatar name={target.displayName} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.recipientName, { color: c.foreground }]}>{target.displayName}</Text>
                <Text style={[styles.recipientHandle, { color: c.mutedForeground }]}>@{target.handle}</Text>
              </View>
              <Feather name="check-circle" size={22} color={c.success} />
            </Card>
          ) : recipientLine ? (
            <Text style={[styles.hint, { color: c.mutedForeground }]}>{recipientLine}</Text>
          ) : null}
          {!target ? (
            <Pressable
              onPress={() => router.replace('/send-upi')}
              accessibilityRole="link"
              style={({ pressed }) => [styles.upiLink, { opacity: pressed ? 0.6 : 1 }]}
              testID="link-send-upi"
            >
              <Feather name="smartphone" size={16} color={c.primary} />
              <Text style={[styles.upiLinkText, { color: c.primary }]}>Not on Gullak? Send to their UPI ID</Text>
            </Pressable>
          ) : null}
        </View>

        <View style={styles.amountBlock}>
          <View style={styles.amountRow}>
            <Text style={[styles.dollar, { color: amountColor }]}>$</Text>
            <TextInput
              value={amountInput}
              onChangeText={(t) => {
                const next = sanitizeAmount(t);
                if (next !== null) setAmountInput(next);
              }}
              placeholder="0"
              placeholderTextColor={c.muted}
              keyboardType="decimal-pad"
              inputMode="decimal"
              style={[styles.amountInput, { color: amountColor }]}
              accessibilityLabel="Amount in dollars"
              testID="input-amount"
            />
          </View>
          {target && recipientLocal ? (
            <Text style={[styles.local, { color: c.primary }]} testID="text-recipient-local">
              {`${target.displayName.split(' ')[0]} gets ${recipientLocal}`}
            </Text>
          ) : null}
          <Text style={[styles.hint, { color: overBalance || overLimit ? c.destructive : c.mutedForeground, textAlign: 'center' }]}>
            {overLimit
              ? `Sends are limited to ${formatUsd(LIMITS.maxSendUnits)} each.`
              : overBalance
                ? `You have ${formatUsd(available ?? 0n)}.`
                : available !== null
                  ? `Balance ${formatUsd(available)}`
                  : ' '}
          </Text>
          <View style={styles.chips}>
            {QUICK_AMOUNTS.map((v) => (
              <Pressable
                key={v}
                onPress={() => setAmountInput(String(v))}
                style={[styles.chip, { backgroundColor: c.secondary }]}
                accessibilityRole="button"
                accessibilityLabel={`${v} dollars`}
              >
                <Text style={[styles.chipText, { color: c.secondaryForeground }]}>${v}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        <View style={{ gap: 8 }}>
          <Text style={[styles.label, { color: c.foreground }]}>Note</Text>
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder="What's it for? (optional)"
            placeholderTextColor={c.mutedForeground}
            maxLength={140}
            style={[styles.noteInput, { backgroundColor: c.card, borderColor: c.input, color: c.foreground, borderRadius: c.radius - 4 }]}
            accessibilityLabel="Note"
            testID="input-note"
          />
        </View>

        {warnUncertain ? <Notice tone="warning">{UNCERTAIN_EARLIER_PAYMENT}</Notice> : null}
        {error ? <Notice tone="error">{error}</Notice> : null}

        <View style={{ gap: 10 }}>
          <Button
            title={target && amount !== null ? `Send ${formatUsd(amount)} to ${target.displayName.split(' ')[0]}` : 'Send'}
            icon={stepUp ? 'key' : 'send'}
            onPress={onSend}
            loading={sending}
            disabled={!canSend}
            testID="button-confirm-send"
          />
          <Text style={[styles.footnote, { color: c.mutedForeground }]}>
            {stepUp
              ? "This is over your quick-send amount, so you'll confirm with your passkey."
              : 'Arrives in about a second. Gullak pays the network fee.'}
          </Text>
          {recipientLocal ? <RatesCredit asOf={rates?.asOf} /> : null}
        </View>
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 20, gap: 24, maxWidth: 560, width: '100%', alignSelf: 'center' },
  label: { fontFamily: fonts.semibold, fontSize: 14 },
  handleWrap: { borderWidth: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, minHeight: 52, gap: 4 },
  at: { fontFamily: fonts.medium, fontSize: 17 },
  handleInput: { flex: 1, fontFamily: fonts.regular, fontSize: 17, minHeight: 50 },
  hint: { fontFamily: fonts.regular, fontSize: 13 },
  upiLink: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6, alignSelf: 'flex-start' },
  upiLinkText: { fontFamily: fonts.semibold, fontSize: 14 },
  local: { fontFamily: fonts.semibold, fontSize: 18, textAlign: 'center' },
  recipient: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  recipientName: { fontFamily: fonts.semibold, fontSize: 16 },
  recipientHandle: { fontFamily: fonts.regular, fontSize: 13 },
  amountBlock: { alignItems: 'center', gap: 8 },
  amountRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  dollar: { fontFamily: fonts.display, fontSize: 40, marginRight: 2 },
  amountInput: { fontFamily: fonts.displayBold, fontSize: 56, minWidth: 80, textAlign: 'center', paddingVertical: 4 },
  chips: { flexDirection: 'row', gap: 8, marginTop: 4 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999 },
  chipText: { fontFamily: fonts.semibold, fontSize: 14 },
  noteInput: { borderWidth: 1, paddingHorizontal: 14, minHeight: 50, fontFamily: fonts.regular, fontSize: 16 },
  footnote: { fontFamily: fonts.regular, fontSize: 13, textAlign: 'center', lineHeight: 18 },
});
