import test from 'node:test'
import assert from 'node:assert/strict'

import { assertAmazonConfig, getAmazonConfig } from '../../src/config/amazon.js'

test('amazon config reads env values and defaults isolated session paths', () => {
  const originalEnv = { ...process.env }

  process.env.AMAZON_ENABLED = 'true'
  process.env.AMAZON_SITE_ID = 'AMAZON'
  process.env.AMAZON_SEARCH_TERMS = 'alexa promocao, echo dot oferta'
  process.env.AMAZON_POSTS_PER_RUN = '3'
  process.env.AMAZON_POST_INTERVAL_MINUTES = '8'
  process.env.AMAZON_MAX_PAGES_PER_FILTER = '7'
  process.env.AMAZON_MIN_DELAY_MS = '100'
  process.env.AMAZON_MAX_DELAY_MS = '200'
  process.env.AMAZON_AFFILIATE_TAG = 'tag-20'
  process.env.AMAZON_AFFILIATE_LINK_FORMAT = 'full'
  process.env.AMAZON_API_PORT = '3001'
  process.env.AMAZON_API_URL = 'http://localhost:3001'

  try {
    const config = getAmazonConfig()

    assert.equal(config.enabled, true)
    assert.equal(config.siteId, 'AMAZON')
    assert.deepEqual(config.searchTerms, ['alexa promocao', 'echo dot oferta'])
    assert.equal(config.postsPerRun, 3)
    assert.equal(config.postIntervalMinutes, 8)
    assert.equal(config.maxPagesPerFilter, 7)
    assert.equal(config.minDelayMs, 100)
    assert.equal(config.maxDelayMs, 200)
    assert.equal(config.affiliate.tag, 'tag-20')
    assert.equal(config.affiliate.linkFormat, 'full')
    assert.equal(config.playwright.userDataDir, './sessions/amazon-profile')
    assert.equal(config.playwright.storageStatePath, './sessions/amazon-storage-state.json')
    assert.equal(config.api.port, 3001)
    assert.equal(config.api.url, 'http://localhost:3001')
  } finally {
    process.env = originalEnv
  }
})

test('amazon config validation only requires search terms and tag when enabled', () => {
  assert.doesNotThrow(() => assertAmazonConfig({
    enabled: false,
    searchTerms: [],
    affiliate: { tag: '' },
  }))

  assert.throws(
    () => assertAmazonConfig({
      enabled: true,
      searchTerms: [],
      affiliate: { tag: '' },
    }),
    /AMAZON_SEARCH_TERMS, AMAZON_AFFILIATE_TAG/,
  )
})
