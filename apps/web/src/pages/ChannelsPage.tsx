import { useQuery } from '@tanstack/react-query';

import { api } from '../api';

const labels: Record<string, string> = {
  telegram: 'Telegram',
  qq: 'QQ / OneBot',
  whatsapp: 'WhatsApp',
  slack: 'Slack',
  discord: 'Discord',
};

export function ChannelsPage() {
  const channels = useQuery({ queryKey: ['channels'], queryFn: api.channels, refetchInterval: 5000 });

  return (
    <section className="page">
      <div className="page-header">
        <div>
          <p className="eyebrow">Channels</p>
          <h2>渠道</h2>
          <p className="muted">查看各渠道连接状态与能力</p>
        </div>
      </div>
      <div className="channel-grid">
        {channels.isLoading && <p className="muted">加载中...</p>}
        {channels.data?.map((channel) => (
          <article className="channel-card" key={channel.name}>
            <div className="channel-card-head">
              <div>
                <p className="eyebrow">{channel.name}</p>
                <h3>{labels[channel.name] || channel.name}</h3>
              </div>
              <span className={channel.connected ? 'badge ok' : 'badge warn'}>
                {channel.connected ? '在线' : '离线'}
              </span>
            </div>
            <div className="channel-card-body">
              <div className="cap-row">
                <span>输入输出</span>
                <strong>{channel.connected ? '可用' : '未连接'}</strong>
              </div>
              <div className="cap-row">
                <span>输入中提示</span>
                <strong>{channel.supportsTyping ? '支持' : '不支持'}</strong>
              </div>
              <div className="cap-row">
                <span>群组同步</span>
                <strong>{channel.supportsSync ? '支持' : '不支持'}</strong>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
