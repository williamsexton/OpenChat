import type { User, Server, Channel, Message, WsTicket, Role, ServerMemberInfo, Notifications, WatchPartyState, LibraryItem, Gif, ServerSound, ApiToken, CreatedApiToken } from './types';
import { apiBase, getToken, getRefreshToken, setTokens, clearTokens } from './serverConfig';

// Native-client token refresh (OAuth refresh_token grant). Single-flight so a burst
// of 401s triggers exactly one rotation. Web (cookie) has no refresh token → no-op.
let refreshInFlight: Promise<boolean> | null = null;

async function doRefresh(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;
  try {
    const res = await fetch(`${apiBase()}/auth/oauth/token`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grantType: 'refresh_token', refreshToken }),
    });
    if (!res.ok) { clearTokens(); return false; }  // refresh revoked/expired → force re-login
    const data = await res.json();
    setTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken, expiresIn: data.expiresIn });
    return true;
  } catch { return false; }
}

function tryRefresh(): Promise<boolean> {
  if (!getRefreshToken()) return Promise.resolve(false);
  if (!refreshInFlight) refreshInFlight = doRefresh().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

async function request<T>(url: string, options?: RequestInit, _retried = false): Promise<T> {
  const token = getToken();
  const res = await fetch(`${apiBase()}${url}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
    method: 'GET',
    ...options,
  });

  // Native client with an expired access token: rotate once and retry.
  if (res.status === 401 && !_retried && getRefreshToken()) {
    if (await tryRefresh()) return request<T>(url, options, true);
  }

  if (!res.ok) {
    const errorText = await res.text();
    const err = new Error(`API Error ${res.status}: ${errorText}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }

  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

/** Native sign-in: exchange a PKCE authorization code for a token family. */
export async function exchangeAuthCode(code: string, codeVerifier: string, redirectUri: string) {
  const res = await fetch(`${apiBase()}/auth/oauth/token`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grantType: 'authorization_code', code, codeVerifier, redirectUri }),
  });
  if (!res.ok) throw new Error(`token exchange failed (${res.status})`);
  const data = await res.json();
  setTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken, expiresIn: data.expiresIn });
  return data;
}

