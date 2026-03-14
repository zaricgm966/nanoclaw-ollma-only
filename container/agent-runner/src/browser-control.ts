import fs from 'fs';
import path from 'path';

import type { ElementHandle, KeyInput, Page } from 'puppeteer-core';

import {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  MAX_TEXT_LENGTH,
  getBrowser,
  getDomain,
  isHttpUrl,
  normalizeWhitespace,
  truncateText,
} from './browser-web.js';

const SNAPSHOT_PREVIEW_LENGTH = 1600;
const ACTION_PREVIEW_LENGTH = 600;
const READ_PREVIEW_LENGTH = 8000;
const MAX_INTERACTIVE_ELEMENTS = 80;
const MAX_LINKS = 80;
const DEFAULT_SCROLL_AMOUNT = 720;
const DEFAULT_WAIT_TIMEOUT_MS = 10000;

let activePage: Page | null = null;
let activePagePromise: Promise<Page> | null = null;

export interface BrowserActionResult {
  ok: boolean;
  action: string;
  url: string;
  title: string;
  domain: string;
  message?: string;
  textPreview?: string;
}

export interface BrowserInteractiveElement {
  elementId: string;
  tag: string;
  text: string;
  type: string;
  placeholder: string;
  ariaLabel: string;
  href: string;
  visible: boolean;
  disabled: boolean;
}

export interface BrowserSnapshotResult extends BrowserActionResult {
  textContent: string;
  interactiveElements: BrowserInteractiveElement[];
}

export interface BrowserScreenshotResult {
  ok: boolean;
  action: 'screenshot';
  path: string;
  screenshotUrl?: string;
  url: string;
  title: string;
  domain: string;
  message?: string;
}

export interface BrowserLinkResult {
  text: string;
  href: string;
  domain: string;
}

interface ExtractedElementRecord {
  elementId: string;
  tag: string;
  text: string;
  type: string;
  placeholder: string;
  ariaLabel: string;
  href: string;
  visible: boolean;
  disabled: boolean;
}

