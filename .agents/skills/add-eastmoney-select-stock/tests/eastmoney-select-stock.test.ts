import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('eastmoney-select-stock skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf8');
    expect(content).toContain('skill: add-eastmoney-select-stock');
    expect(content).toContain('EASTMONEY_APIKEY');
    expect(content).toContain('container/Dockerfile');
  });

  it('includes the agent skill files', () => {
    expect(
      fs.existsSync(
        path.join(
          skillDir,
          'add',
          'container',
          'skills',
          'eastmoney-select-stock',
          'SKILL.md',
        ),
      ),
    ).toBe(true);

    expect(
      fs.existsSync(
        path.join(
          skillDir,
          'add',
          'container',
          'skills',
          'eastmoney-select-stock',
          'eastmoney-select-stock',
        ),
      ),
    ).toBe(true);
  });

  it('has the expected skill frontmatter', () => {
    const content = fs.readFileSync(
      path.join(
        skillDir,
        'add',
        'container',
        'skills',
        'eastmoney-select-stock',
        'SKILL.md',
      ),
      'utf8',
    );

    expect(content).toContain('name: eastmoney-select-stock');
    expect(content).toContain('allowed-tools: Bash(eastmoney-select-stock:*)');
    expect(content).toContain('A股');
    expect(content).toContain('港股');
    expect(content).toContain('美股');
  });

  it('script uses POST and writes CSV plus description output', () => {
    const content = fs.readFileSync(
      path.join(
        skillDir,
        'add',
        'container',
        'skills',
        'eastmoney-select-stock',
        'eastmoney-select-stock',
      ),
      'utf8',
    );

    expect(content).toMatch(/^#!/);
    expect(content).toContain('https://mkapi2.dfcfs.com/finskillshub/api/claw/stock-screen');
    expect(content).toContain("method: 'POST'");
    expect(content).toContain('EASTMONEY_APIKEY');
    expect(content).toContain('.csv');
    expect(content).toContain('.description.md');
    expect(content).toContain('EMPTY_RESULT_MESSAGE');
  });

  it('dockerfile installs the CLI into the image', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'container', 'Dockerfile'),
      'utf8',
    );

    expect(content).toContain('/usr/local/bin/eastmoney-select-stock');
    expect(content).toContain('chmod +x /usr/local/bin/eastmoney-select-stock');
    expect(content).toContain('FROM node:22-slim');
    expect(content).toContain('agent-browser');
  });

  it('has an intent file for the modified Dockerfile', () => {
    expect(
      fs.existsSync(
        path.join(skillDir, 'modify', 'container', 'Dockerfile.intent.md'),
      ),
    ).toBe(true);
  });
});
