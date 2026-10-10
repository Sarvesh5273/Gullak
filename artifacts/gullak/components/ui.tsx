import Feather from '@expo/vector-icons/Feather';
import React from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { fonts } from '@/constants/typography';
import { useColors } from '@/hooks/useColors';

/** Top padding for screens without a native header (web gets a fixed status-bar inset). */
export function useTopInset(): number {
  const insets = useSafeAreaInsets();
  return Platform.OS === 'web' ? 67 : insets.top;
}

export function useBottomInset(): number {
  const insets = useSafeAreaInsets();
  return Platform.OS === 'web' ? 34 : insets.bottom;
}

type ButtonProps = {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  icon?: React.ComponentProps<typeof Feather>['name'];
  loading?: boolean;
  disabled?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
};

export function Button({ title, onPress, variant = 'primary', icon, loading, disabled, testID, style }: ButtonProps) {
  const c = useColors();
  const palette = {
    primary: { bg: c.primary, fg: c.primaryForeground, border: c.primary },
    secondary: { bg: c.secondary, fg: c.secondaryForeground, border: c.secondary },
    ghost: { bg: 'transparent', fg: c.primary, border: 'transparent' },
    danger: { bg: 'transparent', fg: c.destructive, border: c.border },
  }[variant];
  const inactive = disabled || loading;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
      onPress={onPress}
      disabled={inactive}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: palette.bg,
          borderColor: palette.border,
          borderRadius: c.radius,
          opacity: inactive ? 0.5 : pressed ? 0.85 : 1,
          transform: [{ scale: pressed && !inactive ? 0.98 : 1 }],
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={palette.fg} />
      ) : (
        <>
          {icon ? <Feather name={icon} size={18} color={palette.fg} /> : null}
          <Text style={[styles.buttonText, { color: palette.fg }]}>{title}</Text>
        </>
      )}
    </Pressable>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const c = useColors();
  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border, borderRadius: c.radius }, style]}>
      {children}
    </View>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}

export function Avatar({ name, size = 44, icon }: { name: string; size?: number; icon?: React.ComponentProps<typeof Feather>['name'] }) {
  const c = useColors();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: icon ? c.successSoft : c.warningSoft,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {icon ? (
        <Feather name={icon} size={size * 0.45} color={c.success} />
      ) : (
        <Text style={{ fontFamily: fonts.semibold, fontSize: size * 0.36, color: c.clayDeep }}>{initials(name)}</Text>
      )}
    </View>
  );
}

type NoticeTone = 'info' | 'warning' | 'error' | 'success';

