import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';

export type HostToolName = 'open_app' | 'take_screenshot';

export interface HostToolRequest {
  id: string;
  type: HostToolName;
  app?: string;
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
        reject(
          new Error(stderr?.trim() || stdout?.trim() || error.message),
        );
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

export async function runHostTool(
  request: HostToolRequest,
): Promise<HostToolResult> {
  if (request.type === 'open_app') {
    return openApp(request.app || '');
  }

  if (request.type === 'take_screenshot') {
    return takeScreenshot();
  }

  return { ok: false, message: `Unknown host tool: ${request.type}` };
}
