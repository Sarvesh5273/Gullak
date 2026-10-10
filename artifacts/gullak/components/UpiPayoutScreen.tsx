import { isMeraError } from '@category-labs/mera';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetConfigQueryKey,
  getGetMyBalanceQueryKey,
  getListMyActivityQueryKey,
  useCreateCashout,
  useGetConfig,
  useGetMyBalance,
} from '@workspace/api-client-react';
import { LIMITS, PAYOUT_CURRENCY, formatUsd, normalizeUpiId, parseUsd, upiIdProblem } from '@workspace/gullak-core';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Address } from 'viem';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { RatesCredit } from '@/components/RatesCredit';
import { Button, ModalHeader, Notice, useBottomInset } from '@/components/ui';
import { fonts } from '@/constants/typography';
import { useWallet } from '@/contexts/WalletContext';
import { useColors } from '@/hooks/useColors';
import { useFx } from '@/hooks/useFx';
import { useHeldAuthorization } from '@/hooks/useHeldAuthorization';
import { UNCERTAIN_EARLIER_PAYMENT, apiErrorMessage, devDetail, passkeyErrorMessage, paymentFailureMessage } from '@/lib/errors';

const QUICK_AMOUNTS = [10, 25, 50, 100];

function sanitizeAmount(text: string): string | null {
  const cleaned = text.replace(/[^0-9.]/g, '');
  return /^\d{0,6}(\.\d{0,2})?$/.test(cleaned) ? cleaned : null;
}

/**
 * A rupee payout to a UPI ID: your own ("self", cash out) or someone else's
 * ("family", Send to UPI). Same flow either way: AUSD goes to the Gullak desk,
 * the desk settles it through Agora Instant Settlement, and on testnet the
 * rupee payout itself is simulated.
 */
