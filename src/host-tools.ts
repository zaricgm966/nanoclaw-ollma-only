import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';

export type HostToolName = 'open_app' | 'take_screenshot' | 'apply_skill';

export interface HostToolRequest {
  id: string;
  type: HostToolName;
  app?: string;
  skill?: string;
  skillPath?: string;
}

export interface HostToolResult {
  ok: boolean;
  message: string;
  screenshotPath?: string;
  screenshotUrl?: string;
}

function execFileAsync(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr?.trim() || stdout?.trim() || error.message));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function openApp(app: string): Promise<HostToolResult> {
  const requested = app.trim();
  if (!requested) {
    return { ok: false, message: 'Missing app name.' };
  }

  const isSteam = /^(steam|steam\.exe|steam:\/\/open\/main)$/i.test(requested);
  const launchTarget = isSteam ? 'steam://open/main' : requested;
  const displayName = isSteam ? 'Steam' : requested;

  if (process.platform === 'win32') {
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Start-Process -FilePath ${JSON.stringify(launchTarget)}`,
    ]);
    return { ok: true, message: `Opened app: ${displayName}` };
  }

  if (process.platform === 'darwin') {
    await execFileAsync('open', ['-a', launchTarget]);
    return { ok: true, message: `Opened app: ${displayName}` };
  }

  await execFileAsync('xdg-open', [launchTarget]);
  return { ok: true, message: `Opened app: ${displayName}` };
}

async function takeScreenshot(): Promise<HostToolResult> {
  const screenshotsDir = path.join(process.cwd(), 'store', 'screenshots');
  fs.mkdirSync(screenshotsDir, { recursive: true });
  const targetPath = path.join(
    screenshotsDir,
    `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`,
  );

  if (process.platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      '$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen',
      '$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height',
      '$graphics = [System.Drawing.Graphics]::FromImage($bitmap)',
      '$graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bitmap.Size)',
      `$bitmap.Save(${JSON.stringify(targetPath)}, [System.Drawing.Imaging.ImageFormat]::Png)`,
      '$graphics.Dispose()',
      '$bitmap.Dispose()',
    ].join('; ');
    await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script]);
    return {
      ok: true,
      message: `Screenshot saved to ${targetPath}`,
      screenshotPath: targetPath,
      screenshotUrl: `/api/screenshots/${path.basename(targetPath)}`,
    };
  }

  if (process.platform === 'darwin') {
    await execFileAsync('screencapture', ['-x', targetPath]);
    return {
      ok: true,
      message: `Screenshot saved to ${targetPath}`,
      screenshotPath: targetPath,
      screenshotUrl: `/api/screenshots/${path.basename(targetPath)}`,
    };
  }

  await execFileAsync('import', ['-window', 'root', targetPath]);
  return {
    ok: true,
    message: `Screenshot saved to ${targetPath}`,
    screenshotPath: targetPath,
  };
}

function resolveLocalSkillDir(
  skill: string,
  skillPath?: string,
): string | null {
  const projectRoot = process.cwd();
  const candidates = new Set<string>();

  if (skillPath) {
    candidates.add(
      path.isAbsolute(skillPath)
        ? skillPath
        : path.join(projectRoot, skillPath),
    );
  }

  const normalized = skill.trim();
  if (normalized) {
    const variants = new Set([
      normalized,
      normalized.replace(/_/g, '-'),
      normalized.replace(/-/g, '_'),
    ]);

    for (const variant of variants) {
      candidates.add(path.join(projectRoot, '.agents', 'skills', variant));
      candidates.add(
        path.join(projectRoot, '.agents', 'skills', `add-${variant}`),
      );
    }
  }

  for (const candidate of candidates) {
    if (
      fs.existsSync(candidate) &&
      fs.existsSync(path.join(candidate, 'manifest.yaml')) &&
      fs.existsSync(path.join(candidate, 'SKILL.md'))
    ) {
      return candidate;
    }
  }

  return null;
}

async function runShellCommand(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  if (process.platform === 'win32') {
    return execFileAsync('cmd.exe', ['/c', command, ...args]);
  }

  return execFileAsync(command, args);
}

async function applySkill(
  skill: string,
  skillPath?: string,
): Promise<HostToolResult> {
  const requested = skill.trim() || skillPath?.trim() || '';
  if (!requested) {
    return { ok: false, message: 'Missing skill name or path.' };
  }

  const resolvedSkillDir = resolveLocalSkillDir(skill, skillPath);
  if (!resolvedSkillDir) {
    return {
      ok: false,
      message:
        `Skill package not found: ${requested}. ` +
        'NanoClaw can only install packaged local skills that include manifest.yaml and SKILL.md.',
    };
  }

  await runShellCommand('npx', [
    'tsx',
    'scripts/apply-skill.ts',
    resolvedSkillDir,
  ]);
  await runShellCommand('npm', ['run', 'build']);

  return {
    ok: true,
    message:
      `Installed skill from ${resolvedSkillDir} and rebuilt NanoClaw. ` +
      'Restart the service to load the new code.',
  };
}

export async function runHostTool(
  request: HostToolRequest,
): Promise<HostToolResult> {
  if (request.type === 'open_app') {
    return openApp(request.app || '');
  }

  if (request.type === 'take_screenshot') {
    return takeScreenshot();
  }

  if (request.type === 'apply_skill') {
    return applySkill(request.skill || '', request.skillPath);
  }

  return { ok: false, message: `Unknown host tool: ${request.type}` };
}
