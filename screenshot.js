const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Use stealth plugin to bypass bot detection
puppeteer.use(StealthPlugin());

const TARGET_URL = process.env.IDEABROWSER_TARGET_URL || 'https://www.ideabrowser.com/';
const LOGIN_URL = process.env.IDEABROWSER_LOGIN_URL || 'https://www.ideabrowser.com/login';
const LOGIN_EMAIL_SELECTOR = process.env.IDEABROWSER_EMAIL_SELECTOR;
const LOGIN_PASSWORD_SELECTOR = process.env.IDEABROWSER_PASSWORD_SELECTOR;
const LOGIN_SUBMIT_SELECTOR = process.env.IDEABROWSER_SUBMIT_SELECTOR;
const LOGIN_TRIGGER_SELECTOR = process.env.IDEABROWSER_LOGIN_TRIGGER_SELECTOR;
const LOGIN_TRIGGER_TEXT = process.env.IDEABROWSER_LOGIN_TRIGGER_TEXT || 'Sign in with Password';
const POST_LOGIN_SELECTOR = process.env.IDEABROWSER_POST_LOGIN_SELECTOR;
const IDEA_SELECTOR = process.env.IDEABROWSER_IDEA_SELECTOR;
const USER_DATA_DIR = process.env.IDEABROWSER_USER_DATA_DIR || path.join(os.tmpdir(), 'ideabrowser-profile');

const DEFAULT_EMAIL_SELECTORS = [
  'input[type="email"]',
  'input[name="email"]',
  'input[name="username"]',
  'input[id*="email"]',
  'input[autocomplete="email"]'
];
const DEFAULT_PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[name="password"]',
  'input[id*="password"]',
  'input[autocomplete="current-password"]'
];
const DEFAULT_SUBMIT_SELECTORS = [
  'button[type="submit"]',
  'button[name="submit"]',
  'input[type="submit"]'
];

async function findVisibleHandle(page, selector) {
  const handles = await page.$$(selector);
  for (const handle of handles) {
    const visible = await handle.evaluate(el => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        rect.width > 0 &&
        rect.height > 0
      );
    });
    if (visible) {
      return handle;
    }
    await handle.dispose();
  }
  return null;
}

async function waitForVisibleSelector(page, selector, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const handle = await findVisibleHandle(page, selector);
    if (handle) {
      return handle;
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return null;
}

async function resolveSelector(page, explicitSelector, fallbackSelectors, label) {
  const selectors = [
    ...(explicitSelector ? [explicitSelector] : []),
    ...fallbackSelectors.filter(selector => selector !== explicitSelector)
  ];

  for (const selector of selectors) {
    const handle = await waitForVisibleSelector(page, selector, 4000);
    if (handle) {
      await handle.dispose();
      return selector;
    }
  }
  throw new Error(
    `Could not find ${label} selector. Set IDEABROWSER_${label.toUpperCase()}_SELECTOR.`
  );
}

async function clickElement(page, selector, label) {
  const handle = await waitForVisibleSelector(page, selector, 15000);
  if (!handle) {
    throw new Error(`Could not resolve ${label} element for selector: ${selector}`);
  }

  try {
    await clickHandleWithMouse(page, handle);
  } finally {
    await handle.dispose();
  }
}

async function collectButtonsByText(page, text, options = {}) {
  const normalize = value => (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const wanted = normalize(text);
  const handles = await page.$$('button, [role="button"], a');
  const exact = [];
  const partial = [];

  for (const handle of handles) {
    const meta = await handle.evaluate(el => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return {
        text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(),
        type: el.getAttribute('type'),
        visible:
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          rect.width > 0 &&
          rect.height > 0
      };
    });

    if (!meta.visible) {
      await handle.dispose();
      continue;
    }

    if (options.preferNonSubmit && meta.type === 'submit') {
      await handle.dispose();
      continue;
    }

    const current = normalize(meta.text);
    if (current === wanted) {
      exact.push(handle);
    } else if (current.includes(wanted)) {
      partial.push(handle);
    } else {
      await handle.dispose();
    }
  }

  // Prefer later matches — Ideabrowser renders duplicate mobile/desktop login panels.
  return [...exact, ...partial].reverse();
}

async function clickHandleWithMouse(page, handle) {
  const box = await handle.boundingBox();
  if (!box) {
    throw new Error('Could not resolve bounding box for click target.');
  }
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 30 });
}

async function clickButtonByText(page, text, options = {}) {
  const matches = await collectButtonsByText(page, text, options);
  if (matches.length === 0) {
    throw new Error(`Could not find visible button with text: ${text}`);
  }

  try {
    await clickHandleWithMouse(page, matches[0]);
  } finally {
    for (const handle of matches) {
      await handle.dispose();
    }
  }
}

