import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import { Spinner } from '../components/common/Spinner';
import { MarkdownRenderer } from '../components/common/MarkdownRenderer';
import type { MarkdownLogFile, MarkdownLogListResponse, MarkdownLogContentResponse } from '../api/types';

export function DailyReportsPage() {
  const [reports, setReports] = useState<MarkdownLogFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedReport, setSelectedReport] = useState<MarkdownLogFile | null>(null);
  const [reportContent, setReportContent] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);

  const fetchReports = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.get<MarkdownLogListResponse>('/logs/files?type=daily-report');
      setReports(response.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch daily reports');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchReportContent = useCallback(async (filename: string) => {
    setContentLoading(true);
    try {
      const response = await api.get<MarkdownLogContentResponse>(
        `/logs/files/${encodeURIComponent(filename)}`
      );
      setReportContent(response.content);
    } catch (err) {
      setReportContent(`Error loading content: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setContentLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  useEffect(() => {
    if (selectedReport) {
      fetchReportContent(selectedReport.filename);
    } else {
      setReportContent(null);
    }
  }, [selectedReport, fetchReportContent]);

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
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Daily Reports</h1>
        <p className="text-gray-500 mt-1">View daily summary reports</p>
      </div>

      {reports.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          No daily reports found. Daily reports are logs with "daily" in the filename.
        </div>
      ) : selectedReport ? (
        <div>
          <button
            onClick={() => setSelectedReport(null)}
            className="mb-4 text-blue-600 hover:text-blue-800 text-sm"
          >
            ← Back to report list
          </button>
          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-800 mb-4">{selectedReport.filename}</h2>
            {contentLoading ? (
              <div className="flex items-center justify-center py-8">
                <Spinner size="md" />
              </div>
            ) : reportContent ? (
              <MarkdownRenderer content={reportContent} />
            ) : null}
          </div>
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
          {reports.map((report) => (
            <button
              key={report.filename}
              onClick={() => setSelectedReport(report)}
              className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50 transition-colors text-left"
            >
              <div>
                <div className="font-medium text-gray-900">{report.topic}</div>
                <div className="text-sm text-gray-500">{report.date}</div>
              </div>
              <span className="text-gray-400">→</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
