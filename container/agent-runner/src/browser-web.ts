import puppeteer, { Browser, Page } from 'puppeteer-core';

const MAX_TEXT_LENGTH = 6000;
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_RESULT_COUNT = 5;

let browserPromise: Promise<Browser> | null = null;

function getExecutablePath(): string {
  return (
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
    process.env.AGENT_BROWSER_EXECUTABLE_PATH ||
    '/usr/bin/chromium'
  );
}

function getLaunchArgs(): string[] {
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-zygote',
  ];

  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
  if (proxy) {
    args.push(`--proxy-server=${proxy}`);
  }

  return args;
}

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      executablePath: getExecutablePath(),
      headless: true,
      args: getLaunchArgs(),
    });
  }

  return browserPromise;
}

async function withPage<T>(work: (page: Page) => Promise<T>): Promise<T> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(DEFAULT_TIMEOUT_MS);
  page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
  await page.setUserAgent('NanoClawBrowser/1.0');

  try {
    return await work(page);
  } finally {
    await page.close().catch(() => undefined);
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateText(value: string, maxLength = MAX_TEXT_LENGTH): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export async function webSearch(query: string): Promise<string> {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error('web_search requires a non-empty query');
  }

  return withPage(async (page) => {
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(trimmed)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    const results = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a.result__a'));
      const fallback = anchors.length
        ? anchors
        : Array.from(document.querySelectorAll('a[href]'));

      return fallback
        .map((anchor) => {
          const href = anchor.getAttribute('href') || '';
          const title = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
          if (!href || !title) return null;
          return { href, title };
        })
        .filter((item): item is { href: string; title: string } => item !== null)
        .slice(0, 8);
    });

    const normalized = results
      .map((result) => {
        try {
          const target = new URL(result.href, 'https://duckduckgo.com');
          const uddg = target.searchParams.get('uddg');
          const href = uddg ? decodeURIComponent(uddg) : target.toString();
          if (!/^https?:/i.test(href)) return null;
          return { title: result.title, url: href };
        } catch {
          if (!/^https?:/i.test(result.href)) return null;
          return { title: result.title, url: result.href };
        }
      })
      .filter((item): item is { title: string; url: string } => item !== null)
      .slice(0, MAX_RESULT_COUNT);

    if (normalized.length === 0) {
      return `No search results found for: ${trimmed}`;
    }

    return [
      `SEARCH_QUERY: ${trimmed}`,
      `RESULT_COUNT: ${normalized.length}`,
      ...normalized.map(
        (result, index) =>
          [
            `RESULT ${index + 1}`,
            `TITLE: ${result.title}`,
            `URL: ${result.url}`,
            `DOMAIN: ${getDomain(result.url) || '[unknown]'}`,
          ].join('\n'),
      ),
    ].join('\n\n');
  });
}

export async function webFetch(url: string): Promise<string> {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('web_fetch only supports http and https URLs');
  }

  return withPage(async (page) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    const payload = await page.evaluate(() => {
      const title = (document.title || '').trim();
      const description =
        (document.querySelector('meta[name="description"]') as HTMLMetaElement | null)?.content?.trim() || '';

      const mainElement =
        document.querySelector('main') ||
        document.querySelector('article') ||
        document.body;

      const text = (mainElement?.textContent || document.body?.innerText || '')
        .replace(/\s+/g, ' ')
        .trim();

      return { title, description, text };
    });

    const sections = [`FETCH_URL: ${url}`];
    if (payload.title) {
      sections.push(`TITLE: ${normalizeWhitespace(payload.title)}`);
    }
    if (payload.description) {
      sections.push(`DESCRIPTION: ${normalizeWhitespace(payload.description)}`);
    }
    sections.push(`DOMAIN: ${getDomain(url) || '[unknown]'}`);
    sections.push(`CONTENT:\n${truncateText(payload.text || '[no text content extracted]')}`);
    return sections.join('\n\n');
  });
}

async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  const browser = await browserPromise.catch(() => null);
  browserPromise = null;
  await browser?.close().catch(() => undefined);
}

process.on('exit', () => {
  void closeBrowser();
});
process.on('SIGINT', () => {
  void closeBrowser();
});
process.on('SIGTERM', () => {
  void closeBrowser();
});
