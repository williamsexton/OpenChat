/**
 * VoiceTile component tests (FR-VOX-002).
 *
 * Validates: rendering, speaking ring, mute badge, initials, avatar
 * image vs placeholder, testID contracts.
 *
 * @satisfies FR-VOX-002
 */
import React from 'react';
import { Animated } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { VoiceTile } from '../VoiceTile';
import type { VoiceParticipantInfo } from '../VoiceStore';

const mockAnimationStart = jest.fn();
const mockAnimationStop = jest.fn();

beforeEach(() => {
  mockAnimationStart.mockClear();
  mockAnimationStop.mockClear();
  jest.spyOn(Animated, 'timing').mockReturnValue({
    start: mockAnimationStart,
    stop: mockAnimationStop,
    reset: jest.fn(),
  } as never);
});

const mountedRenderers: TestRenderer.ReactTestRenderer[] = [];

afterEach(() => {
  act(() => {
    mountedRenderers.splice(0).forEach((renderer) => renderer.unmount());
  });
  jest.restoreAllMocks();
});

function tile(overrides: Partial<VoiceParticipantInfo> = {}): VoiceParticipantInfo {
  return {
    id: 'user-1',
    username: 'alice',
    displayName: 'Alice',
    avatarUrl: null,
    isSpeaking: false,
    audioLevel: 0,
    isMuted: false,
    isLocal: false,
    ...overrides,
  };
}

function render(p: VoiceParticipantInfo): TestRenderer.ReactTestRenderer {
  let renderer: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<VoiceTile participant={p} />);
  });
  mountedRenderers.push(renderer!);
  return renderer!;
}

describe('VoiceTile (FR-VOX-002)', () => {
  describe('rendering', () => {
    it('renders username as display label', () => {
      const tree = render(tile({ username: 'alice', displayName: null }));
      const textNodes = tree.root.findAllByType('Text' as never);
      const nameNode = textNodes.find(
        (n) => typeof n.props.children === 'string' && n.props.children === 'alice',
      );
      expect(nameNode).toBeTruthy();
    });

    it('prefers displayName over username', () => {
      const tree = render(tile({ username: 'alice', displayName: 'Alice W.' }));
      const textNodes = tree.root.findAllByType('Text' as never);
      const nameNode = textNodes.find(
        (n) => typeof n.props.children === 'string' && n.props.children === 'Alice W.',
      );
      expect(nameNode).toBeTruthy();
    });

    it('shows (you) tag for local participant', () => {
      const tree = render(tile({ isLocal: true }));
      const textNodes = tree.root.findAllByType('Text' as never);
      const youNode = textNodes.find(
        (n) => typeof n.props.children === 'string' && n.props.children === '(you)',
      );
      expect(youNode).toBeTruthy();
    });

    it('does not show (you) tag for remote participant', () => {
      const tree = render(tile({ isLocal: false }));
      const textNodes = tree.root.findAllByType('Text' as never);
      const youNode = textNodes.find(
        (n) => typeof n.props.children === 'string' && n.props.children === '(you)',
      );
      expect(youNode).toBeFalsy();
    });
  });

  describe('speaking ring', () => {
    it('has speaking ring testID when isSpeaking is true', () => {
      const tree = render(tile({ isSpeaking: true, audioLevel: 0.8 }));
      const ring = tree.root.findByProps({ testID: 'voice-tile-speaking' });
      expect(ring).toBeTruthy();
    });

    it('does not have speaking ring testID when isSpeaking is false', () => {
      const tree = render(tile({ isSpeaking: false, audioLevel: 0 }));
      const rings = tree.root.findAll(
        (node) => node.props?.testID === 'voice-tile-speaking',
      );
      expect(rings).toHaveLength(0);
    });
  });

  describe('mute badge', () => {
    it('shows mute badge when isMuted is true', () => {
      const tree = render(tile({ isMuted: true }));
      const badge = tree.root.findByProps({ testID: "voice-tile-muted" });
      expect(badge).toBeTruthy();
    });

    it('does not show mute badge when isMuted is false', () => {
      const tree = render(tile({ isMuted: false }));
      const badges = tree.root.findAll(
        (node) => node.props?.testID === 'voice-tile-muted',
      );
      expect(badges).toHaveLength(0);
    });
  });

  describe('testID contract', () => {
    it('container has voice-tile-<id> testID', () => {
      const tree = render(tile({ id: 'user-42' }));
      const container = tree.root.findByProps({ testID: 'voice-tile-user-42' });
      expect(container).toBeTruthy();
    });
  });

  it('stops the speaking-ring animation when unmounted', () => {
    const tree = render(tile({ isSpeaking: true, audioLevel: 0.8 }));
    act(() => tree.unmount());
    expect(mockAnimationStop).toHaveBeenCalledTimes(1);
  });

  describe('avatar', () => {
    it('renders initials placeholder when no avatarUrl', () => {
      const tree = render(tile({ avatarUrl: null, displayName: 'Alice W.' }));
      const textNodes = tree.root.findAllByType('Text' as never);
      const initialsNode = textNodes.find(
        (n) => typeof n.props.children === 'string' && n.props.children === 'AW',
      );
      expect(initialsNode).toBeTruthy();
    });

    it('renders initials from username when no displayName', () => {
      const tree = render(tile({ avatarUrl: null, displayName: null, username: 'bob' }));
      const textNodes = tree.root.findAllByType('Text' as never);
      const initialsNode = textNodes.find(
        (n) => typeof n.props.children === 'string' && n.props.children === 'B',
      );
      expect(initialsNode).toBeTruthy();
    });

    it('renders Image when avatarUrl is set', () => {
      const tree = render(tile({ avatarUrl: 'https://example.com/avatar.png' }));
      const images = tree.root.findAllByType('Image' as never);
      expect(images.length).toBeGreaterThan(0);
    });
  });
});