function assertHttpUrl(url: string): void {
  if (!isHttpUrl(url)) {
    throw new Error('Only http and https URLs are supported');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildTempScreenshotPath(): string {
  return path.join('/workspace/screenshots', `browser-${Date.now()}.png`);
}

function getScreenshotUrl(targetPath: string): string | undefined {
  const normalized = path.resolve(targetPath).replace(/\\/g, '/');
  const screenshotsRoot = path.resolve('/workspace/screenshots').replace(/\\/g, '/');
  if (!normalized.startsWith(screenshotsRoot + '/') && normalized !== screenshotsRoot) {
    return undefined;
  }
  return `/api/screenshots/${path.basename(targetPath)}`;
}

export function getBrowserControlExecutableHints(): string[] {
  return [
    process.env.PUPPETEER_EXECUTABLE_PATH || '',
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '',
    process.env.AGENT_BROWSER_EXECUTABLE_PATH || '',
    '/usr/bin/chromium',
  ].filter(Boolean);
}

async function configurePage(page: Page): Promise<void> {
  page.setDefaultNavigationTimeout(DEFAULT_TIMEOUT_MS);
  page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
  await page.setUserAgent(DEFAULT_USER_AGENT);
}

export async function getActivePage(): Promise<Page> {
  if (activePage && !activePage.isClosed()) {
    return activePage;
  }

  if (!activePagePromise) {
    activePagePromise = (async () => {
      const browser = await getBrowser();
      const page = await browser.newPage();
      await configurePage(page);
      page.on('close', () => {
        if (activePage === page) {
          activePage = null;
          activePagePromise = null;
        }
      });
      activePage = page;
      return page;
    })().catch((error) => {
      activePagePromise = null;
      throw error;
    });
  }

  return activePagePromise;
}

export async function closeActivePage(): Promise<void> {
  if (!activePage || activePage.isClosed()) {
    activePage = null;
    activePagePromise = null;
    return;
  }

  const page = activePage;
  activePage = null;
  activePagePromise = null;
  await page.close().catch(() => undefined);
}

async function waitForPageSettled(page: Page): Promise<void> {
  await Promise.allSettled([
    page.waitForFunction(
      () => document.readyState === 'interactive' || document.readyState === 'complete',
      { timeout: 2500 },
    ),
    page.waitForNetworkIdle({ idleTime: 400, timeout: 2500 }),
  ]);
  await sleep(150);
}

async function extractVisibleText(page: Page, maxLength = MAX_TEXT_LENGTH): Promise<string> {
  const text = await page.evaluate(() => {
    const target =
      document.querySelector('main') ||
      document.querySelector('article') ||
      document.body;
    if (!target) return '';

    const source =
      'innerText' in target && typeof (target as HTMLElement).innerText === 'string'
        ? (target as HTMLElement).innerText
        : target.textContent || '';

    return source;
  });

  return truncateText(normalizeWhitespace(text || ''), maxLength);
}

async function buildActionResult(
  page: Page,
  action: string,
  message?: string,
  previewLength = ACTION_PREVIEW_LENGTH,
): Promise<BrowserActionResult> {
  const url = page.url();
  const title = normalizeWhitespace(await page.title().catch(() => ''));
  const textPreview = await extractVisibleText(page, previewLength).catch(() => '');

  return {
    ok: true,
    action,
    url,
    title,
    domain: getDomain(url),
    message,
    textPreview,
  };
}

async function collectInteractiveElements(page: Page): Promise<BrowserInteractiveElement[]> {
  return page.evaluate((limit) => {
    const selectors = [
      'a[href]',
      'button',
      'input',
      'textarea',
      'select',
      '[role="button"]',
      '[onclick]',
      '[contenteditable="true"]',
    ].join(',');

    const normalize = (value: string | null | undefined): string =>
      (value || '').replace(/\s+/g, ' ').trim();

    const elements = Array.from(document.querySelectorAll<HTMLElement>(selectors));
    const seen = new Set<string>();
    const records: ExtractedElementRecord[] = [];

    for (const element of elements) {
      const tag = element.tagName.toLowerCase();
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      const visible =
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none';
      const disabled =
        element.hasAttribute('disabled') ||
        element.getAttribute('aria-disabled') === 'true';
      const text = normalize(
        'innerText' in element && typeof element.innerText === 'string'
          ? element.innerText
          : element.textContent,
      );
      const type = normalize((element as HTMLInputElement).type || element.getAttribute('role'));
      const placeholder = normalize((element as HTMLInputElement).placeholder || element.getAttribute('placeholder'));
      const ariaLabel = normalize(element.getAttribute('aria-label'));
      const href = tag === 'a' ? normalize((element as HTMLAnchorElement).href) : '';
      const fingerprint = [tag, text, type, placeholder, ariaLabel, href].join('|');

      if (seen.has(fingerprint)) {
        continue;
      }
      seen.add(fingerprint);

      const elementId = `el-${records.length + 1}`;
      element.dataset.agentElementId = elementId;
      records.push({
        elementId,
        tag,
        text,
        type,
        placeholder,
        ariaLabel,
        href,
        visible,
        disabled,
      });

      if (records.length >= limit) {
        break;
      }
    }

    return records;
  }, MAX_INTERACTIVE_ELEMENTS) as Promise<BrowserInteractiveElement[]>;
}

async function getElementHandle(page: Page, elementId: string): Promise<ElementHandle<Element> | null> {
  const trimmed = normalizeWhitespace(elementId);
  if (!trimmed) {
    throw new Error('elementId is required');
  }

  return page.$(`[data-agent-element-id="${trimmed}"]`);
}

async function ensureInteractiveSnapshot(page: Page): Promise<BrowserInteractiveElement[]> {
  return collectInteractiveElements(page);
}

async function ensureElementExists(page: Page, elementId: string): Promise<ElementHandle<Element>> {
  await ensureInteractiveSnapshot(page);
  const handle = await getElementHandle(page, elementId);
  if (!handle) {
    throw new Error(`Element not found: ${elementId}. Run browserSnapshot() to refresh the page map.`);
  }
  return handle;
}

async function scrollElementIntoView(handle: ElementHandle<Element>): Promise<void> {
  await handle.evaluate((element) => {
    (element as HTMLElement).scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  }).catch(() => undefined);
}

async function clickHandle(page: Page, handle: ElementHandle<Element>): Promise<void> {
  await scrollElementIntoView(handle);
  const clickable = await handle.evaluate((element) => {
    const htmlElement = element as HTMLElement;
    const rect = htmlElement.getBoundingClientRect();
    const style = window.getComputedStyle(htmlElement);
    return {
      visible:
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none',
      disabled:
        htmlElement.hasAttribute('disabled') ||
        htmlElement.getAttribute('aria-disabled') === 'true',
    };
  });

  if (!clickable.visible) {
    throw new Error('Target element is not visible');
  }
  if (clickable.disabled) {
    throw new Error('Target element is disabled');
  }

  await Promise.allSettled([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 2500 }),
    handle.click({ delay: 20 }),
  ]);
  await waitForPageSettled(page);
}

async function summarizeAfterAction(page: Page, action: string, message?: string): Promise<BrowserActionResult> {
  await waitForPageSettled(page);
  return buildActionResult(page, action, message);
}

