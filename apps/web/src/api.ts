export interface Summary {
  assistantName: string;
  startedAt: string;
  channelCount: number;
  connectedChannels: number;
  registeredGroupCount: number;
  sessionCount: number;
  taskCount: number;
  recentChatCount: number;
}

export interface ChannelInfo {
  name: string;
  connected: boolean;
  supportsTyping?: boolean;
  supportsSync?: boolean;
}

export interface GroupInfo {
  jid: string;
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  requiresTrigger?: boolean;
  isMain?: boolean;
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

export interface TaskInfo {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface MessageInfo {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
}

export interface LogsPayload {
  lines: string[];
}

export interface DirectChatRequest {
  message: string;
  userAgent?: string;
}

export interface DirectChatReply {
  reply: string;
  timestamp: string;
  sessionId: string | null;
}

export interface RuntimeInfo {
  assistantName: string;
  startedAt: string;
  provider: string;
  timezone: string;
  triggerPattern: string;
  ollama: {
    host: string;
    model: string;
    temperature: string;
  };
  webUi: {
    enabled: boolean;
    host: string;
    port: number;
    staticDir: string;
    staticBuildReady: boolean;
    mode: string;
  };
  proxy: {
    httpProxy: string;
    httpsProxy: string;
    noProxy: string;
  };
  container: {
    image: string;
    timeoutMs: number;
    maxConcurrent: number;
  };
  paths: {
    projectRoot: string;
    groupsDir: string;
    dataDir: string;
    storeDir: string;
  };
  channels: {
    installed: string[];
    telegramConfigured: boolean;
    qqConfigured: boolean;
    qqAccessTokenConfigured: boolean;
  };
  directChat: {
    jid: string;
    folder: string;
  };
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const fallback = `API request failed: ${response.status}`;
    try {
      const payload = await response.json() as { message?: string; error?: string };
      throw new Error(payload.message || payload.error || fallback);
    } catch {
      throw new Error(fallback);
    }
  }
  return response.json() as Promise<T>;
}

export const api = {
  health: () => apiFetch<{ status: string; assistantName: string; startedAt: string }>('/api/health'),
  summary: () => apiFetch<Summary>('/api/summary'),
  runtime: () => apiFetch<RuntimeInfo>('/api/runtime'),
  channels: () => apiFetch<ChannelInfo[]>('/api/channels'),
  chats: () => apiFetch<ChatInfo[]>('/api/chats'),
  tasks: () => apiFetch<TaskInfo[]>('/api/tasks'),
  groups: () => apiFetch<GroupInfo[]>('/api/groups'),
  directMessages: () => apiFetch<MessageInfo[]>('/api/direct-chat/messages?limit=120'),
  clearDirectMessages: () => apiFetch<{ ok: boolean }>('/api/direct-chat/messages', {
    method: 'DELETE',
  }),
  sendDirectMessage: ({ message, userAgent }: DirectChatRequest) => apiFetch<DirectChatReply>('/api/direct-chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, userAgent }),
  }),
  chatMessages: (jid: string) => apiFetch<MessageInfo[]>(`/api/chats/${encodeURIComponent(jid)}/messages?limit=50`),
  groupMessages: (jid: string) => apiFetch<MessageInfo[]>(`/api/groups/${encodeURIComponent(jid)}/messages?limit=50`),
  appLogs: () => apiFetch<LogsPayload>('/api/logs/app?limit=200'),
};