async function passwordFieldVisible(page, timeout = 2500) {
  try {
    await page.waitForFunction(() => {
      return [...document.querySelectorAll('input[type="password"]')].some(el => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return (
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          rect.width > 0 &&
          rect.height > 0
        );
      });
    }, { timeout });
    return true;
  } catch (error) {
    return false;
  }
}

async function dumpPageDebug(page, label) {
  const debugDir = path.join('archives', '_debug');
  if (!fs.existsSync(debugDir)) {
    fs.mkdirSync(debugDir, { recursive: true });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const screenshotPath = path.join(debugDir, `${stamp}-${label}.png`);
  const textPath = path.join(debugDir, `${stamp}-${label}.txt`);

  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
  } catch (error) {
    console.log(`Debug screenshot failed: ${error.message}`);
  }

  const details = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button, a, [role="button"]')].map(el => {
      const rect = el.getBoundingClientRect();
      return {
        text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        type: el.getAttribute('type'),
        href: el.getAttribute('href'),
        w: Math.round(rect.width),
        h: Math.round(rect.height)
      };
    });
    return {
      url: location.href,
      title: document.title,
      bodyText: (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 4000),
      buttons
    };
  }).catch(error => ({ error: error.message }));

  fs.writeFileSync(textPath, JSON.stringify(details, null, 2));
  console.log(`Saved debug artifacts: ${screenshotPath} and ${textPath}`);
}

async function waitForLoginUi(page) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const normalize = value => (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const buttons = [...document.querySelectorAll('button')].map(el => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return {
          text: normalize(el.innerText || el.textContent || ''),
          type: el.getAttribute('type'),
          visible:
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rect.width > 0 &&
            rect.height > 0
        };
      });
      const body = normalize(document.body ? document.body.innerText : '');
      return {
        url: location.href,
        hasWelcome: body.includes('welcome back'),
        hasPasswordTrigger: buttons.some(
          button => button.visible && button.text.includes('sign in with password') && button.type !== 'submit'
        ),
        hasPasswordInput: [...document.querySelectorAll('input[type="password"]')].some(el => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }),
        title: document.title,
        buttonSample: buttons.filter(b => b.visible).slice(0, 12)
      };
    });

    console.log(
      `Login UI poll: url=${state.url} welcome=${state.hasWelcome} trigger=${state.hasPasswordTrigger} passwordInput=${state.hasPasswordInput}`
    );

    if (state.hasPasswordInput || state.hasPasswordTrigger) {
      return state;
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  await dumpPageDebug(page, 'login-ui-timeout');
  throw new Error('Timed out waiting for Ideabrowser login UI to appear.');
}

async function openPasswordLogin(page) {
  const ui = await waitForLoginUi(page);

  if (ui.hasPasswordInput || (await passwordFieldVisible(page, 500))) {
    console.log('Password form already visible.');
    return;
  }

  if (LOGIN_TRIGGER_SELECTOR) {
    try {
      console.log(`Triggering login form via selector: ${LOGIN_TRIGGER_SELECTOR}`);
      await clickElement(page, LOGIN_TRIGGER_SELECTOR, 'login trigger');
      if (await passwordFieldVisible(page)) {
        return;
      }
    } catch (error) {
      console.log(`Login trigger selector failed (${error.message}); trying text fallback.`);
    }
  }

  console.log(`Triggering password login via button text: ${LOGIN_TRIGGER_TEXT}`);
  const triggerButtons = await collectButtonsByText(page, LOGIN_TRIGGER_TEXT, {
    preferNonSubmit: true
  });
  if (triggerButtons.length === 0) {
    await dumpPageDebug(page, 'missing-password-trigger');
    throw new Error(`Could not find visible button with text: ${LOGIN_TRIGGER_TEXT}`);
  }

  let opened = false;
  for (const [index, handle] of triggerButtons.entries()) {
    console.log(`Trying password-login trigger candidate ${index + 1}/${triggerButtons.length}...`);
    try {
      await clickHandleWithMouse(page, handle);
    } catch (error) {
      console.log(`Candidate ${index + 1} click failed: ${error.message}`);
      continue;
    }
    if (await passwordFieldVisible(page)) {
      opened = true;
      break;
    }
  }

  for (const handle of triggerButtons) {
    await handle.dispose();
  }

  if (!opened) {
    await dumpPageDebug(page, 'password-form-missing');
    throw new Error('Password form did not appear after clicking login trigger.');
  }
}

