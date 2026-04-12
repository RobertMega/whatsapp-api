import test from 'node:test'
import assert from 'node:assert/strict'

import { formatOfferMessage } from '../../src/bot/format-offer-message.js'

test('formatOfferMessage leaves the affiliate URL alone on its own line for WhatsApp preview detection', () => {
  const body = formatOfferMessage(
    {
      title: 'Notebook Gamer',
      price: 8999.9,
      currencyId: 'BRL',
    },
    'https://meli.la/1GHAQVQ',
  )

  assert.equal(body, [
    'Oferta: Notebook Gamer',
    'Preco: R$ 8.999,90',
    '',
    'https://meli.la/1GHAQVQ',
  ].join('\n'))
})
