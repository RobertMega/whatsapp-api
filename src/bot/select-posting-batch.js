function normalizeText(value) {
  if (typeof value !== 'string') {
    return ''
  }

  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeId(value) {
  return normalizeText(value)
}

function normalizePlatform(value) {
  return normalizeText(value)
    .replace(/[\s-]+/g, '_')
}

function normalizePermalink(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return ''
  }

  try {
    const url = new URL(value)
    url.hash = ''
    url.search = ''
    return url.toString()
  } catch {
    return value.trim()
  }
}

function shuffleItems(items, randomInt) {
  const shuffled = [...items]

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1)
    ;[shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]]
  }

  return shuffled
}

function cloneFrozenItem(item) {
  return Object.freeze({ ...item })
}

function normalizeSourceFilter(value) {
  return normalizeText(value) || '__unclassified__'
}

function selectVariedItems(items, postsPerRun, filters, randomInt) {
  const groups = new Map()

  for (const item of items) {
    const groupKey = normalizeSourceFilter(item.sourceFilter)
    const groupItems = groups.get(groupKey) ?? []
    groupItems.push(item)
    groups.set(groupKey, groupItems)
  }

  const normalizedFilterOrder = filters
    .map((filter) => normalizeSourceFilter(filter))
    .filter(Boolean)
  const orderedGroupKeys = [
    ...new Set([
      ...normalizedFilterOrder.filter((groupKey) => groups.has(groupKey)),
      ...groups.keys(),
    ]),
  ]
  const activeGroups = orderedGroupKeys.map((groupKey) => ({
    groupKey,
    items: shuffleItems(groups.get(groupKey) ?? [], randomInt),
    index: 0,
  }))

  const selectedItems = []
  const targetCount = Math.max(0, postsPerRun)

  while (selectedItems.length < targetCount) {
    let selectedInRound = false

    for (const group of activeGroups) {
      if (selectedItems.length >= targetCount) {
        break
      }

      if (group.index >= group.items.length) {
        continue
      }

      selectedItems.push(group.items[group.index])
      group.index += 1
      selectedInRound = true
    }

    if (!selectedInRound) {
      break
    }
  }

  return selectedItems
}

export function buildPostingBatchIdentityParts(item = {}) {
  const normalizedId = normalizeId(item.id)
  const normalizedPlatform = normalizePlatform(item.platform)
  const normalizedPermalink = normalizePermalink(item.permalink)
  const normalizedTitle = normalizeText(item.title)

  return {
    normalizedId: normalizedId && normalizedPlatform
      ? `${normalizedPlatform}:${normalizedId}`
      : normalizedId,
    normalizedPermalink,
    normalizedTitle,
  }
}

export function buildPostingBatchItemKey(item = {}) {
  const { normalizedId, normalizedPermalink, normalizedTitle } = buildPostingBatchIdentityParts(item)

  if (normalizedId) {
    return `id:${normalizedId}`
  }

  if (normalizedPermalink) {
    return `url:${normalizedPermalink}`
  }

  if (normalizedTitle) {
    return `title:${normalizedTitle}`
  }

  return 'unknown:'
}

function buildCollisionKeys(item) {
  const { normalizedId, normalizedPermalink, normalizedTitle } = buildPostingBatchIdentityParts(item)
  return [
    normalizedId ? `id:${normalizedId}` : null,
    normalizedPermalink ? `url:${normalizedPermalink}` : null,
    normalizedTitle ? `title:${normalizedTitle}` : null,
  ].filter(Boolean)
}

export function createPostingBatchSelector({
  randomInt = (max) => Math.floor(Math.random() * max),
} = {}) {
  return {
    async select({
      filters = [],
      items = [],
      postsPerRun = 0,
      isRecentlyPublished = async () => false,
    } = {}) {
      const normalizedFilters = filters.filter((filter) => typeof filter === 'string' && filter.trim())
      const rawItems = Array.isArray(items) ? items : []
      const seenKeys = new Set()
      const uniqueItems = []
      let duplicatesRemoved = 0
      let historyBlocked = 0

      for (const item of rawItems) {
        const collisionKeys = buildCollisionKeys(item)

        if (!collisionKeys.length || collisionKeys.some((key) => seenKeys.has(key))) {
          duplicatesRemoved += 1
          continue
        }

        collisionKeys.forEach((key) => seenKeys.add(key))

        if (await isRecentlyPublished(item)) {
          historyBlocked += 1
          continue
        }

        uniqueItems.push(item)
      }

      const selectedItems = Object.freeze(
        selectVariedItems(uniqueItems, postsPerRun, normalizedFilters, randomInt)
          .map((item) => cloneFrozenItem(item)),
      )

      return {
        termsProcessed: normalizedFilters.length,
        rawItemsFound: rawItems.length,
        duplicatesRemoved,
        historyBlocked,
        selectedItems,
      }
    },
  }
}
