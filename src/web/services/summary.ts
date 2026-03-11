import { Channel, RegisteredGroup } from '../../types.js';

export interface WebSummary {
  assistantName: string;
  startedAt: string;
  channelCount: number;
  connectedChannels: number;
  registeredGroupCount: number;
  sessionCount: number;
  taskCount: number;
  recentChatCount: number;
}

export interface WebServerState {
  assistantName: string;
  startedAt: string;
  channels: () => Channel[];
  registeredGroups: () => Record<string, RegisteredGroup>;
  sessions: () => Record<string, string>;
  taskCount: () => number;
  recentChatCount: () => number;
}

export function buildSummary(state: WebServerState): WebSummary {
  const channels = state.channels();
  return {
    assistantName: state.assistantName,
    startedAt: state.startedAt,
    channelCount: channels.length,
    connectedChannels: channels.filter((channel) => channel.isConnected())
      .length,
    registeredGroupCount: Object.keys(state.registeredGroups()).length,
    sessionCount: Object.keys(state.sessions()).length,
    taskCount: state.taskCount(),
    recentChatCount: state.recentChatCount(),
  };
}
