import { jsx } from 'react/jsx-runtime'

function ProbePane() {
  return jsx('div', {
    className: 'flex h-full items-center px-3 text-sm text-(--ui-text-secondary)',
    children: 'SUBSCRIPTION METER PROBE'
  })
}

export default {
  id: 'subscription-meter',
  name: 'Subscription Meter',
  description: 'Runtime pane probe.',
  defaultEnabled: true,
  register(ctx) {
    ctx.register({
      id: 'subscription-meter.bottom',
      area: 'panes',
      title: 'Subscriptions',
      data: {
        placement: 'bottom',
        dock: { pane: 'workspace', pos: 'bottom' },
        height: '5rem'
      },
      render: () => jsx(ProbePane, {})
    })
  }
}