export function Notice({
  tone = 'info',
  title,
  children,
  action,
}: {
  tone?: NoticeTone;
  title?: string;
  children?: React.ReactNode;
  action?: { label: string; onPress: () => void };
}) {
  const c = useColors();
  const tones = {
    info: { bg: c.secondary, fg: c.foreground, icon: 'info' as const },
    warning: { bg: c.warningSoft, fg: c.foreground, icon: 'alert-triangle' as const },
    error: { bg: '#F8E1DE', fg: c.destructive, icon: 'alert-circle' as const },
    success: { bg: c.successSoft, fg: c.success, icon: 'check-circle' as const },
  }[tone];
  return (
    <View style={[styles.notice, { backgroundColor: tones.bg, borderRadius: c.radius - 4 }]} accessibilityRole="alert">
      <Feather name={tones.icon} size={18} color={tones.fg} style={{ marginTop: 1 }} />
      <View style={{ flex: 1, gap: 4 }}>
        {title ? <Text style={[styles.noticeTitle, { color: tones.fg }]}>{title}</Text> : null}
        {typeof children === 'string' ? (
          <Text style={[styles.noticeBody, { color: c.foreground }]}>{children}</Text>
        ) : (
          children
        )}
        {action ? (
          <Pressable onPress={action.onPress} accessibilityRole="button" hitSlop={8}>
            <Text style={[styles.noticeAction, { color: c.primary }]}>{action.label}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

export function SectionTitle({ children, action }: { children: string; action?: { label: string; onPress: () => void } }) {
  const c = useColors();
  return (
    <View style={styles.sectionRow}>
      <Text style={[styles.sectionTitle, { color: c.mutedForeground }]}>{children}</Text>
      {action ? (
        <Pressable onPress={action.onPress} hitSlop={8} accessibilityRole="button">
          <Text style={[styles.sectionAction, { color: c.primary }]}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function Pill({
  label,
  tone = 'neutral',
  style,
}: {
  label: string;
  tone?: 'neutral' | 'success' | 'warning' | 'error';
  style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();
  const t = {
    neutral: { bg: c.secondary, fg: c.mutedForeground },
    success: { bg: c.successSoft, fg: c.success },
    warning: { bg: c.warningSoft, fg: c.clayDeep },
    error: { bg: '#F8E1DE', fg: c.destructive },
  }[tone];
  return (
    <View style={[styles.pill, { backgroundColor: t.bg }, style]}>
      <Text style={[styles.pillText, { color: t.fg }]}>{label}</Text>
    </View>
  );
}

/** Header for modal screens: title plus a close control. */
export function ModalHeader({ title, onClose }: { title: string; onClose: () => void }) {
  const c = useColors();
  const top = Platform.OS === 'web' ? 24 : 16;
  return (
    <View style={[styles.modalHeader, { paddingTop: top }]}>
      <Text style={[styles.modalTitle, { color: c.foreground }]}>{title}</Text>
      <Pressable
        onPress={onClose}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel="Close"
        style={[styles.closeButton, { backgroundColor: c.secondary }]}
        testID="modal-close"
      >
        <Feather name="x" size={20} color={c.foreground} />
      </Pressable>
    </View>
  );
}

export function DetailRow({
  label,
  value,
  onPress,
  navigates,
  testID,
}: {
  label: string;
  value: string;
  onPress?: () => void;
  /** Opens a screen in the app (chevron) rather than an external page. */
  navigates?: boolean;
  testID?: string;
}) {
  const c = useColors();
  const content = (
    <View style={[styles.detailRow, { borderBottomColor: c.border }]}>
      <Text style={[styles.detailLabel, { color: c.mutedForeground }]}>{label}</Text>
      <View style={styles.detailValueWrap}>
        <Text style={[styles.detailValue, { color: onPress ? c.primary : c.foreground }]} numberOfLines={2}>
          {value}
        </Text>
        {onPress ? <Feather name={navigates ? 'chevron-right' : 'external-link'} size={navigates ? 18 : 14} color={c.primary} /> : null}
      </View>
    </View>
  );
  return onPress ? (
    <Pressable
      onPress={onPress}
      accessibilityRole={navigates ? 'button' : 'link'}
      accessibilityLabel={`${label}: ${value}`}
      testID={testID}
    >
      {content}
    </Pressable>
  ) : (
    content
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 54,
    paddingHorizontal: 20,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  buttonText: { fontFamily: fonts.semibold, fontSize: 16 },
  card: { borderWidth: 1, padding: 16 },
  notice: { flexDirection: 'row', gap: 10, padding: 14 },
  noticeTitle: { fontFamily: fonts.semibold, fontSize: 14 },
  noticeBody: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20 },
  noticeAction: { fontFamily: fonts.semibold, fontSize: 14, marginTop: 4 },
  sectionRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  sectionTitle: { fontFamily: fonts.semibold, fontSize: 13, letterSpacing: 0.6, textTransform: 'uppercase' },
  sectionAction: { fontFamily: fonts.semibold, fontSize: 14 },
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, alignSelf: 'flex-start' },
  pillText: { fontFamily: fonts.semibold, fontSize: 12 },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  modalTitle: { fontFamily: fonts.display, fontSize: 26 },
  closeButton: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 16,
  },
  detailLabel: { fontFamily: fonts.regular, fontSize: 14 },
  detailValueWrap: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  detailValue: { fontFamily: fonts.medium, fontSize: 14, textAlign: 'right', flexShrink: 1 },
});
