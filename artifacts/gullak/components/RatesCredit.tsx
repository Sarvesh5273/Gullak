import { FX_SOURCE } from '@workspace/gullak-core';
import * as WebBrowser from 'expo-web-browser';
import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { fonts } from '@/constants/typography';
import { useColors } from '@/hooks/useColors';

/** The free rate source requires this credit wherever its rates are shown. */
export function RatesCredit({ asOf }: { asOf?: string | null }) {
  const c = useColors();
  const day = asOf ? new Date(asOf).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : null;
  return (
    <Pressable
      onPress={() => void WebBrowser.openBrowserAsync(FX_SOURCE.url)}
      accessibilityRole="link"
      hitSlop={6}
      style={styles.wrap}
    >
      <Text style={[styles.text, { color: c.mutedForeground }]}>
        {`Local amounts are approximate${day ? `, rates of ${day}` : ''}. `}
        <Text style={{ color: c.primary }}>Rates By Exchange Rate API</Text>
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { alignSelf: 'center' },
  text: { fontFamily: fonts.regular, fontSize: 12, textAlign: 'center', lineHeight: 17 },
});
