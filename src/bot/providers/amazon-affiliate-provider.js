import { existsSync } from 'fs'

function normalizeTag(tag) {
  return tag?.trim().replace(/[.,;:]+$/, '') || ''
}

function extractAsin(item = {}) {
  const id = typeof item.id === 'string' ? item.id.trim() : ''

  if (/^[A-Z0-9]{10}$/i.test(id)) {
    return id.toUpperCase()
  }

  const permalink = typeof item.permalink === 'string' ? item.permalink : ''
  const match = permalink.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)
  return match?.[1]?.toUpperCase() || id
}

function normalizeProductUrl(item = {}) {
  const asin = extractAsin(item)

  if (asin && /^[A-Z0-9]{10}$/i.test(asin)) {
    return `https://www.amazon.com.br/dp/${asin}`
  }

  try {
    const url = new URL(item.permalink)
    url.hash = ''
    url.search = ''
    return url.toString()
  } catch {
    return item.permalink || ''
  }
}

function applyTemplate(template, item, tag) {
  const productUrl = normalizeProductUrl(item)
  const asin = extractAsin(item)

  return template
    .replaceAll('{{url}}', encodeURIComponent(productUrl))
    .replaceAll('{{id}}', encodeURIComponent(item.id || asin || ''))
    .replaceAll('{{asin}}', encodeURIComponent(asin || ''))
    .replaceAll('{{tag}}', encodeURIComponent(tag))
}

function hasAffiliateTag(url, tag) {
  try {
    const parsed = new URL(url)
    return parsed.searchParams.get('tag') === tag || url.includes(`tag=${encodeURIComponent(tag)}`)
  } catch {
    return url.includes(`tag=${encodeURIComponent(tag)}`)
  }
}

function buildResult(url, {
  source = 'affiliate',
  usedFallback = false,
  fallbackReason,
  productUrl,
  rawText,
} = {}) {
  return {
    url,
    source,
    usedFallback,
    ...(fallbackReason ? { fallbackReason } : {}),
    ...(productUrl ? { productUrl } : {}),
    ...(rawText ? { rawText } : {}),
  }
}

async function loadPlaywright(playwrightModule) {
  if (playwrightModule) {
    return playwrightModule
  }

  try {
    return await import('playwright')
  } catch (error) {
    throw new Error(`Playwright is not installed for the Amazon Associates runtime: ${error.message}`)
  }
}

function chooseAssociatesLink(result, linkFormat) {
  if (linkFormat === 'full') {
    return result.fullUrl || result.shortUrl || ''
  }

  return result.shortUrl || result.fullUrl || ''
}

