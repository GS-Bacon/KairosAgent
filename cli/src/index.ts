#!/usr/bin/env node

const API_BASE = process.env.MOLTBOT_API || "http://localhost:3100";

interface StatusResponse {
  state: string;
  uptime_seconds: number;
  stats: {
    modifications_7d: number;
    rollbacks_7d: number;
    errors_7d: number;
  };
}

async function fetchAPI<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}/api${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

async function status(): Promise<void> {
  const data = await fetchAPI<StatusResponse>("/status");

  console.log("\n=== MoltBot Status ===");
  console.log(`State:   ${data.state}`);
  console.log(`Uptime:  ${formatDuration(data.uptime_seconds)}`);
  console.log("\n--- Last 7 days ---");
  console.log(`Modifications: ${data.stats.modifications_7d}`);
  console.log(`Rollbacks:     ${data.stats.rollbacks_7d}`);
  console.log(`Errors:        ${data.stats.errors_7d}`);
  console.log("");
}

async function health(): Promise<void> {
  const data = await fetchAPI<{
    status: string;
    checks: Array<{ name: string; status: string; message?: string }>;
  }>("/health");

  console.log("\n=== Health Check ===");
  console.log(`Overall: ${data.status}\n`);

  for (const check of data.checks) {
    const icon = check.status === "pass" ? "✓" : check.status === "warn" ? "!" : "✗";
    console.log(`[${icon}] ${check.name}: ${check.message || check.status}`);
  }
  console.log("");
}

async function logs(limit: number = 20): Promise<void> {
  const data = await fetchAPI<{
    data: Array<{ timestamp: string; level: string; message: string }>;
  }>(`/logs?limit=${limit}`);

  console.log("\n=== Recent Logs ===\n");

  for (const entry of data.data) {
    const time = new Date(entry.timestamp).toLocaleTimeString();
    const level = entry.level.toUpperCase().padEnd(5);
    console.log(`[${time}] [${level}] ${entry.message}`);
  }
  console.log("");
}

async function history(limit: number = 10): Promise<void> {
  const data = await fetchAPI<{
    data: Array<{ timestamp: string; type: string; description: string }>;
  }>(`/history?limit=${limit}`);

  console.log("\n=== History ===\n");

  for (const entry of data.data) {
    const time = new Date(entry.timestamp).toLocaleString();
    const type = entry.type.padEnd(12);
    console.log(`[${time}] ${type} ${entry.description}`);
  }
  console.log("");
}

async function check(): Promise<void> {
  console.log("Triggering check cycle...");
  const data = await fetchAPI<{ success: boolean; message: string; cycleId?: string }>(
    "/trigger/check",
    { method: "POST" }
  );

  console.log(`\nResult: ${data.message}`);
  if (data.cycleId) {
    console.log(`Cycle ID: ${data.cycleId}`);
  }
}

async function repair(): Promise<void> {
  console.log("Triggering repair cycle...");
  const data = await fetchAPI<{ success: boolean; message: string; cycleId?: string }>(
    "/trigger/repair",
    { method: "POST" }
  );

  console.log(`\nResult: ${data.message}`);
  if (data.cycleId) {
    console.log(`Cycle ID: ${data.cycleId}`);
  }
}

async function watch(): Promise<void> {
  console.log("Watching events (Ctrl+C to stop)...\n");

  const response = await fetch(`${API_BASE}/api/events`);
  const reader = response.body?.getReader();

  if (!reader) {
    console.error("Could not connect to event stream");
    return;
  }

  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const text = decoder.decode(value);
    const lines = text.split("\n");

    for (const line of lines) {
      if (line.startsWith("event:")) {
        const eventType = line.slice(7).trim();
        process.stdout.write(`[${eventType}] `);
      } else if (line.startsWith("data:")) {
        const data = line.slice(6).trim();
        console.log(data);
      }
    }
  }
}

function printHelp(): void {
  console.log(`
MoltBot CLI

Usage:
  moltbot <command> [options]

Commands:
  status          Show system status
  health          Show health check results
  logs [n]        Show recent logs (default: 20)
  history [n]     Show change history (default: 10)
  check           Trigger a check cycle
  repair          Trigger a repair cycle
  watch           Watch events in real-time
  help            Show this help

Environment:
  MOLTBOT_API     API base URL (default: http://localhost:3100)
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] || "help";

  try {
    switch (command) {
      case "status":
        await status();
        break;
      case "health":
        await health();
        break;
      case "logs":
        await logs(parseInt(args[1]) || 20);
        break;
      case "history":
        await history(parseInt(args[1]) || 10);
        break;
      case "check":
        await check();
        break;
      case "repair":
        await repair();
        break;
      case "watch":
        await watch();
        break;
      case "help":
      case "--help":
      case "-h":
        printHelp();
        break;
      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main();