async function loginIfNeeded(page) {
  const email = process.env.IDEABROWSER_EMAIL;
  const password = process.env.IDEABROWSER_PASSWORD;

  if (!email || !password) {
    console.log('Login skipped: IDEABROWSER_EMAIL or IDEABROWSER_PASSWORD not set.');
    return;
  }

  console.log('Navigating to login page...');
  await page.goto(LOGIN_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });
  // Give the SPA time to hydrate after first paint.
  await new Promise(resolve => setTimeout(resolve, 3000));

  try {
    await openPasswordLogin(page);
  } catch (error) {
    await dumpPageDebug(page, 'login-failed');
    throw error;
  }

  const emailSelector = await resolveSelector(
    page,
    LOGIN_EMAIL_SELECTOR,
    DEFAULT_EMAIL_SELECTORS,
    'email'
  );
  const passwordSelector = await resolveSelector(
    page,
    LOGIN_PASSWORD_SELECTOR,
    DEFAULT_PASSWORD_SELECTORS,
    'password'
  );

  console.log('Filling login form...');
  const emailHandle = await findVisibleHandle(page, emailSelector);
  const passwordHandle = await findVisibleHandle(page, passwordSelector);
  if (!emailHandle || !passwordHandle) {
    throw new Error('Could not resolve visible email/password inputs after opening password login.');
  }

  await emailHandle.click({ clickCount: 3 });
  await emailHandle.type(email, { delay: 20 });
  await passwordHandle.click({ clickCount: 3 });
  await passwordHandle.type(password, { delay: 20 });
  await emailHandle.dispose();
  await passwordHandle.dispose();

  console.log('Submitting login form...');
  const navigation = page
    .waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 })
    .catch(() => null);

  try {
    if (LOGIN_SUBMIT_SELECTOR) {
      await clickElement(page, LOGIN_SUBMIT_SELECTOR, 'submit');
    } else {
      // Prefer the password submit button; avoid the magic-link submit.
      await clickButtonByText(page, 'Sign in with Password');
    }
  } catch (error) {
    console.log(`Submit click failed (${error.message}); trying Enter key...`);
    const passwordField = await findVisibleHandle(page, passwordSelector);
    if (passwordField) {
      await passwordField.focus();
      await passwordField.dispose();
    }
    await page.keyboard.press('Enter');
  }

  await navigation;

  if (POST_LOGIN_SELECTOR) {
    console.log('Waiting for post-login element...');
    await page.waitForSelector(POST_LOGIN_SELECTOR, { timeout: 20000 });
  }

  console.log('Login step finished.');
}

(async () => {
  let browser;
  try {
    // Create date-based folder structure (year/month only)
    const now = new Date();
    const year = now.getFullYear();
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'];
    const monthName = monthNames[now.getMonth()];
    const day = now.getDate();

    const archiveDir = path.join('archives', String(year), monthName);

    // Create directory if it doesn't exist
    if (!fs.existsSync(archiveDir)) {
      fs.mkdirSync(archiveDir, { recursive: true });
    }

    // Generate filename in format "14 July 2025.png"
    const filename = `${day} ${monthName} ${year}.png`;
    const filePath = path.join(archiveDir, filename);

    console.log(`Capturing Idea of the Day to: ${filePath}`);

    // Launch browser with required settings and stealth mode
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      // Use a stable profile directory to avoid Windows temp cleanup locks.
      userDataDir: USER_DATA_DIR,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ]
    });

    const page = await browser.newPage();

    // Set realistic user agent
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );

    // Set extra HTTP headers to appear more like a real browser.
    // Avoid overriding Accept-Encoding — Puppeteer/Chromium manage compression.
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9'
    });

    // Configure viewport settings
    await page.setViewport({
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1
    });

    await loginIfNeeded(page);

    // Navigate to target page
    console.log(`Navigating to ${TARGET_URL}...`);
    await page.goto(TARGET_URL, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    if (IDEA_SELECTOR) {
      console.log('Waiting for idea section...');
      await page.waitForSelector(IDEA_SELECTOR, { timeout: 20000 });
    }

    // Wait a moment for everything to load
    console.log('Waiting for page to fully load...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Take a simple full page screenshot
    console.log('Taking screenshot...');
    await page.screenshot({
      path: filePath,
      fullPage: true,
      type: 'png'
    });

    console.log(`✅ Screenshot saved successfully to: ${filePath}`);

  } catch (error) {
    console.error('❌ An error occurred:', error.message);
    throw error;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
})().catch(error => {
  console.error('❌ Script failed:', error);
  process.exit(1);
});
