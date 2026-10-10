import '@/lib/polyfills';
// Per-weight imports: the package index would bundle every weight as an asset.
import { Fraunces_600SemiBold } from '@expo-google-fonts/fraunces/600SemiBold';
import { Fraunces_700Bold } from '@expo-google-fonts/fraunces/700Bold';
import { Inter_400Regular } from '@expo-google-fonts/inter/400Regular';
import { Inter_500Medium } from '@expo-google-fonts/inter/500Medium';
import { Inter_600SemiBold } from '@expo-google-fonts/inter/600SemiBold';
import { Inter_700Bold } from '@expo-google-fonts/inter/700Bold';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setBaseUrl } from '@workspace/api-client-react';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect } from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import colors from '@/constants/colors';
import { WalletProvider, useWallet } from '@/contexts/WalletContext';
import { useColors } from '@/hooks/useColors';

SplashScreen.preventAutoHideAsync();

setBaseUrl(`https://${process.env.EXPO_PUBLIC_DOMAIN}`);

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000 } },
});

function RootLayoutNav({ fontsReady }: { fontsReady: boolean }) {
  const { status } = useWallet();
  const c = useColors();

  useEffect(() => {
    if (fontsReady && status !== 'loading') SplashScreen.hideAsync();
  }, [fontsReady, status]);

  const signedOut = status === 'loading' || status === 'locked' || status === 'checking' || status === 'error';

  return (
    <>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.background } }}>
        <Stack.Protected guard={status === 'ready'}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="send" options={{ presentation: 'modal' }} />
          <Stack.Screen name="add-money" options={{ presentation: 'modal' }} />
          <Stack.Screen name="cash-out" options={{ presentation: 'modal' }} />
          <Stack.Screen name="send-upi" options={{ presentation: 'modal' }} />
          <Stack.Screen name="receipt/[id]" options={{ presentation: 'modal' }} />
          <Stack.Screen name="country" options={{ presentation: 'modal' }} />
        </Stack.Protected>
        <Stack.Protected guard={status === 'needsProfile'}>
          <Stack.Screen name="profile" />
        </Stack.Protected>
        <Stack.Protected guard={signedOut}>
          <Stack.Screen name="welcome" />
        </Stack.Protected>
      </Stack>
    </>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Fraunces_600SemiBold,
    Fraunces_700Bold,
  });

  // Paint the brand background while fonts load (web has no native splash).
  if (!fontsLoaded && !fontError) return <View style={{ flex: 1, backgroundColor: colors.light.background }} />;

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <GestureHandlerRootView style={{ flex: 1 }}>
            <KeyboardProvider>
              <WalletProvider>
                <RootLayoutNav fontsReady />
              </WalletProvider>
            </KeyboardProvider>
          </GestureHandlerRootView>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
