function formatPrice(price, currency = 'BRL') {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency,
  }).format(price)
}

export function formatOfferMessage(item, affiliateLink) {
  return [
    `Oferta: ${item.title}`,
    `Preco: ${formatPrice(item.price, item.currencyId || 'BRL')}`,
    '',
    affiliateLink,
  ].join('\n')
}
