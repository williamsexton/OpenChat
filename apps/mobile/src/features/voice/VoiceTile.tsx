/**
 * VoiceTile — single participant tile for FR-VOX-002.
 *
 * Renders an avatar (image or initials), username, a speaking ring
 * (green ring around the avatar when the participant is speaking,
 * intensity driven by audioLevel), and a mute badge.
 *
 * @satisfies FR-VOX-002
 */
import React, { useEffect, useRef } from 'react';
import { Animated, Image, StyleSheet, Text, View } from 'react-native';
import type { VoiceParticipantInfo } from './VoiceStore';
import { palette, spacing, typography } from '../../ui/tokens';
import { strings } from '../../ui/strings';

interface VoiceTileProps {
  participant: VoiceParticipantInfo;
}

/** Derive 1–2 uppercase initials from a display name. */
function initials(p: VoiceParticipantInfo): string {
  const name = p.displayName || p.username || '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '');
  }
  return (parts[0]?.[0] ?? '?').toUpperCase();
}

const RING_COLOR = '#23a55a'; // Discord speaking green
const RING_SIZE = 68;
const AVATAR_SIZE = 56;
const MUTE_BADGE_SIZE = 22;

export function VoiceTile({ participant }: VoiceTileProps): React.JSX.Element {
  const ringAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const isAudiblySpeaking = participant.isSpeaking && participant.audioLevel > 0;
    const animation = Animated.timing(ringAnim, {
      toValue: isAudiblySpeaking ? participant.audioLevel : 0,
      duration: isAudiblySpeaking ? 100 : 300,
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [participant.isSpeaking, participant.audioLevel, ringAnim]);

  const ringStyle = {
    opacity: ringAnim.interpolate({
      inputRange: [0, 0.2, 1],
      outputRange: [0, 0, 1],
    }),
    transform: [
      {
        scale: ringAnim.interpolate({
          inputRange: [0, 0.5, 1],
          outputRange: [1, 1.05, 1.12],
        }),
      },
    ],
  };

  const displayLabel = participant.displayName || participant.username || '?';

  return (
    <View style={styles.container} testID={`voice-tile-${participant.id}`}>
      {/* Speaking ring */}
      <Animated.View
        style={[
          styles.ring,
          ringStyle,
          participant.isSpeaking && styles.ringActive,
        ]}
        testID={participant.isSpeaking ? 'voice-tile-speaking' : undefined}
      />

      {/* Avatar */}
      <View style={styles.avatarContainer}>
        {participant.avatarUrl ? (
          <Image
            source={{ uri: participant.avatarUrl }}
            style={styles.avatar}
            accessibilityLabel={`Avatar for ${displayLabel}`}
          />
        ) : (
          <View style={styles.avatarPlaceholder}>
            <Text style={styles.avatarInitials}>{initials(participant)}</Text>
          </View>
        )}

        {/* Mute badge */}
        {participant.isMuted && (
          <View
            style={styles.muteBadge}
            testID="voice-tile-muted"
            accessibilityLabel="Muted"
          >
            <Text style={styles.muteBadgeText}>{strings.voice.tileMutedSymbol}</Text>
          </View>
        )}
      </View>

      {/* Username */}
      <Text style={styles.name} numberOfLines={1}>
        {displayLabel}
      </Text>
      {participant.isLocal && (
        <Text style={styles.localTag}>{strings.voice.tileLocalTag}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    width: 80,
    marginHorizontal: spacing.sm,
    marginVertical: spacing.sm,
  },
  ring: {
    position: 'absolute',
    top: 0,
    width: RING_SIZE,
    height: RING_SIZE,
    borderRadius: RING_SIZE / 2,
    borderWidth: 3,
    borderColor: RING_COLOR,
  },
  ringActive: {
    // Additional style when speaking (base opacity from animated value)
  },
  avatarContainer: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
  },
  avatar: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    backgroundColor: palette.bgElevated,
  },
  avatarPlaceholder: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    backgroundColor: palette.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitials: {
    color: palette.text,
    fontSize: typography.body.fontSize,
    fontWeight: '600',
  },
  muteBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: MUTE_BADGE_SIZE,
    height: MUTE_BADGE_SIZE,
    borderRadius: MUTE_BADGE_SIZE / 2,
    backgroundColor: palette.danger,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: palette.bg,
  },
  muteBadgeText: {
    color: palette.text,
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 14,
  },
  name: {
    color: palette.text,
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    marginTop: spacing.xs,
    textAlign: 'center',
    maxWidth: 80,
  },
  localTag: {
    color: palette.textMuted,
    fontSize: 11,
    textAlign: 'center',
  },
});
