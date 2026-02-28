import { CheckCircle, Clock, TrendingUp, AlertCircle } from 'lucide-react';

interface DashboardStatsProps {
  totalRequests: number;
  activeRequests: number;
  completedThisWeek: number;
  avgTurnaround: number;
}

export function DashboardStats({
  totalRequests,
  activeRequests,
  completedThisWeek,
  avgTurnaround,
}: DashboardStatsProps) {
  const stats = [
    {
      label: 'Total Requests',
      value: totalRequests,
      icon: AlertCircle,
      color: 'bg-blue-500',
      change: null,
    },
    {
      label: 'Active',
      value: activeRequests,
      icon: Clock,
      color: 'bg-amber-500',
      change: activeRequests > 0 ? '+0' : '0',
    },
    {
      label: 'Completed This Week',
      value: completedThisWeek,
      icon: CheckCircle,
      color: 'bg-green-500',
      change: completedThisWeek > 0 ? `+${completedThisWeek}` : '0',
    },
    {
      label: 'Avg Turnaround',
      value: avgTurnaround,
      icon: TrendingUp,
      color: 'bg-emerald-500',
      change: avgTurnaround > 0 ? `${avgTurnaround} days` : 'N/A',
      isAverageDays: true,
    },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
      {stats.map((stat, index) => {
        const Icon = stat.icon;
        return (
          <div
            key={index}
            className="bg-white rounded-lg shadow-md p-6 border-l-4 border-emerald-500 hover:shadow-lg transition-shadow"
          >
            <div className="flex items-center justify-between mb-4">
              <span className="text-gray-600 text-sm font-medium">{stat.label}</span>
              <div className={`${stat.color} p-2.5 rounded-lg`}>
                <Icon className="w-5 h-5 text-white" />
              </div>
            </div>
            <div className="flex items-baseline justify-between">
              <p className="text-3xl font-bold text-gray-900">
                {stat.isAverageDays ? stat.value : stat.value}
              </p>
              {stat.change && (
                <span className="text-sm font-medium text-emerald-600 ml-2">{stat.change}</span>
              )}
            </div>
            {stat.isAverageDays && (
              <p className="text-gray-500 text-xs mt-2">average processing time</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
