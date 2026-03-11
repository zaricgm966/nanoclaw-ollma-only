import { useQuery } from '@tanstack/react-query';

import { api } from '../api';
import { useLiveEvents } from '../hooks';

export function DashboardPage() {
  useLiveEvents();
  const summary = useQuery({ queryKey: ['summary'], queryFn: api.summary });
  const channels = useQuery({ queryKey: ['channels'], queryFn: api.channels, refetchInterval: 5000 });

  return (
    <section className="page">
      <div className="page-header">
        <div>
          <p className="eyebrow">Overview</p>
          <h2>仪表盘</h2>
        </div>
      </div>
      <div className="stats-grid">
        {[
          ['已连接渠道', summary.data?.connectedChannels ?? '-'],
          ['渠道总数', summary.data?.channelCount ?? '-'],
          ['已注册群组', summary.data?.registeredGroupCount ?? '-'],
          ['活跃会话', summary.data?.sessionCount ?? '-'],
          ['任务数量', summary.data?.taskCount ?? '-'],
          ['最近聊天', summary.data?.recentChatCount ?? '-'],
        ].map(([label, value]) => (
          <article className="stat-card" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </article>
        ))}
      </div>
      <section className="panel">
        <div className="panel-header">
          <h3>渠道状态</h3>
        </div>
        <div className="list">
          {channels.isLoading && <p className="muted">加载中...</p>}
          {channels.data?.map((channel) => (
            <div className="list-row" key={channel.name}>
              <span>{channel.name}</span>
              <span className={channel.connected ? 'badge ok' : 'badge warn'}>
                {channel.connected ? '在线' : '离线'}
              </span>
            </div>
          ))}
        </div>
      </section>
    </section>
  );
}
