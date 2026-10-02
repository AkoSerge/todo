import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import React, { useMemo } from 'react';
import { Image, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Palette, useTheme } from './theme';

const logo = require('./assets/logo.png');

export default function LandingPage({ onGetStarted, onSignIn }: { onGetStarted: () => void; onSignIn: () => void }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style={colors.statusBar} />
      <ScrollView contentContainerStyle={styles.hero}>
        <View style={styles.logoFrame}>
          <Image source={logo} style={styles.heroLogo} accessibilityLabel="Todo logo" />
        </View>
        <Text style={styles.eyebrow}>YOUR DAY, ORGANISED</Text>
        <Text style={styles.h1}>Plan it.{'\n'}Get it done.</Text>
        <Text style={styles.lead}>
          Todo keeps your personal and work tasks in one calm place, with schedules, focus timers and reminders built in.
        </Text>
        <TouchableOpacity onPress={onGetStarted} style={styles.primaryButton}>
          <Text style={styles.primaryButtonText}>Get started free</Text>
          <Ionicons name="arrow-forward" size={16} color={colors.text} />
        </TouchableOpacity>
        <TouchableOpacity onPress={onSignIn} style={styles.linkButton}>
          <Text style={styles.linkText}>I already have an account</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles(c: Palette) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.bg },
    hero: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24, paddingVertical: 56 },
    // The logo artwork is black lines on white, so it sits on a white rounded tile in dark mode.
    logoFrame: { alignSelf: 'center', backgroundColor: '#FFFFFF', borderRadius: 28, padding: 6, marginBottom: 24 },
    heroLogo: { width: 112, height: 112 },
    eyebrow: { color: c.text, fontSize: 11, fontWeight: '800', letterSpacing: 1.6, marginBottom: 12, textAlign: 'center' },
    h1: { color: c.text, fontSize: 42, fontWeight: '800', letterSpacing: -1, lineHeight: 46, textAlign: 'center' },
    lead: { color: c.text, opacity: 0.7, fontSize: 16, lineHeight: 24, marginTop: 16, textAlign: 'center', maxWidth: 320 },
    primaryButton: { backgroundColor: c.bg, borderWidth: 1.5, borderColor: c.text, borderRadius: 16, minHeight: 56, alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 28 },
    primaryButtonText: { color: c.text, fontSize: 16, fontWeight: '800' },
    linkButton: { alignItems: 'center', paddingVertical: 16, marginTop: 4 },
    linkText: { color: c.text, fontSize: 14, fontWeight: '600', textDecorationLine: 'underline' },
  });
}