export async function browserNavigate(url: string): Promise<BrowserActionResult> {
  const trimmed = normalizeWhitespace(url);
  assertHttpUrl(trimmed);

  try {
    const page = await getActivePage();
    await page.goto(trimmed, { waitUntil: 'domcontentloaded' });
    await waitForPageSettled(page);
    const textPreview = await extractVisibleText(page, SNAPSHOT_PREVIEW_LENGTH);
    const currentUrl = page.url();
    const title = normalizeWhitespace(await page.title());

    return {
      ok: true,
      action: 'navigate',
      url: currentUrl,
      title,
      domain: getDomain(currentUrl),
      message: currentUrl === trimmed ? 'Navigation completed.' : `Navigation completed after redirect to ${currentUrl}.`,
      textPreview,
    };
  } catch (error) {
    throw new Error(`browserNavigate failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function browserSnapshot(): Promise<BrowserSnapshotResult> {
  try {
    const page = await getActivePage();
    await waitForPageSettled(page);
    const [title, textContent, interactiveElements] = await Promise.all([
      page.title().catch(() => ''),
      extractVisibleText(page, SNAPSHOT_PREVIEW_LENGTH),
      collectInteractiveElements(page),
    ]);
    const url = page.url();

    return {
      ok: true,
      action: 'snapshot',
      url,
      title: normalizeWhitespace(title),
      domain: getDomain(url),
      message: `Collected ${interactiveElements.length} interactive elements.`,
      textPreview: textContent,
      textContent,
      interactiveElements,
    };
  } catch (error) {
    throw new Error(`browserSnapshot failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function browserClick(elementId: string): Promise<BrowserActionResult> {
  try {
    const page = await getActivePage();
    const handle = await ensureElementExists(page, elementId);
    await clickHandle(page, handle);
    return summarizeAfterAction(page, 'click', `Clicked ${elementId}.`);
  } catch (error) {
    throw new Error(`browserClick failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function browserType(
  elementId: string,
  text: string,
  options?: { clear?: boolean; submit?: boolean },
): Promise<BrowserActionResult> {
  const value = text ?? '';
  if (!value.length && !options?.clear) {
    throw new Error('browserType requires non-empty text unless clear=true');
  }

  try {
    const page = await getActivePage();
    const handle = await ensureElementExists(page, elementId);
    await scrollElementIntoView(handle);

    const targetInfo = await handle.evaluate((element) => {
      const htmlElement = element as HTMLElement;
      const tag = htmlElement.tagName.toLowerCase();
      const inputType = (htmlElement as HTMLInputElement).type || '';
      const isContentEditable = htmlElement.isContentEditable;
      const disabled =
        htmlElement.hasAttribute('disabled') ||
        htmlElement.getAttribute('aria-disabled') === 'true';
      return { tag, inputType, isContentEditable, disabled };
    });

    if (targetInfo.disabled) {
      throw new Error('Target element is disabled');
    }

    const isTextField =
      targetInfo.tag === 'textarea' ||
      targetInfo.isContentEditable ||
      targetInfo.tag === 'input';

    if (!isTextField) {
      throw new Error('Target element is not an input, textarea, or contenteditable field');
    }

    await handle.focus();

    if (options?.clear) {
      await handle.evaluate((element) => {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          element.value = '';
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
          return;
        }

        const htmlElement = element as HTMLElement;
        if (htmlElement.isContentEditable) {
          htmlElement.innerText = '';
          htmlElement.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
    }

    if (value) {
      await page.keyboard.type(value, { delay: 12 });
    }

    if (options?.submit) {
      await page.keyboard.press('Enter');
      await waitForPageSettled(page);
    }

    return summarizeAfterAction(page, 'type', `Typed into ${elementId}.`);
  } catch (error) {
    throw new Error(`browserType failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function browserScroll(
  direction: 'up' | 'down',
  amount = DEFAULT_SCROLL_AMOUNT,
): Promise<BrowserActionResult> {
  try {
    const page = await getActivePage();
    const delta = Math.max(80, Math.abs(amount)) * (direction === 'down' ? 1 : -1);
    await page.evaluate((scrollAmount) => {
      window.scrollBy({ top: scrollAmount, behavior: 'instant' });
    }, delta);
    return summarizeAfterAction(page, 'scroll', `Scrolled ${direction} by ${Math.abs(delta)}px.`);
  } catch (error) {
    throw new Error(`browserScroll failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function browserBack(): Promise<BrowserActionResult> {
  try {
    const page = await getActivePage();
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 2500 }).catch(() => null);
    return summarizeAfterAction(page, 'back', 'Navigated back.');
  } catch (error) {
    throw new Error(`browserBack failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function browserForward(): Promise<BrowserActionResult> {
  try {
    const page = await getActivePage();
    await page.goForward({ waitUntil: 'domcontentloaded', timeout: 2500 }).catch(() => null);
    return summarizeAfterAction(page, 'forward', 'Navigated forward.');
  } catch (error) {
    throw new Error(`browserForward failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function browserReload(): Promise<BrowserActionResult> {
  try {
    const page = await getActivePage();
    await page.reload({ waitUntil: 'domcontentloaded' });
    return summarizeAfterAction(page, 'reload', 'Reloaded the page.');
  } catch (error) {
    throw new Error(`browserReload failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function browserRead(): Promise<string> {
  try {
    const page = await getActivePage();
    const url = page.url();
    const title = normalizeWhitespace(await page.title().catch(() => ''));
    const text = await extractVisibleText(page, READ_PREVIEW_LENGTH);
    return [
      `URL: ${url}`,
      `TITLE: ${title || '[untitled]'}`,
      `DOMAIN: ${getDomain(url) || '[unknown]'}`,
      'CONTENT:',
      text || '[no readable text extracted]',
    ].join('\n\n');
  } catch (error) {
    throw new Error(`browserRead failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function browserScreenshot(options?: {
  fullPage?: boolean;
  path?: string;
}): Promise<BrowserScreenshotResult> {
  try {
    const page = await getActivePage();
    const targetPath = options?.path ? path.resolve(options.path) : buildTempScreenshotPath();
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    await page.screenshot({
      path: targetPath,
      fullPage: options?.fullPage ?? true,
    });

    const url = page.url();
    return {
      ok: true,
      action: 'screenshot',
      path: targetPath,
      screenshotUrl: getScreenshotUrl(targetPath),
      url,
      title: normalizeWhitespace(await page.title().catch(() => '')),
      domain: getDomain(url),
      message: `Saved screenshot to ${targetPath}.`,
    };
  } catch (error) {
    throw new Error(`browserScreenshot failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function browserLinks(): Promise<BrowserLinkResult[]> {
  try {
    const page = await getActivePage();
    const links = await page.evaluate((limit) => {
      const normalize = (value: string | null | undefined): string =>
        (value || '').replace(/\s+/g, ' ').trim();

      const seen = new Set<string>();
      const records: Array<{ text: string; href: string }> = [];

      for (const anchor of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
        const href = normalize(anchor.href);
        const text = normalize(anchor.innerText || anchor.textContent);
        if (!href || !text || seen.has(`${text}|${href}`)) {
          continue;
        }
        seen.add(`${text}|${href}`);
        records.push({ text, href });
        if (records.length >= limit) {
          break;
        }
      }

      return records;
    }, MAX_LINKS);

    return links
      .filter((link) => isHttpUrl(link.href))
      .map((link) => ({
        ...link,
        domain: getDomain(link.href),
      }));
  } catch (error) {
    throw new Error(`browserLinks failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function browserPress(key: string): Promise<BrowserActionResult> {
  const trimmed = normalizeWhitespace(key);
  if (!trimmed) {
    throw new Error('browserPress requires a key');
  }

  try {
    const page = await getActivePage();
    await page.keyboard.press(trimmed as KeyInput);
    return summarizeAfterAction(page, 'press', `Pressed ${trimmed}.`);
  } catch (error) {
    throw new Error(`browserPress failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function browserSelect(elementId: string, value: string): Promise<BrowserActionResult> {
  const selectedValue = value ?? '';
  if (!selectedValue) {
    throw new Error('browserSelect requires a value');
  }

  try {
    const page = await getActivePage();
    await ensureInteractiveSnapshot(page);
    const selector = `[data-agent-element-id="${normalizeWhitespace(elementId)}"]`;
    const handle = await page.$(selector);
    if (!handle) {
      throw new Error(`Element not found: ${elementId}. Run browserSnapshot() to refresh the page map.`);
    }

    const tag = await handle.evaluate((element) => element.tagName.toLowerCase());
    if (tag !== 'select') {
      throw new Error('Target element is not a select element');
    }

    await page.select(selector, selectedValue);
    return summarizeAfterAction(page, 'select', `Selected ${selectedValue} on ${elementId}.`);
  } catch (error) {
    throw new Error(`browserSelect failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function browserHover(elementId: string): Promise<BrowserActionResult> {
  try {
    const page = await getActivePage();
    const handle = await ensureElementExists(page, elementId);
    await scrollElementIntoView(handle);
    await handle.hover();
    return summarizeAfterAction(page, 'hover', `Hovered ${elementId}.`);
  } catch (error) {
    throw new Error(`browserHover failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function browserWaitForText(
  text: string,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
): Promise<BrowserActionResult> {
  const expectedText = normalizeWhitespace(text);
  if (!expectedText) {
    throw new Error('browserWaitForText requires non-empty text');
  }

  try {
    const page = await getActivePage();
    await page.waitForFunction(
      (needle) => {
        const bodyText = document.body?.innerText || document.body?.textContent || '';
        return bodyText.includes(needle);
      },
      { timeout: timeoutMs },
      expectedText,
    );
    return summarizeAfterAction(page, 'waitForText', `Found text: ${expectedText}.`);
  } catch (error) {
    throw new Error(`browserWaitForText failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

