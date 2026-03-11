import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { api } from '../api';

export function InboxPage() {
  const chats = useQuery({ queryKey: ['chats'], queryFn: api.chats, refetchInterval: 5000 });

  return (
    <section className="page">
      <div className="page-header">
        <div>
          <p className="eyebrow">Inbox</p>
          <h2>会话</h2>
          <p className="muted">查看最近活跃的聊天与群组</p>
        </div>
      </div>
      <section className="panel">
        <div className="list">
          {chats.isLoading && <p className="muted">加载中...</p>}
          {chats.data?.map((chat) => (
            <Link className="list-row list-link" key={chat.jid} to={`/groups/${encodeURIComponent(chat.jid)}`}>
              <div>
                <strong>{chat.name || chat.jid}</strong>
                <p className="muted mono">{chat.jid}</p>
              </div>
              <div className="row-meta">
                <span className="badge soft">{chat.channel || 'unknown'}</span>
                <span className="muted">{chat.last_message_time ? new Date(chat.last_message_time).toLocaleString('zh-CN') : '-'}</span>
              </div>
            </Link>
          ))}
        </div>
      </section>
    </section>
  );
}
