function formatPrice(price, currency = 'BRL') {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency,
  }).format(price)
}

export function createOfferImageMessageBuilder({
  fetchImpl = fetch,
} = {}) {
  return {
    async build(item) {
      if (!item.thumbnailUrl) {
        return null
      }

      const response = await fetchImpl(item.thumbnailUrl)
      if (!response.ok) {
        return null
      }

      const imageBuffer = Buffer.from(await response.arrayBuffer())

      return {
        caption: [
          `Oferta: ${item.title}`,
          `Preco: ${formatPrice(item.price, item.currencyId || 'BRL')}`,
        ].join('\n'),
        imageBase64: imageBuffer.toString('base64'),
      }
    },
  }
}
