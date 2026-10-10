import Feather from '@expo/vector-icons/Feather';
import {
  getGetConfigQueryKey,
  getGetMyBalanceQueryKey,
  getListMyActivityQueryKey,
  useGetConfig,
  useGetMyBalance,
  useListMyActivity,
} from '@workspace/api-client-react';
import { currencyForCountry, formatUsd } from '@workspace/gullak-core';
import { router } from 'expo-router';
import React from 'react';
import { Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ActivityRow } from '@/components/ActivityRow';
import { Avatar, Card, Notice, SectionTitle, useTopInset } from '@/components/ui';
import { fonts } from '@/constants/typography';
import { useWallet } from '@/contexts/WalletContext';
import { useColors } from '@/hooks/useColors';
import { useFx } from '@/hooks/useFx';
import { RatesCredit } from '@/components/RatesCredit';
import { apiErrorMessage, devDetail } from '@/lib/errors';

const RECENT = { limit: 5 } as const;

export default function HomeScreen() {
  const c = useColors();
  const top = useTopInset();
  const insets = useSafeAreaInsets();
  const { member } = useWallet();

  const balance = useGetMyBalance({ query: { queryKey: getGetMyBalanceQueryKey(), refetchInterval: 8_000 } });
  const activity = useListMyActivity(RECENT, {
    query: { queryKey: getListMyActivityQueryKey(RECENT), refetchInterval: 8_000 },
  });
  const config = useGetConfig({ query: { queryKey: getGetConfigQueryKey(), refetchInterval: 30_000 } });
  const { localFor, rates } = useFx();

  const refreshing = balance.isRefetching || activity.isRefetching;
  const onRefresh = () => {
    void balance.refetch();
    void activity.refetch();
    void config.refetch();
  };

  const sponsor = config.data?.sponsor;
  const localBalance =
    balance.data && BigInt(balance.data.amount) > 0n ? localFor(balance.data.amount, currencyForCountry(member?.country)) : null;
  const firstName = member?.displayName.split(' ')[0] ?? '';
  const bottomPad = Platform.OS === 'web' ? 84 + 24 : insets.bottom + 90;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.background }}
      contentContainerStyle={[styles.container, { paddingTop: top + 12, paddingBottom: bottomPad }]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
    >
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.hello, { color: c.mutedForeground }]}>Namaste,</Text>
          <Text style={[styles.name, { color: c.foreground }]} numberOfLines={1}>
            {firstName}
          </Text>
        </View>
        <Pressable onPress={() => router.navigate('/account')} accessibilityRole="button" accessibilityLabel="Account">
          <Avatar name={member?.displayName ?? '?'} size={46} />
        </Pressable>
      </View>

      <View style={[styles.balanceCard, { backgroundColor: c.clay, borderRadius: c.radius + 6 }]}>
        <View style={[styles.balanceRing, { borderColor: c.accent }]} />
        <Text style={[styles.balanceLabel, { color: c.primaryForeground }]}>In your Gullak</Text>
        <Text style={[styles.balance, { color: c.primaryForeground }]} testID="text-balance">
          {balance.data ? formatUsd(balance.data.amount) : balance.isError ? '—' : '…'}
        </Text>
        {localBalance ? (
          <Text style={[styles.balanceLocal, { color: c.primaryForeground }]} testID="text-balance-local">
            {localBalance}
          </Text>
        ) : null}
        <Text style={[styles.balanceMeta, { color: c.primaryForeground }]}>
          {balance.isError ? apiErrorMessage(balance.error) : `@${member?.handle ?? ''} · AUSD on Monad`}
        </Text>
      </View>

      <View style={styles.actions}>
        <Pressable
          onPress={() => router.push('/send')}
          style={({ pressed }) => [styles.action, { backgroundColor: c.primary, borderRadius: c.radius, opacity: pressed ? 0.85 : 1 }]}
          accessibilityRole="button"
          testID="button-send"
        >
          <Feather name="send" size={20} color={c.primaryForeground} />
          <Text style={[styles.actionText, { color: c.primaryForeground }]}>Send</Text>
        </Pressable>
        <Pressable
          onPress={() => router.push('/add-money')}
          style={({ pressed }) => [
            styles.action,
            { backgroundColor: c.card, borderColor: c.border, borderWidth: 1, borderRadius: c.radius, opacity: pressed ? 0.85 : 1 },
          ]}
          accessibilityRole="button"
          testID="button-add-money"
        >
          <Feather name="plus" size={20} color={c.primary} />
          <Text style={[styles.actionText, { color: c.foreground }]}>Add money</Text>
        </Pressable>
        <Pressable
          onPress={() => router.push('/cash-out')}
          style={({ pressed }) => [
            styles.action,
            { backgroundColor: c.card, borderColor: c.border, borderWidth: 1, borderRadius: c.radius, opacity: pressed ? 0.85 : 1 },
          ]}
          accessibilityRole="button"
          testID="button-cash-out"
        >
          <Feather name="credit-card" size={20} color={c.primary} />
          <Text style={[styles.actionText, { color: c.foreground }]}>Cash out</Text>
        </Pressable>
      </View>

      {sponsor && !sponsor.relayReady ? (
        <Notice tone="warning" title="Sending is paused">
          {`Gullak can't cover network fees right now, so sends are on hold. Your money is safe.${devDetail(sponsor.problem)}`}
        </Notice>
      ) : null}

      <View>
        <SectionTitle action={{ label: 'See all', onPress: () => router.navigate('/activity') }}>Recent</SectionTitle>
        <Card style={{ paddingVertical: 4 }}>
          {activity.data && activity.data.length > 0 ? (
            activity.data.map((item) => <ActivityRow key={item.id} item={item} />)
          ) : (
            <View style={styles.empty}>
              <Feather name="inbox" size={22} color={c.mutedForeground} />
              <Text style={[styles.emptyText, { color: c.mutedForeground }]}>
                {activity.isError
                  ? apiErrorMessage(activity.error)
                  : activity.isPending
                    ? 'Loading…'
                    : 'Nothing yet. Add money to fill your Gullak, then send some to family.'}
              </Text>
            </View>
          )}
        </Card>
      </View>

      {localBalance ? <RatesCredit asOf={rates?.asOf} /> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 20, gap: 20, maxWidth: 640, width: '100%', alignSelf: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  hello: { fontFamily: fonts.regular, fontSize: 15 },
  name: { fontFamily: fonts.display, fontSize: 28 },
  balanceCard: { padding: 24, gap: 6, overflow: 'hidden' },
  balanceRing: {
    position: 'absolute',
    right: -40,
    top: -40,
    width: 160,
    height: 160,
    borderRadius: 80,
    borderWidth: 18,
    opacity: 0.35,
  },
  balanceLabel: { fontFamily: fonts.medium, fontSize: 14, opacity: 0.9 },
  balance: { fontFamily: fonts.displayBold, fontSize: 46, letterSpacing: -0.5 },
  balanceLocal: { fontFamily: fonts.semibold, fontSize: 17, marginTop: -4, opacity: 0.95 },
  balanceMeta: { fontFamily: fonts.regular, fontSize: 13, opacity: 0.85 },
  actions: { flexDirection: 'row', gap: 10 },
  action: { flex: 1, minHeight: 72, paddingVertical: 10, alignItems: 'center', justifyContent: 'center', gap: 6 },
  actionText: { fontFamily: fonts.semibold, fontSize: 14 },
  empty: { alignItems: 'center', gap: 8, paddingVertical: 24, paddingHorizontal: 12 },
  emptyText: { fontFamily: fonts.regular, fontSize: 14, textAlign: 'center', lineHeight: 20 },
});
