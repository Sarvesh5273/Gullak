import { useQueryClient } from '@tanstack/react-query';
import { getGetMeQueryKey, useRegisterMember } from '@workspace/api-client-react';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { ProfileFields, useProfileForm } from '@/components/ProfileForm';
import { Button, Card, Notice, useBottomInset, useTopInset } from '@/components/ui';
import { fonts } from '@/constants/typography';
import { useWallet } from '@/contexts/WalletContext';
import { useColors } from '@/hooks/useColors';
import { guessCountry } from '@/lib/country';
import { apiErrorMessage } from '@/lib/errors';

/** Shown when an unlocked account has no Gullak profile yet. */
export default function ProfileScreen() {
  const c = useColors();
  const top = useTopInset();
  const bottom = useBottomInset();
  const queryClient = useQueryClient();
  const { pendingProfile, lock, address } = useWallet();
  const form = useProfileForm(pendingProfile ?? undefined);
  const register = useRegisterMember({
    mutation: { onSuccess: (member) => queryClient.setQueryData(getGetMeQueryKey(), member) },
  });

  const firstError = register.error ?? pendingProfile?.error ?? null;

  return (
    <KeyboardAwareScrollViewCompat
      style={{ flex: 1, backgroundColor: c.background }}
      contentContainerStyle={[styles.container, { paddingTop: top + 32, paddingBottom: bottom + 24 }]}
      bottomOffset={24}
    >
      <View style={{ gap: 6 }}>
        <Text style={[styles.title, { color: c.foreground }]}>One last step</Text>
        <Text style={[styles.body, { color: c.mutedForeground }]}>
          Your passkey opened account {address ? `${address.slice(0, 6)}…${address.slice(-4)}` : ''}. Pick the name and handle
          family will use to send you money.
        </Text>
      </View>

      {firstError ? <Notice tone="error">{apiErrorMessage(firstError)}</Notice> : null}

      <Card style={{ gap: 20 }}>
        <ProfileFields form={form} autoFocus={!pendingProfile} />
        <Button
          title="Save and continue"
          onPress={() =>
            register.mutate({ data: { handle: form.handle, displayName: form.displayName, country: guessCountry() } })
          }
          loading={register.isPending}
          disabled={!form.valid}
          testID="button-save-profile"
        />
      </Card>

      <Button title="Lock" variant="ghost" onPress={() => lock()} />
    </KeyboardAwareScrollViewCompat>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 24, gap: 20, maxWidth: 520, width: '100%', alignSelf: 'center' },
  title: { fontFamily: fonts.display, fontSize: 30 },
  body: { fontFamily: fonts.regular, fontSize: 15, lineHeight: 22 },
});
