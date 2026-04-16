import test from 'node:test'
import assert from 'node:assert/strict'

import { createAmazonAffiliateProvider } from '../../src/bot/providers/amazon-affiliate-provider.js'
import {
  createAmazonAssociatesLinkSession,
  extractAssociatesLinksFromTexts,
} from '../../src/bot/providers/amazon-affiliate-provider.js'

test('amazon affiliate provider falls back to canonical product url when Associates generation fails', async () => {
  const provider = createAmazonAffiliateProvider({
    tag: 'minhatag-20',
    createAssociatesLinkSession: async () => ({
      async createLink() {
        throw new Error('popup unavailable')
      },
      async close() {},
    }),
  })

  const result = await provider.getAffiliateLink({
    id: 'B0ABC12345',
    permalink: 'https://www.amazon.com.br/Echo-Dot-5a-Geracao/dp/B0ABC12345/ref=something?pd_rd_w=abc',
  })

  assert.deepEqual(result, {
    url: 'https://www.amazon.com.br/dp/B0ABC12345',
    source: 'permalink',
    usedFallback: true,
    fallbackReason: 'popup unavailable',
    productUrl: 'https://www.amazon.com.br/dp/B0ABC12345',
  })
})

test('amazon affiliate provider prioritizes the short amzn.to link captured from Associates popup', async () => {
  const logs = []
  const provider = createAmazonAffiliateProvider({
    tag: 'minhatag-20',
    linkFormat: 'short',
    createAssociatesLinkSession: async () => ({
      async createLink({ productUrl }) {
        return {
          productUrl,
          shortUrl: 'https://amzn.to/4sHAqQP',
          fullUrl: `${productUrl}?tag=minhatag-20`,
          rawText: 'Link de texto para esta página https://amzn.to/4sHAqQP',
        }
      },
      async close() {},
    }),
    logger: {
      info(payload) {
        logs.push(payload)
      },
      warn(payload) {
        logs.push(payload)
      },
    },
  })

  const result = await provider.getAffiliateLink({
    id: 'B0ABC12345',
    permalink: 'https://www.amazon.com.br/dp/B0ABC12345',
  })

  assert.deepEqual(result, {
    url: 'https://amzn.to/4sHAqQP',
    source: 'associates_popup',
    usedFallback: false,
    productUrl: 'https://www.amazon.com.br/dp/B0ABC12345',
    rawText: 'Link de texto para esta página https://amzn.to/4sHAqQP',
  })
  assert.equal(logs.some((payload) => payload.event === 'amazon_affiliate_link_generated' && payload.affiliateLink === 'https://amzn.to/4sHAqQP'), true)
})

test('amazon affiliate provider uses the full Associates link when configured', async () => {
  const provider = createAmazonAffiliateProvider({
    tag: 'minhatag-20',
    linkFormat: 'full',
    createAssociatesLinkSession: async () => ({
      async createLink({ productUrl }) {
        return {
          productUrl,
          shortUrl: 'https://amzn.to/4sHAqQP',
          fullUrl: `${productUrl}?tag=minhatag-20&linkCode=ll1`,
        }
      },
      async close() {},
    }),
  })

  const result = await provider.getAffiliateLink({
    id: 'B0ABC12345',
    permalink: 'https://www.amazon.com.br/dp/B0ABC12345',
  })

  assert.equal(result.url, 'https://www.amazon.com.br/dp/B0ABC12345?tag=minhatag-20&linkCode=ll1')
})

test('amazon associates link session uses storage state context instead of persistent profile when storage state exists', async () => {
  const calls = []
  const session = await createAmazonAssociatesLinkSession({
    storageStatePath: 'sessions/amazon-storage-state.json',
    userDataDir: './sessions/amazon-profile',
    playwrightModule: {
      chromium: {
        async launchPersistentContext() {
          throw new Error('should not open persistent profile when storage state exists')
        },
        async launch(options) {
          calls.push({ type: 'launch', options })
          return {
            async newContext(options) {
              calls.push({ type: 'newContext', options })
              return {
                pages() {
                  return [{
                    setDefaultTimeout() {},
                    async goto() {},
                    async waitForLoadState() {},
                    async waitForTimeout() {},
                    locator() {
                      return { async count() { return 1 }, first() { return this }, filter() { return this }, async click() {}, async waitFor() {} }
                    },
                    getByText() {
                      return { async count() { return 1 }, first() { return this }, async click() {}, async waitFor() {} }
                    },
                    getByRole() {
                      return { async count() { return 1 }, first() { return this }, async click() {}, async waitFor() {} }
                    },
                    async evaluate() {
                      return ['Link de texto para esta página https://amzn.to/4sHAqQP']
                    },
                  }]
                },
                async storageState() {},
                async close() {},
              }
            },
            async close() {},
          }
        },
      },
    },
  })

  const result = await session.createLink({ productUrl: 'https://www.amazon.com.br/dp/B0ABC12345' })
  await session.close()

  assert.equal(result.shortUrl, 'https://amzn.to/4sHAqQP')
  assert.equal(calls[1].type, 'newContext')
  assert.deepEqual(calls[1].options, { storageState: 'sessions/amazon-storage-state.json' })
})

test('extractAssociatesLinksFromTexts does not include adjacent UI labels in amzn.to short links', () => {
  const result = extractAssociatesLinksFromTexts([
    'Link de texto criado abaixo. https://amzn.to/4tePl63Link type selection Link curto Link completo',
  ])

  assert.equal(result.shortUrl, 'https://amzn.to/4tePl63')
  assert.equal(result.rawText.includes('Link de texto'), true)
})

test('amazon affiliate provider uses the template and validates the tag', async () => {
  const provider = createAmazonAffiliateProvider({
    tag: 'minhatag-20',
    templateUrl: 'https://amzn.to/link?u={{url}}&asin={{asin}}&tag={{tag}}',
    createAssociatesLinkSession: async () => {
      throw new Error('should not use associates when valid template exists')
    },
  })

  const result = await provider.getAffiliateLink({
    id: 'B0ABC123',
    permalink: 'https://www.amazon.com.br/dp/B0ABC123',
  })

  assert.equal(
    result.url,
    'https://amzn.to/link?u=https%3A%2F%2Fwww.amazon.com.br%2Fdp%2FB0ABC123&asin=B0ABC123&tag=minhatag-20',
  )
  assert.equal(result.usedFallback, false)
})

test('amazon affiliate provider falls back to the product url and logs when tag validation fails', async () => {
  const warnings = []
  const provider = createAmazonAffiliateProvider({
    tag: 'minhatag-20',
    templateUrl: 'https://amzn.to/link?u={{url}}',
    createAssociatesLinkSession: async () => ({
      async createLink() {
        throw new Error('popup unavailable')
      },
      async close() {},
    }),
    logger: {
      warn(payload) {
        warnings.push(payload)
      },
    },
  })

  const result = await provider.getAffiliateLink({
    id: 'B0ABC123',
    permalink: 'https://www.amazon.com.br/dp/B0ABC123?ref_=abc',
  })

  assert.deepEqual(result, {
    url: 'https://www.amazon.com.br/dp/B0ABC123',
    source: 'permalink',
    usedFallback: true,
    fallbackReason: 'popup unavailable',
    productUrl: 'https://www.amazon.com.br/dp/B0ABC123',
  })
  assert.equal(warnings[0].event, 'affiliate_link_fallback_used')
  assert.equal(warnings[0].itemId, 'B0ABC123')
})
