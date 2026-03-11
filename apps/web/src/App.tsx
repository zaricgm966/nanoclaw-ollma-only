import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';

import { Shell } from './components/Shell';
import { ChannelsPage } from './pages/ChannelsPage';
import { DashboardPage } from './pages/DashboardPage';
import { DirectChatPage } from './pages/DirectChatPage';
import { GroupDetailPage } from './pages/GroupDetailPage';
import { GroupsPage } from './pages/GroupsPage';
import { InboxPage } from './pages/InboxPage';
import { LogsPage } from './pages/LogsPage';
import { RuntimePage } from './pages/RuntimePage';
import { TasksPage } from './pages/TasksPage';

const queryClient = new QueryClient();

const router = createBrowserRouter([
  { path: '/', element: <Shell><DashboardPage /></Shell> },
  { path: '/chat', element: <Shell><DirectChatPage /></Shell> },
  { path: '/inbox', element: <Shell><InboxPage /></Shell> },
  { path: '/channels', element: <Shell><ChannelsPage /></Shell> },
  { path: '/groups', element: <Shell><GroupsPage /></Shell> },
  { path: '/groups/:jid', element: <Shell><GroupDetailPage /></Shell> },
  { path: '/tasks', element: <Shell><TasksPage /></Shell> },
  { path: '/logs', element: <Shell><LogsPage /></Shell> },
  { path: '/settings', element: <Shell><RuntimePage /></Shell> },
]);

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
