import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';

function tailLines(filePath: string, maxLines: number): string[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8');
  return content.split(/\r?\n/).filter(Boolean).slice(-maxLines);
}

export function readAppLogs(maxLines: number = 200): string[] {
  return tailLines(path.resolve(process.cwd(), 'logs', 'nanoclaw.log'), maxLines);
}

export function readGroupLogs(groupFolder: string, maxLines: number = 200): string[] {
  const logsDir = path.join(GROUPS_DIR, groupFolder, 'logs');
  if (!fs.existsSync(logsDir)) return [];

  const files = fs
    .readdirSync(logsDir)
    .filter((name) => name.endsWith('.log'))
    .map((name) => ({
      name,
      fullPath: path.join(logsDir, name),
      mtime: fs.statSync(path.join(logsDir, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length === 0) return [];
  return tailLines(files[0].fullPath, maxLines);
}

export function listGroupLogFiles(groupFolder: string): string[] {
  const logsDir = path.join(GROUPS_DIR, groupFolder, 'logs');
  if (!fs.existsSync(logsDir)) return [];
  return fs
    .readdirSync(logsDir)
    .filter((name) => name.endsWith('.log'))
    .sort()
    .reverse();
}
