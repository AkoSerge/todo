import { Ionicons } from '@expo/vector-icons';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from './theme';

type IconName = React.ComponentProps<typeof Ionicons>['name'];
type Toast = { id: number; message: string; icon: IconName };
type ShowToast = (message: string, icon?: IconName) => void;

const ToastContext = createContext<ShowToast>(() => undefined);

// Short confirmation shown at the bottom of the screen after the user changes something.
export function ToastProvider({ children }: React.PropsWithChildren) {
  const [toast, setToast] = useState<Toast | null>(null);
  const showToast = useCallback<ShowToast>((message, icon = 'checkmark-circle') => {
    setToast({ id: Date.now(), message, icon });
  }, []);

  return (
    <ToastContext.Provider value={showToast}>
      {children}
      {toast && <ToastBanner key={toast.id} toast={toast} onHidden={() => setToast(null)} />}
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

function ToastBanner({ toast, onHidden }: { toast: Toast; onHidden: () => void }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const progress = useRef(new Animated.Value(0)).current;
  const styles = useMemo(() => StyleSheet.create({
    banner: {
      position: 'absolute',
      left: 20,
      right: 20,
      bottom: insets.bottom + 24,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      backgroundColor: colors.text,
      borderRadius: 14,
      paddingHorizontal: 16,
      paddingVertical: 14,
      shadowColor: '#000000',
      shadowOpacity: 0.2,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 6 },
      elevation: 8,
    },
    text: { flex: 1, color: colors.bg, fontSize: 14, fontWeight: '700' },
  }), [colors, insets.bottom]);

  useEffect(() => {
    const animation = Animated.sequence([
      Animated.timing(progress, { toValue: 1, duration: 180, useNativeDriver: true }),
      Animated.delay(2200),
      Animated.timing(progress, { toValue: 0, duration: 220, useNativeDriver: true }),
    ]);
    animation.start(({ finished }) => { if (finished) onHidden(); });
    return () => animation.stop();
  }, []);

  return (
    <Animated.View
      pointerEvents="none"
      accessibilityLiveRegion="polite"
      style={[styles.banner, { opacity: progress, transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [20, 0] }) }] }]}
    >
      <Ionicons name={toast.icon} size={18} color={colors.bg} />
      <Text style={styles.text}>{toast.message}</Text>
    </Animated.View>
  );
}
