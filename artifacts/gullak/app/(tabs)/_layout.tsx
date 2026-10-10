import Feather from '@expo/vector-icons/Feather';
import { BlurView } from 'expo-blur';
import { isLiquidGlassAvailable } from 'expo-glass-effect';
import { Tabs } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { SymbolView } from 'expo-symbols';
import React from 'react';
import { Platform, StyleSheet, View, type ColorValue } from 'react-native';
import { fonts } from '@/constants/typography';
import { useColors } from '@/hooks/useColors';

// iOS 26: native tabs with liquid glass (system appearance, not brand tokens).
function NativeTabLayout() {
  return (
    <NativeTabs>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Icon sf={{ default: 'house', selected: 'house.fill' }} />
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="activity">
        <NativeTabs.Trigger.Icon sf={{ default: 'clock', selected: 'clock.fill' }} />
        <NativeTabs.Trigger.Label>Activity</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="account">
        <NativeTabs.Trigger.Icon sf={{ default: 'person.crop.circle', selected: 'person.crop.circle.fill' }} />
        <NativeTabs.Trigger.Label>Account</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

type TabIcon = { sf: React.ComponentProps<typeof SymbolView>['name']; feather: React.ComponentProps<typeof Feather>['name'] };

function ClassicTabLayout() {
  const c = useColors();
  const isIOS = Platform.OS === 'ios';
  const isWeb = Platform.OS === 'web';

  const icon =
    ({ sf, feather }: TabIcon) =>
    ({ color }: { color: ColorValue }) =>
      isIOS ? <SymbolView name={sf} tintColor={color} size={24} /> : <Feather name={feather} size={22} color={color} />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: c.primary,
        tabBarInactiveTintColor: c.mutedForeground,
        tabBarLabelStyle: { fontFamily: fonts.medium, fontSize: 12 },
        tabBarStyle: {
          position: 'absolute',
          backgroundColor: isIOS ? 'transparent' : c.background,
          borderTopWidth: isWeb ? 1 : 0,
          borderTopColor: c.border,
          elevation: 0,
          ...(isWeb ? { height: 84 } : {}),
        },
        tabBarBackground: () =>
          isIOS ? (
            <BlurView intensity={100} tint="light" style={StyleSheet.absoluteFill} />
          ) : isWeb ? (
            <View style={[StyleSheet.absoluteFill, { backgroundColor: c.background }]} />
          ) : null,
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home', tabBarIcon: icon({ sf: 'house', feather: 'home' }) }} />
      <Tabs.Screen name="activity" options={{ title: 'Activity', tabBarIcon: icon({ sf: 'clock', feather: 'clock' }) }} />
      <Tabs.Screen
        name="account"
        options={{ title: 'Account', tabBarIcon: icon({ sf: 'person.crop.circle', feather: 'user' }) }}
      />
    </Tabs>
  );
}

export default function TabLayout() {
  if (isLiquidGlassAvailable()) return <NativeTabLayout />;
  return <ClassicTabLayout />;
}