/** Revoke the refresh-token family server-side (best effort) and clear local tokens. */
export async function logout() {
  const refreshToken = getRefreshToken();
  try {
    await fetch(`${apiBase()}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(refreshToken ? { refreshToken } : {}),
    });
  } catch { /* ignore — still clear locally */ }
  clearTokens();
}

export const getMe = () => request<User>('/auth/me');
export const updateProfile = (data: { username?: string; displayName?: string; avatarUrl?: string; status?: string }) =>
  request<User>('/auth/me', { method: 'PATCH', body: JSON.stringify(data) });

export const updateServerLayout = (layout: unknown) =>
  request<User>('/auth/server-layout', { method: 'PUT', body: JSON.stringify({ layout }) });

export const getNotifications = () => request<Notifications>('/notifications');
export const acceptServerInvite = (id: string) =>
  request<Server>(`/server-invitations/${id}/accept`, { method: 'POST' });
export const declineServerInvite = (id: string) =>
  request<{ success: true }>(`/server-invitations/${id}/decline`, { method: 'POST' });
export const listServers = () => request<Server[]>('/servers');
export const createServer = (name: string) =>
  request<Server>('/servers', { method: 'POST', body: JSON.stringify({ name }) });
export const getServer = (id: string) => request<Server>(`/servers/${id}`);
export const updateServer = (id: string, data: { name?: string; iconUrl?: string }) =>
  request<Server>(`/servers/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
export const deleteServer = (id: string) =>
  request<{ success: true }>(`/servers/${id}`, { method: 'DELETE' });

export const listMembers = (serverId: string) =>
  request<ServerMemberInfo[]>(`/servers/${serverId}/members`);
export const kickMember = (serverId: string, userId: string) =>
  request<{ success: true }>(`/servers/${serverId}/members/${userId}`, { method: 'DELETE' });
/** Invite a user — creates a PENDING invitation they must accept (does not add directly). */
export const inviteMember = (serverId: string, userId: string) =>
  request<{ id: string; status: string }>(`/servers/${serverId}/members`, { method: 'POST', body: JSON.stringify({ userId }) });

export const listRoles = (serverId: string) => request<Role[]>(`/servers/${serverId}/roles`);
export const createRole = (serverId: string, data: { name: string; color?: number; permissions?: string }) =>
  request<Role>(`/servers/${serverId}/roles`, { method: 'POST', body: JSON.stringify(data) });
export const updateRole = (
  serverId: string,
  roleId: string,
  data: { name?: string; color?: number; permissions?: string },
) => request<Role>(`/servers/${serverId}/roles/${roleId}`, { method: 'PATCH', body: JSON.stringify(data) });
export const deleteRole = (serverId: string, roleId: string) =>
  request<{ success: true }>(`/servers/${serverId}/roles/${roleId}`, { method: 'DELETE' });
export const assignRole = (serverId: string, userId: string, roleId: string) =>
  request<{ success: true }>(`/servers/${serverId}/members/${userId}/roles/${roleId}`, { method: 'PUT' });
export const unassignRole = (serverId: string, userId: string, roleId: string) =>
  request<{ success: true }>(`/servers/${serverId}/members/${userId}/roles/${roleId}`, { method: 'DELETE' });
export const listChannels = (serverId: string) =>
  request<Channel[]>(`/servers/${serverId}/channels`);
export const createChannel = (
  serverId: string,
  data: { name: string; type?: string; categoryId?: string },
) => request<Channel>(`/servers/${serverId}/channels`, { method: 'POST', body: JSON.stringify(data) });
export const deleteChannel = (serverId: string, channelId: string) =>
  request<{ success: true }>(`/servers/${serverId}/channels/${channelId}`, { method: 'DELETE' });
export const reorderChannels = (serverId: string, orderedIds: string[]) =>
  request<{ success: true }>(`/servers/${serverId}/channels/reorder`, { method: 'PATCH', body: JSON.stringify({ orderedIds }) });
export const leaveServer = (serverId: string) =>
  request<{ success: true }>(`/servers/${serverId}/members/me`, { method: 'DELETE' });
export const listSounds = (serverId: string) =>
  request<ServerSound[]>(`/servers/${serverId}/sounds`);
export const addSound = (serverId: string, data: { name: string; url: string; emoji?: string | null }) =>
  request<ServerSound>(`/servers/${serverId}/sounds`, { method: 'POST', body: JSON.stringify(data) });
export const updateSound = (serverId: string, soundId: string, data: { name?: string; emoji?: string | null }) =>
  request<ServerSound>(`/servers/${serverId}/sounds/${soundId}`, { method: 'PATCH', body: JSON.stringify(data) });
export const deleteSound = (serverId: string, soundId: string) =>
  request<{ success: true }>(`/servers/${serverId}/sounds/${soundId}`, { method: 'DELETE' });

export const listMessages = (channelId: string, before?: string) => {
  const params = new URLSearchParams();
  if (before) params.set('before', before);
  return request<Message[]>(`/channels/${channelId}/messages?${params.toString()}`);
};
export const searchMessages = (channelId: string, q: string) =>
  request<Message[]>(`/channels/${channelId}/messages/search?q=${encodeURIComponent(q)}`);
export const sendMessage = (channelId: string, data: { content: string; attachments?: unknown[] }) =>
  request<Message>(`/channels/${channelId}/messages`, { method: 'POST', body: JSON.stringify(data) });
export const updateMessage = (messageId: string, data: { content: string }) =>
  request<Message>(`/messages/${messageId}`, { method: 'PATCH', body: JSON.stringify(data) });
export const deleteMessage = (messageId: string) =>
  request<void>(`/messages/${messageId}`, { method: 'DELETE' });
export const addReaction = (messageId: string, emoji: string) =>
  request<Message>(`/messages/${messageId}/reactions`, { method: 'POST', body: JSON.stringify({ emoji }) });
export const removeReaction = (messageId: string, emoji: string) =>
  request<Message>(`/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`, { method: 'DELETE' });
export const createPoll = (
  channelId: string,
  data: { question: string; options: string[]; multiple?: boolean; durationMinutes?: number | null },
) => request<Message>(`/channels/${channelId}/polls`, { method: 'POST', body: JSON.stringify(data) });
export const votePollOption = (optionId: string) =>
  request<Message>(`/polls/options/${optionId}/vote`, { method: 'POST' });
export const listPins = (channelId: string) =>
  request<Message[]>(`/channels/${channelId}/pins`);
export const pinMessage = (messageId: string, pinned: boolean) =>
  request<Message>(`/messages/${messageId}/pin`, { method: 'PATCH', body: JSON.stringify({ pinned }) });
export const markRead = (channelId: string, lastReadMessageId: string) =>
  request<void>(`/channels/${channelId}/read`, {
    method: 'POST',
    body: JSON.stringify({ lastReadMessageId }),
  });
export const getWsTicket = () => request<WsTicket>('/auth/ws-ticket');

export const listAppTokens = () => request<ApiToken[]>('/auth/tokens');
export const createAppToken = (name: string) =>
  request<CreatedApiToken>('/auth/tokens', { method: 'POST', body: JSON.stringify({ name }) });
export const revokeAppToken = (id: string) =>
  request<{ success: true }>(`/auth/tokens/${id}`, { method: 'DELETE' });

export const voiceJoin = (channelId: string) =>
  request<{ url: string; token: string; room: string }>(`/voice/${channelId}/join`, { method: 'POST' });
export const voiceLeave = (channelId: string) =>
  request<{ success: true }>(`/voice/${channelId}/leave`, { method: 'POST' });
export const voiceParticipants = (channelId: string) =>
  request<{ id: string; username: string; displayName: string | null; avatarUrl: string | null }[]>(`/voice/${channelId}/participants`);

export const watchpartyGet = (channelId: string) => request<WatchPartyState | null>(`/watchparty/${channelId}`);
export const watchpartyStart = (channelId: string, itemId: string, audio = false) =>
  request<WatchPartyState>(`/watchparty/${channelId}/start`, { method: 'POST', body: JSON.stringify({ itemId, audio }) });
export const watchpartyStartYoutube = (channelId: string, youtubeId: string) =>
  request<WatchPartyState>(`/watchparty/${channelId}/start`, { method: 'POST', body: JSON.stringify({ youtubeId }) });
export const watchpartyState = (channelId: string, positionMs: number, paused: boolean) =>
  request<WatchPartyState>(`/watchparty/${channelId}/state`, { method: 'POST', body: JSON.stringify({ positionMs, paused }) });
export const watchpartyStop = (channelId: string) =>
  request<{ success: true }>(`/watchparty/${channelId}/stop`, { method: 'POST' });
export const watchpartySearch = (q: string, type: 'all' | 'movie' | 'show' | 'music' = 'all') =>
  request<LibraryItem[]>(`/watchparty/library?q=${encodeURIComponent(q)}&type=${type}`);

export const gifSearch = (q: string) => request<Gif[]>(`/gifs/search?q=${encodeURIComponent(q)}`);
