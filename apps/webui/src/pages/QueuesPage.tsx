import { useState } from 'react';
import {
  useImprovementQueue,
  useImprovementQueueStats,
  useConfirmationQueue,
  useGLMChanges,
  QueuedImprovement,
  ConfirmationItem,
  GLMChange,
} from '../api/hooks/useQueues';
import { Spinner } from '../components/common/Spinner';
import { Badge } from '../components/common/Badge';

type TabType = 'improvements' | 'confirmations' | 'glm-changes';

export function QueuesPage() {
  const [activeTab, setActiveTab] = useState<TabType>('improvements');

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Queues</h1>
        <p className="text-gray-500 mt-1">Monitor improvement and confirmation queues</p>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200 mb-6">
        <nav className="-mb-px flex space-x-8">
          <TabButton
            active={activeTab === 'improvements'}
            onClick={() => setActiveTab('improvements')}
          >
            Improvement Queue
          </TabButton>
          <TabButton
            active={activeTab === 'confirmations'}
            onClick={() => setActiveTab('confirmations')}
          >
            Claude Confirmation
          </TabButton>
          <TabButton
            active={activeTab === 'glm-changes'}
            onClick={() => setActiveTab('glm-changes')}
          >
            GLM Changes
          </TabButton>
        </nav>
      </div>

      {/* Tab Content */}
      {activeTab === 'improvements' && <ImprovementQueueTab />}
      {activeTab === 'confirmations' && <ConfirmationQueueTab />}
      {activeTab === 'glm-changes' && <GLMChangesTab />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`
        py-4 px-1 border-b-2 font-medium text-sm
        ${active
          ? 'border-blue-500 text-blue-600'
          : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
        }
      `}
    >
      {children}
    </button>
  );
}

