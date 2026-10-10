import { getCheckHandleQueryKey, useCheckHandle } from '@workspace/api-client-react';
import { DISPLAY_NAME_MAX, handleProblem, normalizeDisplayName, normalizeHandle } from '@workspace/gullak-core';
import React, { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { fonts } from '@/constants/typography';
import { useColors } from '@/hooks/useColors';
import { useDebounced } from '@/hooks/useDebounced';
import { apiErrorMessage } from '@/lib/errors';

export function useProfileForm(initial?: { handle?: string; displayName?: string }) {
  const [name, setName] = useState(initial?.displayName ?? '');
  const [handleInput, setHandleInput] = useState(initial?.handle ?? '');
  const handle = normalizeHandle(handleInput);
  const displayName = normalizeDisplayName(name);
  const problem = handle ? handleProblem(handle) : null;
  const debounced = useDebounced(handle, 350);
  const debouncedOk = debounced.length > 0 && !handleProblem(debounced);

  const check = useCheckHandle(debounced, {
    query: { queryKey: getCheckHandleQueryKey(debounced), enabled: debouncedOk, staleTime: 15_000, retry: false },
  });

  const current = check.data && check.data.handle === handle ? check.data : null;
  const checking = !!handle && !problem && (debounced !== handle || check.isFetching);
  const available = !problem && !checking && !!current?.available;

  let handleStatus: { text: string; tone: 'muted' | 'ok' | 'bad' } | null = null;
  if (problem) handleStatus = { text: problem, tone: 'bad' };
  else if (checking) handleStatus = { text: 'Checking…', tone: 'muted' };
  else if (current) handleStatus = current.available ? { text: 'Available', tone: 'ok' } : { text: current.reason ?? 'Taken', tone: 'bad' };
  else if (check.error) handleStatus = { text: apiErrorMessage(check.error), tone: 'bad' };

  const nameOk = displayName.length > 0 && displayName.length <= DISPLAY_NAME_MAX;
  return { name, setName, handleInput, setHandleInput, handle, displayName, handleStatus, valid: nameOk && available };
}

export function ProfileFields({ form, autoFocus }: { form: ReturnType<typeof useProfileForm>; autoFocus?: boolean }) {
  const c = useColors();
  const inputStyle = [styles.input, { backgroundColor: c.card, borderColor: c.input, color: c.foreground, borderRadius: c.radius - 4 }];
  const toneColor = form.handleStatus?.tone === 'ok' ? c.success : form.handleStatus?.tone === 'bad' ? c.destructive : c.mutedForeground;
  return (
    <View style={{ gap: 16 }}>
      <View style={{ gap: 6 }}>
        <Text style={[styles.label, { color: c.foreground }]}>Your name</Text>
        <TextInput
          value={form.name}
          onChangeText={form.setName}
          placeholder="Asha Kumar"
          placeholderTextColor={c.mutedForeground}
          autoComplete="name"
          textContentType="name"
          maxLength={DISPLAY_NAME_MAX}
          autoFocus={autoFocus}
          style={inputStyle}
          accessibilityLabel="Your name"
          testID="input-name"
        />
      </View>
      <View style={{ gap: 6 }}>
        <Text style={[styles.label, { color: c.foreground }]}>Handle</Text>
        <View style={[styles.handleWrap, { backgroundColor: c.card, borderColor: c.input, borderRadius: c.radius - 4 }]}>
          <Text style={[styles.at, { color: c.mutedForeground }]}>@</Text>
          <TextInput
            value={form.handleInput}
            onChangeText={(t) => form.setHandleInput(t.replace(/^@/, ''))}
            placeholder="asha"
            placeholderTextColor={c.mutedForeground}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username"
            maxLength={20}
            style={[styles.handleInput, { color: c.foreground }]}
            accessibilityLabel="Handle"
            testID="input-handle"
          />
        </View>
        <Text style={[styles.hint, { color: toneColor }]}>
          {form.handleStatus?.text ?? 'Family will find you by this. Letters, numbers and _.'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  label: { fontFamily: fonts.semibold, fontSize: 14 },
  input: { borderWidth: 1, paddingHorizontal: 14, minHeight: 50, fontFamily: fonts.regular, fontSize: 16 },
  handleWrap: { borderWidth: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, minHeight: 50 },
  at: { fontFamily: fonts.medium, fontSize: 16, marginRight: 2 },
  handleInput: { flex: 1, fontFamily: fonts.regular, fontSize: 16, minHeight: 48 },
  hint: { fontFamily: fonts.regular, fontSize: 13 },
});
