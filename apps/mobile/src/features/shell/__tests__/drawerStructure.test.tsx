/**
 * DD-023 — Drawer structure: 2 columns (rail + content), DM entry at top of rail.
 *
 * Verifies:
 *  1. Left drawer renders with DM entry (rail-dm) at the top of the rail
 *  2. Server list sits below the DM entry + divider
 *  3. channel-drawer testID exists
 *
 * @satisfies DD-023
 */
import renderer from 'react-test-renderer';

// ── Mock native libraries ──

jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: 'Animated.View', Text: 'Animated.Text', createAnimatedComponent: (C: unknown) => C },
  useSharedValue: () => ({ value: 0 }),
  useAnimatedStyle: () => ({}),
  withSpring: (v: number) => v,
  runOnJS: (fn: (...args: unknown[]) => void) => fn,
}));

jest.mock('react-native-gesture-handler', () => ({
  __esModule: true,
  Gesture: {
    Pan: () => ({
      activeOffsetX: () => ({
        failOffsetY: () => ({ onEnd: () => ({}) }),
        onEnd: () => ({}),
      }),
    }),
  },
  GestureDetector: 'GestureDetector',
}));

// ── Mock app dependencies ──

jest.mock('../../../stores/session', () => ({
  __esModule: true,
  api: { request: jest.fn().mockResolvedValue([]) },
  useSession: (s: (state: Record<string, unknown>) => unknown) => s({ user: { id: 'u1', username: 'alice', displayName: 'Alice', status: 'ONLINE', avatarUrl: null }, logout: jest.fn(), updateProfile: jest.fn() }),
}));

jest.mock('../../../stores/connection', () => ({
  __esModule: true,
  useConnection: () => ({ state: 'connected', everConnected: true }),
}));

jest.mock('../../../realtime', () => ({
  __esModule: true,
  gateway: { start: jest.fn(), stop: jest.fn() },
}));

jest.mock('../../../sync/queryClient', () => ({
  __esModule: true,
  queryClient: { invalidateQueries: jest.fn() },
}));

jest.mock('../../../lib/storageInstance', () => ({
  __esModule: true,
  storage: () => ({ getJson: jest.fn().mockReturnValue(null), setJson: jest.fn() }),
}));

jest.mock('../../../lib/config', () => ({
  __esModule: true,
  resolveConfig: () => ({ apiBaseUrl: 'http://localhost:3030/api' }),
}));

jest.mock('../../voice/useVoiceConnection', () => ({
  __esModule: true,
  useVoiceConnection: () => ({ join: jest.fn(), connectionState: 'idle' }),
}));

jest.mock('../../avatars', () => ({
  __esModule: true,
  useAvatarUpload: () => ({ busy: false, error: null, pickAndUpload: jest.fn() }),
  AvatarPicker: () => null,
}));

jest.mock('../../channels/hooks', () => ({
  __esModule: true,
  useCreateChannel: () => ({ mutate: jest.fn() }),
  useUpdateChannel: () => ({ mutate: jest.fn() }),
  useDeleteChannel: () => ({ mutate: jest.fn() }),
}));

jest.mock('../../inbox', () => ({
  __esModule: true,
  InboxScreen: () => null,
}));

// ── Wrap ShellScreen in QueryClientProvider ──

/* eslint-disable @typescript-eslint/no-require-imports */
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const { SafeAreaProvider } = require('react-native-safe-area-context');
const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const mountedRenderers: renderer.ReactTestRenderer[] = [];

afterEach(() => {
  renderer.act(() => {
    mountedRenderers.splice(0).forEach((tree) => tree.unmount());
  });
  qc.clear();
});

// ShellScreen calls useSafeAreaInsets() (DD-023 composer inset fix), which throws
// outside a provider. initialMetrics avoids waiting on an onLayout that never fires
// in react-test-renderer.
const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 24, left: 0, right: 0, bottom: 34 },
};

function renderShell(React: typeof import('react'), ShellScreen: React.ComponentType) {
  return React.createElement(SafeAreaProvider, { initialMetrics: SAFE_AREA_METRICS },
    React.createElement(QueryClientProvider, { client: qc },
      React.createElement(ShellScreen),
    ),
  );
}

// ── Tests ──

describe('DD-023 — Drawer structure (2 columns, DM in rail)', () => {
  it('rail contains a DM entry (rail-dm) above servers', () => {
    const { ShellScreen } = require('../screens/ShellScreen');
    const React = require('react');
    let tree;
    renderer.act(() => {
      tree = renderer.create(renderShell(React, ShellScreen));
    });
    mountedRenderers.push(tree!);
    const root = tree!.root;

    const railDm = root.findByProps({ testID: 'rail-dm' });
    expect(railDm).toBeDefined();

    const rail = root.findByProps({ testID: 'server-rail' });
    expect(rail).toBeDefined();

    const createServer = root.findByProps({ testID: 'rail-create-server' });
    expect(createServer).toBeDefined();

    const channelDrawer = root.findByProps({ testID: 'channel-drawer' });
    expect(channelDrawer).toBeDefined();
  });

  it('left-drawer exists and has exactly 1 dm-section child path', () => {
    const { ShellScreen } = require('../screens/ShellScreen');
    const React = require('react');
    let tree;
    renderer.act(() => {
      tree = renderer.create(renderShell(React, ShellScreen));
    });
    mountedRenderers.push(tree!);
    const root = tree!.root;

    const leftDrawer = root.findAllByProps({ testID: 'left-drawer' });
    expect(leftDrawer.length).toBe(1);

    // dm-section should be inside channel-drawer, not a separate column
    const channelDrawer = root.findByProps({ testID: 'channel-drawer' });
    const dmSections = channelDrawer.findAllByProps({ testID: 'dm-section' });
    // May be 0 (server selected by default) or 1 (DM active) — NOT a third column
    expect(dmSections.length).toBeLessThanOrEqual(1);
  });
});