// Improvement Queue Tab
function ImprovementQueueTab() {
  const { data, loading, error } = useImprovementQueue();
  const { stats } = useImprovementQueueStats();
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const filteredData = statusFilter === 'all'
    ? data
    : data.filter((item) => item.status === statusFilter);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
        {error}
      </div>
    );
  }

  return (
    <div>
      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-5 gap-4 mb-6">
          <StatCard label="Total" value={stats.total} />
          <StatCard label="Pending" value={stats.byStatus.pending} color="yellow" />
          <StatCard label="In Progress" value={stats.byStatus.inProgress} color="blue" />
          <StatCard label="Completed" value={stats.byStatus.completed} color="green" />
          <StatCard label="Failed" value={stats.byStatus.failed} color="red" />
        </div>
      )}

      {/* Filter */}
      <div className="mb-4">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="border border-gray-300 rounded-md px-3 py-2 text-sm"
        >
          <option value="all">All Status</option>
          <option value="pending">Pending</option>
          <option value="in_progress">In Progress</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="skipped">Skipped</option>
        </select>
      </div>

      {/* List */}
      {filteredData.length === 0 ? (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-8 text-center text-gray-500">
          No improvements found
        </div>
      ) : (
        <div className="space-y-3">
          {filteredData.map((item) => (
            <ImprovementCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

function ImprovementCard({ item }: { item: QueuedImprovement }) {
  const statusColors: Record<string, 'gray' | 'yellow' | 'blue' | 'green' | 'red'> = {
    pending: 'yellow',
    scheduled: 'blue',
    in_progress: 'blue',
    completed: 'green',
    failed: 'red',
    skipped: 'gray',
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h3 className="font-medium text-gray-900">{item.title}</h3>
            <Badge color={statusColors[item.status] || 'gray'}>{item.status}</Badge>
            <Badge color="gray">{item.type}</Badge>
          </div>
          <p className="text-sm text-gray-500 mt-1">{item.description}</p>
          {item.relatedFile && (
            <p className="text-xs text-gray-400 mt-1 font-mono">{item.relatedFile}</p>
          )}
        </div>
        <div className="text-right">
          <div className="text-sm font-medium text-gray-900">P{item.priority}</div>
          <div className="text-xs text-gray-400">{item.source}</div>
        </div>
      </div>
    </div>
  );
}

// Confirmation Queue Tab
function ConfirmationQueueTab() {
  const { data, stats, loading, error } = useConfirmationQueue();

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
        {error}
      </div>
    );
  }

  return (
    <div>
      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-5 gap-4 mb-6">
          <StatCard label="Total" value={stats.total} />
          <StatCard label="Pending" value={stats.pending} color="yellow" />
          <StatCard label="In Review" value={stats.inReview} color="blue" />
          <StatCard label="Confirmed" value={stats.confirmed} color="green" />
          <StatCard label="Needs Review" value={stats.needsReview} color="red" />
        </div>
      )}

      {/* List */}
      {data.length === 0 ? (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-8 text-center text-gray-500">
          No confirmations pending
        </div>
      ) : (
        <div className="space-y-3">
          {data.map((item) => (
            <ConfirmationCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

function ConfirmationCard({ item }: { item: ConfirmationItem }) {
  const statusColors: Record<string, 'gray' | 'yellow' | 'blue' | 'green' | 'red'> = {
    pending: 'yellow',
    in_review: 'blue',
    confirmed: 'green',
    rejected: 'red',
    needs_review: 'red',
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-gray-600">{item.changeId.slice(0, 8)}</span>
            <Badge color={statusColors[item.status] || 'gray'}>{item.status}</Badge>
          </div>
          {item.reviewNotes && (
            <p className="text-sm text-gray-500 mt-1">{item.reviewNotes}</p>
          )}
        </div>
        <div className="text-right text-sm text-gray-400">
          {new Date(item.createdAt).toLocaleDateString()}
        </div>
      </div>
    </div>
  );
}

// GLM Changes Tab
function GLMChangesTab() {
  const { data, stats, loading, error } = useGLMChanges();

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
        {error}
      </div>
    );
  }

  return (
    <div>
      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-4 gap-4 mb-6">
          <StatCard label="Total" value={stats.total} />
          <StatCard label="Unreviewed" value={stats.unreviewed} color="yellow" />
          <StatCard label="Approved" value={stats.approved} color="green" />
          <StatCard label="Rejected" value={stats.rejected} color="red" />
        </div>
      )}

      {/* List */}
      {data.length === 0 ? (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-8 text-center text-gray-500">
          No GLM changes recorded
        </div>
      ) : (
        <div className="space-y-3">
          {data.map((item) => (
            <GLMChangeCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

function GLMChangeCard({ item }: { item: GLMChange }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <Badge color="blue">{item.phase}</Badge>
            {item.reviewed ? (
              item.approved ? (
                <Badge color="green">Approved</Badge>
              ) : (
                <Badge color="red">Rejected</Badge>
              )
            ) : (
              <Badge color="yellow">Pending Review</Badge>
            )}
          </div>
          <p className="text-sm text-gray-700 mt-1">{item.description}</p>
          {item.files.length > 0 && (
            <div className="mt-2">
              <p className="text-xs text-gray-400">Files: {item.files.join(', ')}</p>
            </div>
          )}
        </div>
        <div className="text-right text-sm text-gray-400">
          {new Date(item.timestamp).toLocaleDateString()}
        </div>
      </div>
    </div>
  );
}

// Stat Card
function StatCard({
  label,
  value,
  color = 'gray',
}: {
  label: string;
  value: number;
  color?: 'gray' | 'yellow' | 'blue' | 'green' | 'red';
}) {
  const colorClasses = {
    gray: 'bg-gray-50 text-gray-900',
    yellow: 'bg-yellow-50 text-yellow-900',
    blue: 'bg-blue-50 text-blue-900',
    green: 'bg-green-50 text-green-900',
    red: 'bg-red-50 text-red-900',
  };

  return (
    <div className={`rounded-lg p-4 ${colorClasses[color]}`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-sm opacity-75">{label}</div>
    </div>
  );
}
