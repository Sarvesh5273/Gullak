import { getGetConfigQueryKey, useGetConfig } from '@workspace/api-client-react';
import { SESSION_POLICY, countryByCode, explorerAddressUrl, flagEmoji, formatUsd } from '@workspace/gullak-core';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import React, { useState } from 'react';
import { Alert, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar, Button, Card, DetailRow, Pill, SectionTitle, useTopInset } from '@/components/ui';
import { fonts } from '@/constants/typography';
import { useWallet } from '@/contexts/WalletContext';
import { useColors } from '@/hooks/useColors';

function confirmForget(onConfirm: () => void) {
  const message = 'Gullak will forget this account on this device. Your money stays safe; unlock again any time with your passkey.';
  if (Platform.OS === 'web') {
    if (window.confirm(message)) onConfirm();
    return;
  }
  Alert.alert('Forget this device?', message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Forget', style: 'destructive', onPress: onConfirm },
  ]);
}

export default function AccountScreen() {
  const c = useColors();
  const top = useTopInset();
  const insets = useSafeAreaInsets();
  const { member, address, budgetLeftUnits, lock, forgetDevice } = useWallet();
  const config = useGetConfig({ query: { queryKey: getGetConfigQueryKey(), staleTime: 30_000 } });
  const [copied, setCopied] = useState(false);

  const sponsor = config.data?.sponsor;
  const country = countryByCode(member?.country);
  const bottomPad = Platform.OS === 'web' ? 84 + 24 : insets.bottom + 90;
  const short = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '';

  const copy = async () => {
    if (!address) return;
    await Clipboard.setStringAsync(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.background }}
      contentContainerStyle={[styles.container, { paddingTop: top + 12, paddingBottom: bottomPad }]}
    >
      <Text style={[styles.title, { color: c.foreground }]}>Account</Text>

      <Card style={styles.profile}>
        <Avatar name={member?.displayName ?? '?'} size={64} />
        <Text style={[styles.name, { color: c.foreground }]}>{member?.displayName}</Text>
        <Text style={[styles.handle, { color: c.mutedForeground }]}>@{member?.handle}</Text>
        <Button
          title={copied ? 'Address copied' : `Copy address ${short}`}
          icon={copied ? 'check' : 'copy'}
          variant="secondary"
          onPress={copy}
          style={{ alignSelf: 'stretch', marginTop: 8 }}
          testID="button-copy-address"
        />
      </Card>

      <View>
        <SectionTitle>Money</SectionTitle>
        <Card style={{ paddingVertical: 4 }}>
          <DetailRow
            label="Country"
            value={country ? `${flagEmoji(country.code)} ${country.name} · ${country.currency}` : 'Choose'}
            onPress={() => router.push('/country')}
            navigates
            testID="row-country"
          />
        </Card>
      </View>

      <View>
        <SectionTitle>Security</SectionTitle>
        <Card style={{ gap: 12 }}>
          <Text style={[styles.body, { color: c.foreground }]}>
            Unlocked with your passkey. Your key lives only in this app's memory and is never sent to Gullak.
          </Text>
          <DetailRow
            label="Quick sends left"
            value={`${formatUsd(budgetLeftUnits)} of ${formatUsd(SESSION_POLICY.budgetUnits)}`}
          />
          <Text style={[styles.note, { color: c.mutedForeground }]}>
            Bigger sends ask for your passkey again. Gullak locks after 10 minutes without activity, after 30 minutes, or
            when it sits in the background.
          </Text>
          <Button title="Lock now" icon="lock" variant="secondary" onPress={() => lock()} testID="button-lock" />
        </Card>
      </View>

      <View>
        <SectionTitle>Network</SectionTitle>
        <Card style={{ paddingVertical: 4 }}>
          <DetailRow label="Money" value="AUSD (Agora) · Monad testnet" />
          <DetailRow label="Network fees" value="Paid by Gullak" />
          <View style={[styles.statusRow, { borderBottomColor: c.border }]}>
            <Text style={[styles.statusLabel, { color: c.mutedForeground }]}>Gas sponsor</Text>
            <Pill
              label={!sponsor ? 'Checking' : sponsor.relayReady ? 'Ready' : 'Paused'}
              tone={!sponsor ? 'neutral' : sponsor.relayReady ? 'success' : 'warning'}
            />
          </View>
          {address ? (
            <DetailRow label="Your account" value="View on MonadVision" onPress={() => WebBrowser.openBrowserAsync(explorerAddressUrl(address))} />
          ) : null}
        </Card>
      </View>

      <Button title="Forget this device" variant="danger" onPress={() => confirmForget(() => void forgetDevice())} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 20, gap: 20, maxWidth: 640, width: '100%', alignSelf: 'center' },
  title: { fontFamily: fonts.display, fontSize: 30 },
  profile: { alignItems: 'center', gap: 4, paddingVertical: 20 },
  name: { fontFamily: fonts.display, fontSize: 24, marginTop: 8 },
  handle: { fontFamily: fonts.regular, fontSize: 15 },
  body: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20 },
  note: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 19 },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  statusLabel: { fontFamily: fonts.regular, fontSize: 14 },
});
