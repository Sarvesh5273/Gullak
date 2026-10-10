import Feather from '@expo/vector-icons/Feather';
import { Image } from 'expo-image';
import React, { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { ProfileFields, useProfileForm } from '@/components/ProfileForm';
import { Button, Card, Notice, useBottomInset, useTopInset } from '@/components/ui';
import { fonts } from '@/constants/typography';
import { useWallet } from '@/contexts/WalletContext';
import { useColors } from '@/hooks/useColors';
import { apiErrorMessage, passkeyErrorMessage } from '@/lib/errors';
import { isFramed, passkeyUnavailableReason } from '@/lib/webauthn-client';

const FRAMED_HINT = "Passkeys can't open inside this preview frame. Open Gullak in its own tab and try again.";

function openInNewTab() {
  if (Platform.OS === 'web') window.open(window.location.href, '_blank', 'noopener');
}

const POINTS: { icon: React.ComponentProps<typeof Feather>['name']; text: string }[] = [
  { icon: 'key', text: 'Your passkey is your wallet. No seed phrase, and Gullak never holds your key.' },
  { icon: 'zap', text: 'Money reaches family in about a second. Gullak pays the network fee.' },
  { icon: 'dollar-sign', text: "Balances are in AUSD, Agora's digital dollar, on Monad." },
];

export default function WelcomeScreen() {
  const c = useColors();
  const top = useTopInset();
  const bottom = useBottomInset();
  const { status, saved, lockNotice, meError, createAccount, unlock, lock, retryProfileCheck } = useWallet();
  const [mode, setMode] = useState<'start' | 'create'>('start');
  const [busy, setBusy] = useState<null | 'create' | 'unlock' | 'unlock-any'>(null);
  const [error, setError] = useState<string | null>(null);
  const form = useProfileForm();
  const unavailable = passkeyUnavailableReason();
  const framed = isFramed();

  if (status === 'loading') return <View style={{ flex: 1, backgroundColor: c.background }} />;

  const run = async (kind: 'create' | 'unlock' | 'unlock-any', action: () => Promise<void>) => {
    setError(null);
    setBusy(kind);
    try {
      await action();
    } catch (err) {
      setError(framed ? FRAMED_HINT : passkeyErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const opening = status === 'checking';
  const anyBusy = busy !== null || opening;

  return (
    <KeyboardAwareScrollViewCompat
      style={{ flex: 1, backgroundColor: c.background }}
      contentContainerStyle={[styles.container, { paddingTop: top + 24, paddingBottom: bottom + 24 }]}
      bottomOffset={24}
    >
      <View style={styles.hero}>
        <View style={[styles.glow, { backgroundColor: c.warningSoft }]}>
          <Image source={require('@/assets/images/logo.webp')} style={styles.logo} contentFit="cover" />
        </View>
        <Text style={[styles.brand, { color: c.foreground }]}>Gullak</Text>
        <Text style={[styles.tagline, { color: c.mutedForeground }]}>
          The family money pot for families split across borders.
        </Text>
      </View>

      {lockNotice ? <Notice tone="info">{lockNotice}</Notice> : null}

      {unavailable ? (
        <Notice tone="warning" title="Passkeys aren't available here">
          {unavailable}
        </Notice>
      ) : null}

      {status === 'error' ? (
        <Notice
          tone="error"
          title="Couldn't open your Gullak"
          action={{ label: 'Try again', onPress: retryProfileCheck }}
        >
          {apiErrorMessage(meError)}
        </Notice>
      ) : null}

      {error ? (
        <Notice tone="error" action={framed ? { label: 'Open in a new tab', onPress: openInNewTab } : undefined}>
          {error}
        </Notice>
      ) : null}

      {opening ? (
        <View style={styles.opening}>
          <ActivityIndicator color={c.primary} />
          <Text style={[styles.openingText, { color: c.mutedForeground }]}>Opening your Gullak…</Text>
        </View>
      ) : mode === 'create' ? (
        <Card style={{ gap: 20 }}>
          <View style={{ gap: 4 }}>
            <Text style={[styles.cardTitle, { color: c.foreground }]}>Create your Gullak</Text>
            <Text style={[styles.cardBody, { color: c.mutedForeground }]}>
              Next, your phone or browser asks to save a passkey. It may ask twice.
            </Text>
          </View>
          <ProfileFields form={form} autoFocus />
          <Button
            title="Create with passkey"
            icon="key"
            onPress={() =>
              run('create', () => createAccount({ handle: form.handle, displayName: form.displayName }))
            }
            loading={busy === 'create'}
            disabled={!form.valid || !!unavailable || anyBusy}
            testID="button-create"
          />
          <Button title="Back" variant="ghost" onPress={() => setMode('start')} disabled={anyBusy} />
        </Card>
      ) : (
        <View style={{ gap: 12 }}>
          {status === 'error' ? (
            <Button title="Lock" variant="secondary" onPress={() => lock()} />
          ) : saved ? (
            <>
              <Card style={styles.savedCard}>
                <Text style={[styles.savedLabel, { color: c.mutedForeground }]}>Welcome back</Text>
                <Text style={[styles.savedName, { color: c.foreground }]}>{saved.displayName ?? 'Your Gullak'}</Text>
                {saved.handle ? (
                  <Text style={[styles.savedHandle, { color: c.mutedForeground }]}>@{saved.handle}</Text>
                ) : null}
              </Card>
              <Button
                title="Unlock with passkey"
                icon="unlock"
                onPress={() => run('unlock', () => unlock('saved'))}
                loading={busy === 'unlock'}
                disabled={!!unavailable || anyBusy}
                testID="button-unlock"
              />
              <Button
                title="Use a different account"
                variant="ghost"
                onPress={() => run('unlock-any', () => unlock('any'))}
                loading={busy === 'unlock-any'}
                disabled={!!unavailable || anyBusy}
              />
            </>
          ) : (
            <>
              <Button
                title="Create my Gullak"
                onPress={() => setMode('create')}
                disabled={!!unavailable}
                testID="button-start-create"
              />
              <Button
                title="I already have one"
                variant="secondary"
                icon="key"
                onPress={() => run('unlock-any', () => unlock('any'))}
                loading={busy === 'unlock-any'}
                disabled={!!unavailable || anyBusy}
                testID="button-signin"
              />
            </>
          )}
        </View>
      )}

      {mode === 'start' && !opening ? (
        <View style={styles.points}>
          {POINTS.map((p) => (
            <View key={p.icon} style={styles.point}>
              <View style={[styles.pointIcon, { backgroundColor: c.secondary }]}>
                <Feather name={p.icon} size={16} color={c.primary} />
              </View>
              <Text style={[styles.pointText, { color: c.foreground }]}>{p.text}</Text>
            </View>
          ))}
        </View>
      ) : null}

      <View style={styles.footer}>
        {framed ? (
          <Pressable onPress={openInNewTab} accessibilityRole="link" hitSlop={8}>
            <Text style={[styles.footerLink, { color: c.primary }]}>Open in a new tab</Text>
          </Pressable>
        ) : null}
        <Text style={[styles.footerText, { color: c.mutedForeground }]}>Monad testnet preview · test money only</Text>
      </View>
    </KeyboardAwareScrollViewCompat>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 24, gap: 20, maxWidth: 520, width: '100%', alignSelf: 'center', flexGrow: 1 },
  hero: { alignItems: 'center', gap: 10, marginBottom: 8 },
  glow: { width: 132, height: 132, borderRadius: 66, alignItems: 'center', justifyContent: 'center' },
  logo: { width: 104, height: 104, borderRadius: 26 },
  brand: { fontFamily: fonts.displayBold, fontSize: 44, letterSpacing: -0.5 },
  tagline: { fontFamily: fonts.regular, fontSize: 16, lineHeight: 23, textAlign: 'center', maxWidth: 320 },
  opening: { alignItems: 'center', gap: 12, paddingVertical: 24 },
  openingText: { fontFamily: fonts.medium, fontSize: 15 },
  cardTitle: { fontFamily: fonts.display, fontSize: 22 },
  cardBody: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20 },
  savedCard: { alignItems: 'center', gap: 2, paddingVertical: 20 },
  savedLabel: { fontFamily: fonts.medium, fontSize: 13 },
  savedName: { fontFamily: fonts.display, fontSize: 24 },
  savedHandle: { fontFamily: fonts.regular, fontSize: 14 },
  points: { gap: 14, marginTop: 4 },
  point: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  pointIcon: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  pointText: { flex: 1, fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, paddingTop: 6 },
  footer: { marginTop: 'auto', alignItems: 'center', gap: 8, paddingTop: 12 },
  footerLink: { fontFamily: fonts.semibold, fontSize: 14 },
  footerText: { fontFamily: fonts.regular, fontSize: 12 },
});
