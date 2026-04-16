import test from 'node:test'
import assert from 'node:assert/strict'

import { createPrismaBotRepository } from '../../src/bot/repositories/prisma-bot-repository.js'

test('markStaleExecutionsAsFailed marks unfinished running executions as failed', async () => {
  const updateManyCalls = []
  const now = new Date('2026-04-14T02:20:00.000Z')

  const repository = createPrismaBotRepository({
    prismaClient: {
      postingExecution: {
        async updateMany(payload) {
          updateManyCalls.push(payload)
          return { count: 2 }
        },
      },
    },
  })

  const result = await repository.markStaleExecutionsAsFailed({ now })

  assert.equal(result.count, 2)
  assert.equal(updateManyCalls.length, 1)
  assert.deepEqual(updateManyCalls[0], {
    where: {
      status: 'running',
      finishedAt: null,
    },
    data: {
      status: 'failed',
      errorMessage: 'Execution interrupted before completion',
      finishedAt: now,
    },
  })
})
