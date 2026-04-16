import { formatOfferMessage } from './format-offer-message.js'
import { buildPostingBatchItemKey, createPostingBatchSelector } from './select-posting-batch.js'

function withTimeout(operation, timeoutMs, label) {
  if (!(timeoutMs > 0)) {
    return operation()
  }

  let timeoutId

  return Promise.race([
    operation(),
    new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
    }),
  ]).finally(() => {
    clearTimeout(timeoutId)
  })
}

function normalizeCatalogSearchResult(result, filters) {
  if (Array.isArray(result)) {
    return {
      termsProcessed: filters.length,
      rawItemsFound: result.length,
      items: result,
    }
  }

  return {
    termsProcessed: result?.termsProcessed ?? filters.length,
    rawItemsFound: result?.rawItemsFound ?? result?.items?.length ?? 0,
    items: Array.isArray(result?.items) ? result.items : [],
  }
}

function normalizeAffiliateLinkResult(result) {
  if (typeof result === 'string') {
    return {
      url: result,
      source: 'affiliate',
      usedFallback: false,
    }
  }

  return {
    url: result?.url ?? '',
    source: result?.source ?? 'affiliate',
    usedFallback: Boolean(result?.usedFallback),
    fallbackReason: result?.fallbackReason,
  }
}

function rotateItems(items = [], startIndex = 0) {
  if (!items.length) {
    return []
  }

  const normalizedStartIndex = startIndex % items.length
  return [
    ...items.slice(normalizedStartIndex),
    ...items.slice(0, normalizedStartIndex),
  ]
}

function getNextFilterStartIndex(currentIndex, filterCount, postsPerRun) {
  if (!filterCount) {
    return 0
  }

  return (currentIndex + Math.max(1, postsPerRun)) % filterCount
}

export function createBotRunner({
  config,
  catalogProvider,
  affiliateProvider,
  offerImageBuilder,
  linkPreviewBuilder,
  whatsappClient,
  repository,
  logger = console,
  batchSelector = createPostingBatchSelector(),
}) {
  let isRunning = false
  let nextFilterStartIndex = 0

  return {
    async runOnce() {
      if (isRunning) {
        return { skipped: true, reason: 'already_running' }
      }

      isRunning = true

      const execution = await repository.createExecution({
        status: 'running',
        startedAt: new Date(),
      })

      let sentCount = 0
      let skippedDuplicates = 0

      try {
        const filtersForRun = rotateItems(config.filters, nextFilterStartIndex)
        nextFilterStartIndex = getNextFilterStartIndex(
          nextFilterStartIndex,
          filtersForRun.length,
          config.postsPerRun,
        )

        const searchResult = normalizeCatalogSearchResult(await withTimeout(
          () => catalogProvider.search(filtersForRun, {
            targetItemCount: config.postsPerRun,
            isRecentlyPublished: async (item) => repository.hasPublishedItem(buildPostingBatchItemKey(item)),
          }),
          config.catalogSearchTimeoutMs ?? 180000,
          'Bot catalog search',
        ), filtersForRun)
        const batch = await batchSelector.select({
          filters: filtersForRun,
          items: searchResult.items,
          postsPerRun: config.postsPerRun,
          isRecentlyPublished: async (item) => repository.hasPublishedItem(buildPostingBatchItemKey(item)),
        })

        skippedDuplicates = batch.historyBlocked

        logger.info?.({
          event: 'bot_posting_batch_built',
          executionId: execution.id,
          termsProcessed: batch.termsProcessed ?? searchResult.termsProcessed,
          rawItemsFound: batch.rawItemsFound ?? searchResult.rawItemsFound,
          duplicatesRemoved: batch.duplicatesRemoved,
          historyBlocked: batch.historyBlocked,
          selectedCount: batch.selectedItems.length,
        })

        logger.info?.({
          event: 'bot_posting_batch_selected',
          executionId: execution.id,
          items: batch.selectedItems.map((item) => ({
            itemId: buildPostingBatchItemKey(item),
            title: item.title,
            sourceFilter: item.sourceFilter ?? null,
          })),
        })

        for (const item of batch.selectedItems) {
          if (sentCount >= config.postsPerRun) {
            break
          }

          try {
            const affiliateLinkResult = normalizeAffiliateLinkResult(await withTimeout(
              () => affiliateProvider.getAffiliateLink(item),
              config.offerProcessingTimeoutMs ?? 45000,
              `Bot offer processing for ${buildPostingBatchItemKey(item)}`,
            ))
            const affiliateLink = affiliateLinkResult.url

            if (affiliateLinkResult.usedFallback) {
              logger.info?.({
                event: 'affiliate_link_fallback_used',
                executionId: execution.id,
                itemId: buildPostingBatchItemKey(item),
                source: affiliateLinkResult.source,
                fallbackReason: affiliateLinkResult.fallbackReason ?? 'unknown',
              })
            }

            logger.info?.({
              event: 'affiliate_link_generated',
              executionId: execution.id,
              itemId: buildPostingBatchItemKey(item),
              source: affiliateLinkResult.source,
              usedFallback: affiliateLinkResult.usedFallback,
            })

            const offerImageMessage = await withTimeout(
              async () => offerImageBuilder?.build?.(item, affiliateLink),
              config.offerProcessingTimeoutMs ?? 45000,
              `Bot offer rendering for ${buildPostingBatchItemKey(item)}`,
            )

            if (offerImageMessage?.imageBase64) {
              await withTimeout(
                () => whatsappClient.sendImageMessage({
                  sessionId: config.sessionId,
                  to: config.groupJid,
                  caption: offerImageMessage.caption,
                  imageBase64: offerImageMessage.imageBase64,
                }),
                config.offerProcessingTimeoutMs ?? 45000,
                `Bot image send for ${buildPostingBatchItemKey(item)}`,
              )
            } else {
              const body = formatOfferMessage(item, affiliateLink)
              const linkPreview = await withTimeout(
                async () => linkPreviewBuilder?.build?.(item, affiliateLink),
                config.offerProcessingTimeoutMs ?? 45000,
                `Bot link preview for ${buildPostingBatchItemKey(item)}`,
              )

              await withTimeout(
                () => whatsappClient.sendTextMessage({
                  sessionId: config.sessionId,
                  to: config.groupJid,
                  body,
                  linkPreview,
                }),
                config.offerProcessingTimeoutMs ?? 45000,
                `Bot text send for ${buildPostingBatchItemKey(item)}`,
              )
            }

            await repository.markOfferPublished({
              executionId: execution.id,
              itemId: buildPostingBatchItemKey(item),
              title: item.title,
              price: item.price,
              permalink: item.permalink,
              affiliateLink,
              groupJid: config.groupJid,
              postedAt: new Date(),
            })

            sentCount++
          } catch (error) {
            logger.error?.(error)
            await repository.recordOfferFailure({
              executionId: execution.id,
              itemId: buildPostingBatchItemKey(item),
              reason: error.message,
              failedAt: new Date(),
            })
          }
        }

        await repository.finishExecution(execution.id, {
          status: 'completed',
          sentCount,
          skippedDuplicates,
          finishedAt: new Date(),
        })

        return {
          executionId: execution.id,
          sentCount,
          skippedDuplicates,
          duplicatesRemoved: batch.duplicatesRemoved,
          historyBlocked: batch.historyBlocked,
        }
      } catch (error) {
        await repository.finishExecution(execution.id, {
          status: 'failed',
          sentCount,
          skippedDuplicates,
          errorMessage: error.message,
          finishedAt: new Date(),
        })

        throw error
      } finally {
        isRunning = false
      }
    },
  }
}
