import { createInterface } from 'node:readline/promises'
import process from 'node:process'

import { chromium } from 'playwright'

import { loadEnv } from '../lib/load-env.js'
import { getBotConfig } from './config.js'

function isLoginUrl(url) {
  return /\/lgz\/|\/login/.test(url)
}

loadEnv()

const { affiliate } = getBotConfig()

if (!affiliate.userDataDir) {
  throw new Error(
    'Set ML_AFFILIATE_PLAYWRIGHT_USER_DATA_DIR before running the affiliate login bootstrap.',
  )
}

const launchOptions = {
  headless: false,
}

if (affiliate.channel) {
  launchOptions.channel = affiliate.channel
}

if (affiliate.executablePath) {
  launchOptions.executablePath = affiliate.executablePath
}

if (affiliate.userAgent) {
  launchOptions.userAgent = affiliate.userAgent
}

const context = await chromium.launchPersistentContext(affiliate.userDataDir, launchOptions)
const page = context.pages()[0] || (await context.newPage())
const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
})

try {
  await page.goto(affiliate.hubUrl, { waitUntil: 'domcontentloaded' })

  process.stdout.write(
    '\nFaça o login manual no navegador aberto. Depois volte ao terminal e pressione Enter.\n\n',
  )
  await rl.question('')

  await page.goto(affiliate.hubUrl, { waitUntil: 'networkidle' })

  if (isLoginUrl(page.url())) {
    throw new Error('Login was not completed for the affiliate profile.')
  }

  if (affiliate.storageStatePath) {
    await context.storageState({
      path: affiliate.storageStatePath,
      indexedDB: true,
    })
  }

  process.stdout.write(`Sessão de afiliado salva em ${affiliate.userDataDir}\n`)
} finally {
  rl.close()
  await context.close()
}
