// Tool Registry — aggregates tool definitions and dispatches executors

import { definitions as taskDefs, executors as taskExecs } from './tools/task-tools.js';
import { definitions as queryDefs, executors as queryExecs } from './tools/query-tools.js';
import { definitions as summaryDefs, executors as summaryExecs } from './tools/summary-tools.js';
import { definitions as sendDefs, executors as sendExecs } from './tools/send-tools.js';
import { definitions as employeeDefs, executors as employeeExecs } from './tools/employee-tools.js';
import { definitions as calendarDefs, executors as calendarExecs } from './tools/calendar-tools.js';
import { definitions as memoryDefs, executors as memoryExecs } from './tools/memory-tools.js';

// All tool definitions (for Gemini function_declarations)
export function getAllToolDefinitions(role) {
  const tools = [
    ...taskDefs,
    ...queryDefs,
    ...summaryDefs,
    ...employeeDefs,
  ];

  // Boss-only tools
  if (role === 'boss') {
    tools.push(...sendDefs);
    tools.push(...calendarDefs);
    tools.push(...memoryDefs);
  }

  return tools;
}

// All executors (name → function mapping)
const allExecutors = {
  ...taskExecs,
  ...queryExecs,
  ...summaryExecs,
  ...sendExecs,
  ...employeeExecs,
  ...calendarExecs,
  ...memoryExecs,
};

export function getExecutor(toolName) {
  return allExecutors[toolName] || null;
}
