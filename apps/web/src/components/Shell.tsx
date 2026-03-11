import { NavLink } from 'react-router-dom';

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">NanoClaw</p>
          <h1>控制台</h1>
          <p className="muted">React Web 控制台基础版</p>
        </div>
        <nav className="nav">
          <NavLink to="/">仪表盘</NavLink>
          <NavLink to="/chat">直接对话</NavLink>
          <NavLink to="/inbox">会话</NavLink>
          <NavLink to="/channels">渠道</NavLink>
          <NavLink to="/groups">群组</NavLink>
          <NavLink to="/tasks">任务</NavLink>
          <NavLink to="/logs">日志</NavLink>
          <NavLink to="/settings">设置</NavLink>
        </nav>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}
