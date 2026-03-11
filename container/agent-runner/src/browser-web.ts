import puppeteer, { Browser, Page } from 'puppeteer-core';

const MAX_TEXT_LENGTH = 6000;
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_RESULT_COUNT = 5;

let browserPromise: Promise<Browser> | null = null;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

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
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 NanoClawBrowser/1.0');

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

function decodeBingRedirect(url: string): string {
  try {
    const parsed = new URL(url);
    if (!/bing\.com$/i.test(parsed.hostname)) {
      return url;
    }

    const raw = parsed.searchParams.get('u') || '';
    if (!raw) {
      return url;
    }

    const payload = raw.startsWith('a1') ? raw.slice(2) : raw;
    const decoded = Buffer.from(payload, 'base64').toString('utf8');
    if (/^https?:\/\//i.test(decoded)) {
      return decoded;
    }

    return url;
  } catch {
    return url;
  }
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

async function extractBingResults(page: Page): Promise<SearchResult[]> {
  await page.waitForSelector('li.b_algo h2 a', { timeout: 10000 }).catch(() => undefined);

  return page.evaluate((maxCount) => {
    const items = Array.from(document.querySelectorAll('li.b_algo'));
    return items
      .map((item) => {
        const anchor = item.querySelector('h2 a') as HTMLAnchorElement | null;
        const snippetNode = item.querySelector('.b_caption p') || item.querySelector('p');
        const title = (anchor?.textContent || '').replace(/\s+/g, ' ').trim();
        const url = anchor?.href || '';
        const snippet = (snippetNode?.textContent || '').replace(/\s+/g, ' ').trim();
        if (!title || !url) return null;
        return { title, url, snippet };
      })
      .filter((item): item is { title: string; url: string; snippet: string } => item !== null)
      .slice(0, maxCount);
  }, MAX_RESULT_COUNT);
}

export async function webSearch(query: string): Promise<string> {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error('web_search requires a non-empty query');
  }

  return withPage(async (page) => {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(trimmed)}&setlang=zh-Hans`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    const results = (await extractBingResults(page)).map((result) => ({
      ...result,
      url: decodeBingRedirect(result.url),
    }));
    if (results.length === 0) {
      const pageTitle = normalizeWhitespace(await page.title());
      const visibleText = normalizeWhitespace(
        await page.evaluate(() => (document.body?.innerText || '').slice(0, 500)),
      );
      return [
        `SEARCH_QUERY: ${trimmed}`,
        'RESULT_COUNT: 0',
        `PAGE_TITLE: ${pageTitle || '[unknown]'}`,
        `PAGE_HINT: ${visibleText || '[no visible text extracted]'}`,
      ].join('\n\n');
    }

    return [
      `SEARCH_QUERY: ${trimmed}`,
      `RESULT_COUNT: ${results.length}`,
      ...results.map(
        (result, index) =>
          [
            `RESULT ${index + 1}`,
            `TITLE: ${result.title}`,
            `URL: ${result.url}`,
            `DOMAIN: ${getDomain(result.url) || '[unknown]'}`,
            `SNIPPET: ${result.snippet || '[no snippet]'}`,
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