export function extractAssociatesLinksFromTexts(values = []) {
  const normalizedValues = values
    .map((value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''))
    .filter(Boolean)
  const rawText = normalizedValues.find((value) => /link de texto|amzn\.to|tag=/i.test(value)) || normalizedValues[0] || ''
  const shortMatch = normalizedValues
    .map((value) => value.match(/https?:\/\/amzn\.to\/([A-Za-z0-9]{6,8})(?=Link\b|link\b|$|[^A-Za-z0-9])/))
    .find(Boolean)
  const fullMatch = normalizedValues
    .map((value) => value.match(/https?:\/\/(?:www\.)?amazon\.com\.br\/[^\s"']*tag=[^\s"']+/))
    .find(Boolean)

  return {
    rawText,
    shortUrl: shortMatch ? `https://amzn.to/${shortMatch[1]}` : '',
    fullUrl: fullMatch?.[0] || '',
  }
}

async function clickFirstAvailable(page, locators) {
  for (const locator of locators) {
    const count = await locator.count().catch(() => 0)
    if (!count) {
      continue
    }

    await locator.first().click().catch(() => {})
    return true
  }

  return false
}

export async function createAmazonAssociatesLinkSession({
  playwrightModule,
  storageStatePath = process.env.AMAZON_PLAYWRIGHT_STORAGE_STATE_PATH || './sessions/amazon-storage-state.json',
  userDataDir = process.env.AMAZON_PLAYWRIGHT_USER_DATA_DIR || './sessions/amazon-profile',
  headless = process.env.AMAZON_PLAYWRIGHT_HEADLESS !== 'false',
  channel = process.env.AMAZON_PLAYWRIGHT_CHANNEL || 'chrome',
  executablePath = process.env.AMAZON_PLAYWRIGHT_EXECUTABLE_PATH || '',
  timeoutMs = Number.parseInt(process.env.AMAZON_PLAYWRIGHT_TIMEOUT_MS || '30000', 10),
  logger = console,
} = {}) {
  const playwright = await loadPlaywright(playwrightModule)
  const launchOptions = {
    headless,
    channel: channel || undefined,
    executablePath: executablePath || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  }

  let browser
  let context

  if (storageStatePath && existsSync(storageStatePath)) {
    browser = await playwright.chromium.launch(launchOptions)
    context = await browser.newContext({ storageState: storageStatePath })
  } else if (userDataDir) {
    context = await playwright.chromium.launchPersistentContext(userDataDir, launchOptions)
  } else {
    browser = await playwright.chromium.launch(launchOptions)
    context = await browser.newContext(
      storageStatePath && existsSync(storageStatePath)
        ? { storageState: storageStatePath }
        : undefined,
    )
  }

  const page = context.pages()[0] || (await context.newPage())
  page.setDefaultTimeout(timeoutMs)

  return {
    async createLink({ productUrl }) {
      await page.goto(productUrl, { waitUntil: 'domcontentloaded' })
      await page.waitForLoadState('networkidle').catch(() => {})

      const sitestripeVisible = await Promise.any([
        page.locator('#amzn-ss-text-link, #amzn-ss-get-link-button, [id*="amzn-ss"]').first().waitFor({ state: 'visible', timeout: 5000 }).then(() => true),
        page.getByText(/SiteStripe|Link de texto|Obter link/i).first().waitFor({ state: 'visible', timeout: 5000 }).then(() => true),
      ]).catch(() => false)

      if (!sitestripeVisible) {
        throw new Error('Amazon SiteStripe did not load on the product page.')
      }

      logger.info?.({
        event: 'sitestripe_detected',
        productUrl,
      })

      const clickedGetLink = await clickFirstAvailable(page, [
        page.getByRole('button', { name: /obter link|get link/i }),
        page.locator('#amzn-ss-get-link-button'),
        page.locator('button, input[type="button"], a').filter({ hasText: /obter link|get link/i }),
        page.locator('#amzn-ss-text-link'),
        page.getByText(/link de texto|texto|text/i),
      ])

      if (!clickedGetLink) {
        throw new Error('Amazon SiteStripe get link button was not found.')
      }

      logger.info?.({
        event: 'clicked_get_link',
        productUrl,
      })

      const popupOpened = await page.getByText(/Link de texto para esta p[aá]gina|Link de texto criado|Copie o link gerado/i)
        .first()
        .waitFor({ state: 'visible', timeout: 10000 })
        .then(() => true)
        .catch(() => false)

      if (!popupOpened) {
        throw new Error('Amazon Associates text link popup did not open.')
      }

      logger.info?.({
        event: 'affiliate_popup_opened',
        productUrl,
      })

      await page.waitForTimeout(1000)

      const values = await page.evaluate(() => {
        const values = []
        for (const element of document.querySelectorAll('input, textarea, a, span, div')) {
          const value =
            element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
              ? element.value
              : element instanceof HTMLAnchorElement
                ? element.href || element.textContent
                : element.textContent
          const text = value?.replace(/\s+/g, ' ').trim()
          if (text && /amzn\.to|tag=/.test(text)) {
            values.push(text)
          }
        }

        return values
      })
      const result = extractAssociatesLinksFromTexts(values)

      return {
        productUrl,
        ...result,
      }
    },
    async close() {
      if (storageStatePath) {
        await context.storageState({ path: storageStatePath }).catch(() => {})
      }
      await context.close()
      if (browser) {
        await browser.close()
      }
    },
  }
}

export function createAmazonAffiliateProvider({
  tag = process.env.AMAZON_AFFILIATE_TAG || '',
  templateUrl = process.env.AMAZON_AFFILIATE_URL_TEMPLATE || '',
  linkFormat = process.env.AMAZON_AFFILIATE_LINK_FORMAT || 'short',
  createAssociatesLinkSession = createAmazonAssociatesLinkSession,
  storageStatePath = process.env.AMAZON_PLAYWRIGHT_STORAGE_STATE_PATH || './sessions/amazon-storage-state.json',
  userDataDir = process.env.AMAZON_PLAYWRIGHT_USER_DATA_DIR || './sessions/amazon-profile',
  headless = process.env.AMAZON_PLAYWRIGHT_HEADLESS !== 'false',
  channel = process.env.AMAZON_PLAYWRIGHT_CHANNEL || 'chrome',
  executablePath = process.env.AMAZON_PLAYWRIGHT_EXECUTABLE_PATH || '',
  timeoutMs = Number.parseInt(process.env.AMAZON_PLAYWRIGHT_TIMEOUT_MS || '30000', 10),
  logger = console,
} = {}) {
  const normalizedTag = normalizeTag(tag)
  let sessionPromise

  async function getSession() {
    if (!sessionPromise) {
      sessionPromise = createAssociatesLinkSession({
        storageStatePath,
        userDataDir,
        headless,
        channel,
        executablePath,
        timeoutMs,
        logger,
      })
    }

    return sessionPromise
  }

  return {
    async getAffiliateLink(item) {
      const productUrl = normalizeProductUrl(item)

      if (templateUrl) {
        const affiliateUrl = applyTemplate(templateUrl, item, normalizedTag)
        if (normalizedTag && hasAffiliateTag(affiliateUrl, normalizedTag)) {
          logger.info?.({
            event: 'amazon_affiliate_link_generated',
            itemId: item.id,
            productUrl,
            affiliateLink: affiliateUrl,
            source: 'template',
            usedFallback: false,
          })
          return buildResult(affiliateUrl, { source: 'template', productUrl })
        }
      }

      try {
        const session = await getSession()
        const associatesResult = await session.createLink({ productUrl, item })
        const affiliateUrl = chooseAssociatesLink(associatesResult, linkFormat)

        if (!affiliateUrl) {
          throw new Error('Amazon Associates popup did not return a usable affiliate link.')
        }

        logger.info?.({
          event: 'amazon_affiliate_link_generated',
          itemId: item.id,
          productUrl,
          affiliateLink: affiliateUrl,
          rawText: associatesResult.rawText || null,
          linkFormat,
          source: 'associates_popup',
          usedFallback: false,
        })

        logger.info?.({
          event: 'affiliate_link_captured',
          itemId: item.id,
          productUrl,
          affiliateLink: affiliateUrl,
          rawText: associatesResult.rawText || null,
        })

        logger.info?.({
          event: 'affiliate_link_mode',
          itemId: item.id,
          mode: linkFormat,
          selectedLink: affiliateUrl,
        })

        return buildResult(affiliateUrl, {
          source: 'associates_popup',
          productUrl,
          rawText: associatesResult.rawText,
        })
      } catch (error) {
        logger.warn?.({
          event: 'affiliate_link_fallback_used',
          itemId: item.id,
          productUrl,
          fallbackReason: error.message,
        })

        return buildResult(productUrl, {
          source: 'permalink',
          usedFallback: true,
          fallbackReason: error.message,
          productUrl,
        })
      }
    },
    async close() {
      if (!sessionPromise) {
        return
      }

      try {
        const session = await sessionPromise
        await session.close?.()
      } catch {
      } finally {
        sessionPromise = undefined
      }
    },
  }
}
