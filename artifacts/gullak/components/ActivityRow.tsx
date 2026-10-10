import type { ActivityItem } from '@workspace/api-client-react';
import { formatUsd } from '@workspace/gullak-core';
import { router } from 'expo-router';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Avatar } from '@/components/ui';
import { fonts } from '@/constants/typography';
import { useColors } from '@/hooks/useColors';

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 45) return 'Just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function activityTitle(item: ActivityItem): string {
  if (item.kind === 'deposit') return 'Added money';
  if (item.kind === 'cashout') return item.payout?.recipientName ?? 'Cashed out';
  return item.counterparty.displayName;
}

function payoutSubtitle(item: ActivityItem): string {
  switch (item.payout?.state) {
    case 'sending':
    case 'settling':
      return 'Settling…';
    case 'refunding':
      return 'Payout failed · returning money';
    case 'refunded':
      return 'Not paid out · money returned';
    case 'not_sent':
      return 'Not paid out';
    default:
      return `${item.payout?.destination ?? 'UPI'} · simulated payout`;
  }
}

/** Money coming into the Gullak (shown with + and in green). */
export function isIncoming(item: ActivityItem): boolean {
  return item.kind === 'receive' || item.kind === 'deposit';
}

export function ActivityRow({ item }: { item: ActivityItem }) {
  const c = useColors();
  const incoming = isIncoming(item);
  const amount = formatUsd(item.amount);
  const subtitle =
    item.kind === 'cashout'
      ? payoutSubtitle(item)
      : item.status === 'failed'
        ? 'Not sent'
        : item.status === 'pending'
          ? 'Sending…'
          : item.note || (item.counterparty.handle ? `@${item.counterparty.handle}` : relativeTime(item.createdAt));

  return (
    <Pressable
      onPress={() => router.push({ pathname: '/receipt/[id]', params: { id: item.id } })}
      accessibilityRole="button"
      accessibilityLabel={`${activityTitle(item)}, ${incoming ? 'plus' : 'minus'} ${amount}`}
      style={({ pressed }) => [styles.row, { opacity: pressed ? 0.7 : 1 }]}
      testID={`activity-${item.id}`}
    >
      <Avatar
        name={item.counterparty.displayName}
        icon={item.kind === 'deposit' ? 'plus' : item.kind === 'cashout' && !item.payout?.recipientName ? 'credit-card' : undefined}
      />
      <View style={styles.middle}>
        <Text style={[styles.title, { color: c.foreground }]} numberOfLines={1}>
          {activityTitle(item)}
        </Text>
        <Text
          style={[styles.subtitle, { color: item.status === 'failed' ? c.destructive : c.mutedForeground }]}
          numberOfLines={1}
        >
          {subtitle}
        </Text>
      </View>
      <View style={styles.right}>
        <Text
          style={[
            styles.amount,
            {
              color: item.status === 'failed' ? c.mutedForeground : incoming ? c.success : c.foreground,
              textDecorationLine: item.status === 'failed' ? 'line-through' : 'none',
            },
          ]}
        >
          {incoming ? '+' : '−'}
          {amount}
        </Text>
        <Text style={[styles.time, { color: c.mutedForeground }]}>{relativeTime(item.createdAt)}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  middle: { flex: 1, gap: 2 },
  title: { fontFamily: fonts.semibold, fontSize: 15 },
  subtitle: { fontFamily: fonts.regular, fontSize: 13 },
  right: { alignItems: 'flex-end', gap: 2 },
  amount: { fontFamily: fonts.semibold, fontSize: 15 },
  time: { fontFamily: fonts.regular, fontSize: 12 },
});