export function UpiPayoutScreen({ mode }: { mode: 'self' | 'family' }) {
  const c = useColors();
  const bottom = useBottomInset();
  const queryClient = useQueryClient();
  const { needsStepUp } = useWallet();
  const held = useHeldAuthorization();
  const family = mode === 'family';

  const [amountInput, setAmountInput] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [upiInput, setUpiInput] = useState('');
  const [note, setNote] = useState('');
  const [upiTouched, setUpiTouched] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const config = useGetConfig({ query: { queryKey: getGetConfigQueryKey(), staleTime: 15_000 } });
  const balance = useGetMyBalance({ query: { queryKey: getGetMyBalanceQueryKey() } });
  const createCashout = useCreateCashout();
  const { localFor, rates } = useFx();

  const sponsor = config.data?.sponsor;
  const desk = sponsor?.address ?? null;
  const deskReady = !!desk && (sponsor?.relayReady ?? false);
  const amount = parseUsd(amountInput);
  const name = nameInput.trim();
  const firstName = name.split(' ')[0] ?? '';
  const available = balance.data ? BigInt(balance.data.amount) : null;
  const overBalance = amount !== null && available !== null && amount > available;
  const overLimit = amount !== null && amount > LIMITS.maxCashoutUnits;
  const upiProblem = upiIdProblem(upiInput);
  const stepUp = amount !== null && needsStepUp(amount);
  const ready = deskReady && amount !== null && !overBalance && !overLimit && !upiProblem && (!family || !!name);
  const localPayout = amount !== null && amount > 0n && !overLimit ? localFor(amount, PAYOUT_CURRENCY) : null;
  const upi = normalizeUpiId(upiInput);
  const intent = amount !== null && !upiProblem ? `upi|${upi}|${amount}` : null;
  const warnUncertain = !!held.uncertainIntent && held.uncertainIntent !== intent;

  const onConfirm = async () => {
    if (!desk || amount === null || upiProblem || !intent || (family && !name)) return;
    setError(null);
    setWorking(true);
    let input;
    try {
      input = await held.authorize(desk as Address, amount, intent);
    } catch (err) {
      setError(isMeraError(err) ? passkeyErrorMessage(err) : apiErrorMessage(err, err instanceof Error ? err.message : undefined));
      setWorking(false);
      return;
    }
    try {
      const trimmedNote = note.trim();
      const item = await createCashout.mutateAsync({
        data: {
          ...input,
          upiId: upi,
          ...(family ? { recipientName: name } : {}),
          ...(family && trimmedNote ? { note: trimmedNote } : {}),
        },
      });
      held.accepted();
      if (Platform.OS !== 'web') void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      void queryClient.invalidateQueries({ queryKey: getGetMyBalanceQueryKey() });
      void queryClient.invalidateQueries({ queryKey: getListMyActivityQueryKey() });
      router.replace({ pathname: '/receipt/[id]', params: { id: item.id } });
    } catch (err) {
      held.failed(err);
      void queryClient.invalidateQueries({ queryKey: getGetMyBalanceQueryKey() });
      void queryClient.invalidateQueries({ queryKey: getListMyActivityQueryKey() });
      setError(paymentFailureMessage(err));
      setWorking(false);
    }
  };

  const amountColor = overBalance || overLimit ? c.destructive : c.foreground;
  const showUpiProblem = upiTouched && !!upiInput && !!upiProblem;
  const inputStyle = [styles.input, { backgroundColor: c.card, borderColor: c.input, color: c.foreground, borderRadius: c.radius - 4 }];
  const buttonTitle =
    amount === null ? (family ? 'Send to UPI' : 'Cash out') : family ? `Send ${formatUsd(amount)}${firstName ? ` to ${firstName}` : ''}` : `Cash out ${formatUsd(amount)}`;

  const upiField = (
    <View style={{ gap: 8 }}>
      <Text style={[styles.label, { color: c.foreground }]}>{family ? 'Their UPI ID' : 'To your UPI ID'}</Text>
      <TextInput
        value={upiInput}
        onChangeText={(t) => setUpiInput(t.replace(/\s/g, ''))}
        onBlur={() => setUpiTouched(true)}
        placeholder="name@okhdfc"
        placeholderTextColor={c.mutedForeground}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        maxLength={100}
        style={[...inputStyle, { borderColor: showUpiProblem ? c.destructive : c.input }]}
        accessibilityLabel={family ? 'Their UPI ID' : 'Your UPI ID'}
        testID="input-upi-id"
      />
      <Text style={[styles.hint, { color: showUpiProblem ? c.destructive : c.mutedForeground }]}>
        {showUpiProblem ? upiProblem : 'Gullak keeps only a masked copy, like na•••@okhdfc.'}
      </Text>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ModalHeader title={family ? 'Send to UPI' : 'Cash out'} onClose={() => router.back()} />
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={[styles.container, { paddingBottom: bottom + 24 }]}
        bottomOffset={24}
      >
        {family ? (
          <>
            <View style={{ gap: 8 }}>
              <Text style={[styles.label, { color: c.foreground }]}>Who is it for?</Text>
              <TextInput
                value={nameInput}
                onChangeText={setNameInput}
                placeholder="Mom"
                placeholderTextColor={c.mutedForeground}
                autoFocus
                autoCapitalize="words"
                maxLength={40}
                style={inputStyle}
                accessibilityLabel="Recipient's name"
                testID="input-recipient-name"
              />
              <Text style={[styles.hint, { color: c.mutedForeground }]}>They don't need Gullak, just a UPI ID.</Text>
            </View>
            {upiField}
          </>
        ) : null}

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
              autoFocus={!family}
              style={[styles.amountInput, { color: amountColor }]}
              accessibilityLabel={family ? 'Amount to send in dollars' : 'Amount to cash out in dollars'}
              testID="input-cashout-amount"
            />
          </View>
          {localPayout ? (
            <Text style={[styles.local, { color: c.primary }]} testID="text-cashout-local">
              {family ? `${firstName || 'They'} ${firstName ? 'gets' : 'get'} ${localPayout}` : `${localPayout} to your bank`}
            </Text>
          ) : null}
          {localPayout ? (
            <Text style={[styles.hint, { color: c.mutedForeground, textAlign: 'center' }]}>
              Indicative rupee amount. The payout is simulated on testnet.
            </Text>
          ) : null}
          <Text style={[styles.hint, { color: overBalance || overLimit ? c.destructive : c.mutedForeground, textAlign: 'center' }]}>
            {overLimit
              ? `Pay out up to ${formatUsd(LIMITS.maxCashoutUnits)} at a time.`
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

        {family ? (
          <View style={{ gap: 8 }}>
            <Text style={[styles.label, { color: c.foreground }]}>Note</Text>
            <TextInput
              value={note}
              onChangeText={setNote}
              placeholder="What's it for? (optional)"
              placeholderTextColor={c.mutedForeground}
              maxLength={140}
              style={inputStyle}
              accessibilityLabel="Note"
              testID="input-note"
            />
          </View>
        ) : (
          upiField
        )}

        <Notice tone="info" title="How this works on testnet">
          Your AUSD really settles on Monad: Agora Instant Settlement swaps it for CTK, Agora's test token. The rupee payout to the
          UPI ID is simulated, since testnet has no real money, and the rupee amount is indicative.
        </Notice>

        {sponsor && !deskReady ? (
          <Notice tone="warning" title="Payouts are paused">
            {`Gullak can't cover network fees right now. Your money is safe.${devDetail(sponsor.problem)}`}
          </Notice>
        ) : null}

        {warnUncertain ? <Notice tone="warning">{UNCERTAIN_EARLIER_PAYMENT}</Notice> : null}
        {error ? <Notice tone="error">{error}</Notice> : null}

        <View style={{ gap: 10 }}>
          <Button
            title={buttonTitle}
            icon={stepUp ? 'key' : family ? 'send' : 'credit-card'}
            onPress={onConfirm}
            loading={working}
            disabled={!ready || working}
            testID="button-confirm-cashout"
          />
          <Text style={[styles.footnote, { color: c.mutedForeground }]}>
            {stepUp
              ? "This is over your quick-send amount, so you'll confirm with your passkey."
              : 'Usually done in a few seconds. Gullak pays the network fees.'}
          </Text>
          {localPayout ? <RatesCredit asOf={rates?.asOf} /> : null}
        </View>
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 20, gap: 24, maxWidth: 560, width: '100%', alignSelf: 'center' },
  label: { fontFamily: fonts.semibold, fontSize: 14 },
  hint: { fontFamily: fonts.regular, fontSize: 13 },
  local: { fontFamily: fonts.semibold, fontSize: 18, textAlign: 'center' },
  amountBlock: { alignItems: 'center', gap: 8 },
  amountRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  dollar: { fontFamily: fonts.display, fontSize: 40, marginRight: 2 },
  amountInput: { fontFamily: fonts.displayBold, fontSize: 56, minWidth: 80, textAlign: 'center', paddingVertical: 4 },
  chips: { flexDirection: 'row', gap: 8, marginTop: 4 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999 },
  chipText: { fontFamily: fonts.semibold, fontSize: 14 },
  input: { borderWidth: 1, paddingHorizontal: 14, minHeight: 50, fontFamily: fonts.regular, fontSize: 16 },
  footnote: { fontFamily: fonts.regular, fontSize: 13, textAlign: 'center', lineHeight: 18 },
});
