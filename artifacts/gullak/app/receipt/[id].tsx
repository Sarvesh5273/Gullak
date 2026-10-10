import Feather from '@expo/vector-icons/Feather';
import { getGetActivityItemQueryKey, useGetActivityItem } from '@workspace/api-client-react';
import { formatLocal, formatRate, formatUsd, usdUnitsToLocal } from '@workspace/gullak-core';
import { router, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import React from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { ZoomIn } from 'react-native-reanimated';
import { isIncoming } from '@/components/ActivityRow';
import { RatesCredit } from '@/components/RatesCredit';
import { Button, Card, DetailRow, ModalHeader, Notice, Pill, useBottomInset } from '@/components/ui';
import { fonts } from '@/constants/typography';
import { useColors } from '@/hooks/useColors';
import { apiErrorMessage } from '@/lib/errors';

function formatSettle(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms / 1000)} s`;
}

export default function ReceiptScreen() {
  const c = useColors();
  const bottom = useBottomInset();
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const query = useGetActivityItem(id, {
    query: {
      queryKey: getGetActivityItemQueryKey(id),
      enabled: !!id,
      refetchInterval: (q) => (q.state.data?.status === 'pending' ? 2_000 : false),
    },
  });
  const item = query.data;

  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));

  if (!item) {
    return (
      <View style={{ flex: 1, backgroundColor: c.background }}>
        <ModalHeader title="Receipt" onClose={close} />
        <View style={styles.center}>
          {query.isError ? <Notice tone="error">{apiErrorMessage(query.error)}</Notice> : <ActivityIndicator color={c.primary} />}
        </View>
      </View>
    );
  }

  const name = item.counterparty.displayName;
  const handle = item.counterparty.handle ? ` (@${item.counterparty.handle})` : '';
  const payout = item.kind === 'cashout' ? item.payout : null;
  const payoutState = payout?.state ?? null;
  const recipientName = payout?.recipientName ?? null;
  const firstName = (recipientName ?? name).split(' ')[0];
  const moneyIsMoving = payoutState === 'sending' || payoutState === 'settling' || payoutState === 'refunding';

  let title: string;
  if (payout) {
    title =
      payoutState === 'paid'
        ? recipientName
          ? `Sent to ${recipientName}`
          : 'Cashed out to UPI'
        : payoutState === 'refunding'
          ? 'Payout failed'
          : payoutState === 'refunded' || payoutState === 'not_sent'
            ? 'Not paid out'
            : recipientName
              ? `Sending to ${recipientName}…`
              : 'Cashing out…';
  } else {
    title =
      item.status === 'failed'
        ? 'Not sent'
        : item.kind === 'send'
          ? `Sent to ${name}`
          : item.kind === 'receive'
            ? `From ${name}`
            : 'Added to your Gullak';
  }
  const failureText = item.error ? 'The network did not accept this transfer. No money moved.' : 'Not sent.';
  const openTx = (url: string | null | undefined) => {
    if (url) void WebBrowser.openBrowserAsync(url);
  };
  const shortHash = (hash: string) => `${hash.slice(0, 10)}…${hash.slice(-6)}`;
  // Rate snapshot from when the transfer was made, so the value doesn't drift later.
  const showLocal = item.status !== 'failed' && payoutState !== 'refunding';
  const local = item.fx && showLocal ? usdUnitsToLocal(item.amount, item.fx.rate) : null;
  const localLabel =
    item.kind === 'send'
      ? `${name.split(' ')[0]} gets`
      : payout
        ? recipientName
          ? `${firstName} gets`
          : 'To your bank'
        : 'Local value';
  const circle =
    payoutState === 'refunded'
      ? { bg: c.secondary, fg: c.mutedForeground, icon: 'rotate-ccw' as const }
      : item.status === 'confirmed'
        ? { bg: c.successSoft, fg: c.success, icon: 'check' as const }
        : item.status === 'pending'
          ? { bg: c.warningSoft, fg: c.clayDeep, icon: 'clock' as const }
          : { bg: '#F8E1DE', fg: c.destructive, icon: 'x' as const };
  const pendingLabel =
    payoutState === 'settling' ? 'Settling through Agora…' : payoutState === 'refunding' ? 'Returning your money…' : 'Settling…';
  const when = new Date(item.confirmedAt ?? item.createdAt).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ModalHeader title="Receipt" onClose={close} />
      <ScrollView contentContainerStyle={[styles.container, { paddingBottom: bottom + 24 }]}>
        <View style={styles.hero}>
          <Animated.View entering={ZoomIn.springify()} style={[styles.circle, { backgroundColor: circle.bg }]}>
            <Feather name={circle.icon} size={36} color={circle.fg} />
          </Animated.View>
          <Text style={[styles.amount, { color: c.foreground }]} testID="text-receipt-amount">
            {isIncoming(item) ? '+' : ''}
            {formatUsd(item.amount)}
          </Text>
          <Text style={[styles.title, { color: c.foreground }]} testID="text-receipt-title">
            {title}
          </Text>
          <View style={styles.pills}>
            {item.status === 'confirmed' && item.settleMs !== null ? (
              <Pill label={`${payout ? 'Done' : 'Settled'} in ${formatSettle(item.settleMs)}`} tone="success" />
            ) : item.status === 'pending' ? (
              <Pill label={pendingLabel} tone="warning" />
            ) : null}
            {payoutState === 'paid' ? <Pill label="UPI payout simulated" tone="neutral" /> : null}
          </View>
        </View>

        {payoutState === 'refunding' ? (
          <Notice tone="warning" title="Returning your money">
            {`The settlement didn't go through, so Gullak is sending your ${formatUsd(item.amount)} back. This receipt updates once the return is confirmed on Monad.`}
          </Notice>
        ) : payoutState === 'refunded' ? (
          <Notice tone="info" title="Money returned">
            {`The payout didn't go through, so your ${formatUsd(item.amount)} was returned to your Gullak. The return is confirmed on Monad.`}
          </Notice>
        ) : payoutState === 'not_sent' ? (
          <Notice tone="error">{item.error ?? 'This payout did not go through. No money moved.'}</Notice>
        ) : !payout && item.status === 'failed' ? (
          <Notice tone="error">{failureText}</Notice>
        ) : null}

        <Card style={{ paddingVertical: 4 }}>
          {item.kind === 'deposit' ? (
            <DetailRow label="Via" value="Agora Instant Settlement" />
          ) : payout ? (
            <DetailRow label="To" value={recipientName ? `${recipientName} · ${payout.destination}` : payout.destination} />
          ) : (
            <DetailRow label={item.kind === 'send' ? 'To' : 'From'} value={`${name}${handle}`} />
          )}
          {local && item.fx ? (
            <DetailRow
              label={localLabel}
              value={`≈ ${formatLocal(local, item.fx.currency)} at ${formatRate(item.fx.rate, item.fx.currency)}${payout ? ' (indicative)' : ''}`}
            />
          ) : null}
          {payout?.reference ? <DetailRow label="UPI payout" value={`Simulated · ref ${payout.reference}`} /> : null}
          {item.note ? <DetailRow label="Note" value={item.note} /> : null}
          <DetailRow label="When" value={when} />
          <DetailRow label="Network fee" value="Paid by Gullak" />
          {item.blockNumber ? <DetailRow label="Monad block" value={`#${item.blockNumber}`} /> : null}
          {item.txHash && item.explorerUrl ? (
            <DetailRow
              label={payout ? 'To Gullak desk' : 'Transaction'}
              value={shortHash(item.txHash)}
              onPress={() => openTx(item.explorerUrl)}
            />
          ) : null}
          {payout?.settlementTxHash ? (
            <DetailRow
              label="Instant Settlement"
              value={shortHash(payout.settlementTxHash)}
              onPress={() => openTx(payout.settlementExplorerUrl)}
            />
          ) : null}
          {payout?.settlementTxHash && payoutState === 'paid' ? (
            <DetailRow label="Settled as" value="CTK, Agora's test token" />
          ) : null}
          {payout?.refundTxHash ? (
            <DetailRow
              label={payoutState === 'refunded' ? 'Returned to you' : 'Return (confirming)'}
              value={shortHash(payout.refundTxHash)}
              onPress={() => openTx(payout.refundExplorerUrl)}
            />
          ) : null}
        </Card>

        {local ? <RatesCredit /> : null}
        {moneyIsMoving ? (
          <Text style={[styles.footnote, { color: c.mutedForeground }]}>You can close this; the payout keeps going.</Text>
        ) : null}

        <Button title="Done" onPress={close} testID="button-receipt-done" />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 20, gap: 20, maxWidth: 560, width: '100%', alignSelf: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  hero: { alignItems: 'center', gap: 10, paddingVertical: 12 },
  circle: { width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  amount: { fontFamily: fonts.displayBold, fontSize: 48, letterSpacing: -0.5 },
  title: { fontFamily: fonts.semibold, fontSize: 17, textAlign: 'center' },
  pills: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8 },
  footnote: { fontFamily: fonts.regular, fontSize: 13, textAlign: 'center' },
});
