import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';

import { api } from '../api';

export function GroupDetailPage() {
  const params = useParams();
  const jid = decodeURIComponent(params.jid || '');
  const groups = useQuery({ queryKey: ['groups'], queryFn: api.groups });
  const messages = useQuery({
    queryKey: ['group-messages', jid],
    queryFn: () => api.groupMessages(jid),
    enabled: Boolean(jid),
  });

  const group = groups.data?.find((item) => item.jid === jid);

  return (
    <section className="page">
      <div className="page-header">
        <div>
          <p className="eyebrow">Group Detail</p>
          <h2>{group?.name || jid}</h2>
          <p className="muted mono">{jid}</p>
        </div>
      </div>
      <section className="panel">
        <div className="detail-grid">
          <div>
            <span className="detail-label">Folder</span>
            <strong>{group?.folder || '-'}</strong>
          </div>
          <div>
            <span className="detail-label">Trigger</span>
            <strong>{group?.trigger || '-'}</strong>
          </div>
          <div>
            <span className="detail-label">Main</span>
            <strong>{group?.isMain ? '是' : '否'}</strong>
          </div>
        </div>
      </section>
      <section className="panel">
        <div className="panel-header">
          <h3>最近消息</h3>
        </div>
        <div className="message-list">
          {messages.isLoading && <p className="muted">加载中...</p>}
          {messages.data?.map((message) => (
            <article className="message-card" key={`${message.id}-${message.timestamp}`}>
              <div className="message-meta">
                <strong>{message.sender_name}</strong>
                <span>{new Date(message.timestamp).toLocaleString('zh-CN')}</span>
              </div>
              <p>{message.content}</p>
            </article>
          ))}
        </div>
      </section>
    </section>
  );
}
