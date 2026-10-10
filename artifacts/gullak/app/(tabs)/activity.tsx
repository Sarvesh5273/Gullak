import Feather from '@expo/vector-icons/Feather';
import { getListMyActivityQueryKey, useListMyActivity } from '@workspace/api-client-react';
import React from 'react';
import { FlatList, Platform, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ActivityRow } from '@/components/ActivityRow';
import { useTopInset } from '@/components/ui';
import { fonts } from '@/constants/typography';
import { useColors } from '@/hooks/useColors';
import { apiErrorMessage } from '@/lib/errors';

const PARAMS = { limit: 100 } as const;

export default function ActivityScreen() {
  const c = useColors();
  const top = useTopInset();
  const insets = useSafeAreaInsets();
  const activity = useListMyActivity(PARAMS, {
    query: { queryKey: getListMyActivityQueryKey(PARAMS), refetchInterval: 10_000 },
  });
  const items = activity.data ?? [];
  const bottomPad = Platform.OS === 'web' ? 84 + 24 : insets.bottom + 90;

  return (
    <FlatList
      style={{ flex: 1, backgroundColor: c.background }}
      contentContainerStyle={[styles.container, { paddingTop: top + 12, paddingBottom: bottomPad }]}
      data={items}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => <ActivityRow item={item} />}
      ItemSeparatorComponent={() => <View style={[styles.separator, { backgroundColor: c.border }]} />}
      ListHeaderComponent={<Text style={[styles.title, { color: c.foreground }]}>Activity</Text>}
      ListEmptyComponent={
        <View style={styles.empty}>
          <Feather name="clock" size={24} color={c.mutedForeground} />
          <Text style={[styles.emptyText, { color: c.mutedForeground }]}>
            {activity.isError ? apiErrorMessage(activity.error) : activity.isPending ? 'Loading…' : 'Money you send, receive and add shows up here.'}
          </Text>
        </View>
      }
      scrollEnabled={items.length > 0}
      refreshControl={
        <RefreshControl refreshing={activity.isRefetching} onRefresh={() => void activity.refetch()} tintColor={c.primary} />
      }
    />
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 20, maxWidth: 640, width: '100%', alignSelf: 'center', flexGrow: 1 },
  title: { fontFamily: fonts.display, fontSize: 30, marginBottom: 12 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 56 },
  empty: { alignItems: 'center', gap: 10, paddingVertical: 48 },
  emptyText: { fontFamily: fonts.regular, fontSize: 15, textAlign: 'center', maxWidth: 280, lineHeight: 21 },
});
